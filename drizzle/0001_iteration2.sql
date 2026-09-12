CREATE TYPE "public"."event_impact" AS ENUM('strong', 'neutral', 'risky');--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "engine_state" jsonb;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "final_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "negotiation_events" ADD COLUMN "impact" "event_impact" DEFAULT 'neutral' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "communication" jsonb;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "hiring_urgency" integer DEFAULT 3 NOT NULL;