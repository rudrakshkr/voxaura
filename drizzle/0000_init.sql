CREATE TYPE "public"."attempt_status" AS ENUM('active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."event_actor" AS ENUM('user', 'opponent');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('tool', 'llm_extract');--> statement-breakpoint
CREATE TYPE "public"."outcome" AS ENUM('accepted', 'rejected', 'stalemate', 'walked_away');--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"session_id" text,
	"agent_id" text,
	"agent_mode" text DEFAULT 'stored' NOT NULL,
	"effective_hidden" jsonb,
	"retry_mode" text,
	"status" "attempt_status" DEFAULT 'active' NOT NULL,
	"outcome" "outcome",
	"final_offer" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "negotiation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"actor" "event_actor" NOT NULL,
	"source" "event_source" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"overall_score" integer NOT NULL,
	"rubric" jsonb NOT NULL,
	"strengths" jsonb NOT NULL,
	"improvements" jsonb NOT NULL,
	"summary" text NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_attempt_id_unique" UNIQUE("attempt_id")
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"level" text NOT NULL,
	"difficulty" "difficulty" DEFAULT 'medium' NOT NULL,
	"budget" integer NOT NULL,
	"reservation" integer NOT NULL,
	"target" integer NOT NULL,
	"opening_anchor" integer NOT NULL,
	"flex" jsonb NOT NULL,
	"persona" jsonb NOT NULL,
	"prep_pack" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiation_events" ADD CONSTRAINT "negotiation_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_scenario_idx" ON "attempts" USING btree ("scenario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_seq_unique" ON "negotiation_events" USING btree ("attempt_id","seq");