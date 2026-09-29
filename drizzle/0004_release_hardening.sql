-- 0004 — release hardening: authorization, evidence provenance, snapshots.
--
-- Four additive changes, each closing a trust-boundary hole:
--
--  1. `attempt_authorizations` — `/turn` is the only authoritative source of
--     recruiter decisions, so it mints a single-use token bound to the attempt,
--     the turn, the action and the EXACT package. `/offer` will only let a
--     package or an acceptance change the authoritative state when it can redeem
--     one of these, so a browser can no longer manufacture a recruiter offer or
--     complete an attempt with an invented deal.
--
--  2. `attempts.finalization_token` — `finalizing_at` said WHEN the completion
--     barrier was taken, not WHO took it. A stale finalizer could come back after
--     its barrier was reclaimed and still release or overwrite it. The token is
--     minted on every claim and required to commit or abandon.
--
--  3. `attempts.scenario_snapshot` — candidate-facing scenario material frozen at
--     attempt creation, so editing a scenario cannot retroactively change the
--     context, coaching objective or prep targets an already-recorded attempt was
--     scored with.
--
--  4. `negotiation_events.authoritative` — true only when a SERVER rule produced
--     the event. `/turn` classifies candidate moves canonically, so a client
--     `log_user_move` annotation (or the scorer's own recovery) is stored for the
--     UI and the replay but is never independent scoring evidence. Fabricated
--     annotations therefore cannot move a score.
--
-- Plus `reports.transcript_source`, which records whether the scored transcript
-- came from the voice service's own timeline (`server`), from the browser alone
-- (`client` — unverified, only used when no timeline exists) or from a
-- corroborated merge of both.
--
-- Every statement is idempotent, so this file is safe to re-run.
CREATE TABLE IF NOT EXISTS "attempt_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"token" text NOT NULL,
	"turn_id" text,
	"action" text NOT NULL,
	"package" jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'attempt_authorizations_attempt_id_attempts_id_fk'
	) THEN
		ALTER TABLE "attempt_authorizations"
			ADD CONSTRAINT "attempt_authorizations_attempt_id_attempts_id_fk"
			FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attempt_authorization_token_unique"
	ON "attempt_authorizations" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attempt_authorization_attempt_idx"
	ON "attempt_authorizations" USING btree ("attempt_id");
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN IF NOT EXISTS "finalization_token" text;
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN IF NOT EXISTS "scenario_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "negotiation_events" ADD COLUMN IF NOT EXISTS "authoritative" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "transcript_source" text;
--> statement-breakpoint
-- Backfill 1: historical events written by the server. `/turn` stamps every
-- candidate event with its `turn_id`, and every opponent event is server-owned
-- economics, so those are the authoritative rows. Client annotations and
-- scorer-recovered moves stay false — the conservative direction.
UPDATE "negotiation_events"
SET "authoritative" = true
WHERE "authoritative" = false
	AND ("actor" = 'opponent' OR "payload" ? 'turn_id');
--> statement-breakpoint
-- Backfill 2: freeze the candidate-facing material of existing attempts as of
-- this migration. It cannot reconstruct what a scenario looked like at the time
-- of an older call, but from here on those attempts stop changing underneath
-- their reports.
UPDATE "attempts" a
SET "scenario_snapshot" = jsonb_build_object(
	'title', s."title",
	'company', s."company",
	'role', s."role",
	'level', s."level",
	'difficulty', s."difficulty",
	'prep_pack', s."prep_pack"
)
FROM "scenarios" s
WHERE s."id" = a."scenario_id"
	AND a."scenario_snapshot" IS NULL;
