-- 0002 — ownership is required, and the sample library gets a name.
--
-- Two things happen here:
--
--  1. `owner_id` becomes NOT NULL on `attempts` and `scenarios`. A NULL used to
--     mean "public by accident": an unowned attempt was readable by every
--     visitor who asked for it, and an unowned scenario could be DELETEd by any
--     anonymous caller, cascading its attempts, events and reports with it.
--
--  2. Rows that predate ownership — and the built-in seeds — are moved to the
--     `demo:sample-library` sentinel, so they are explicitly public, READ-ONLY
--     sample data instead of ambiguously unowned rows. The sentinel can never
--     collide with a real owner id (those are 48 hex characters; this contains
--     a `:`), so no browser can present it as its own identity.
--
-- The ownership columns and `attempt_turns` were introduced slightly ahead of
-- this file while the feature was being built (applied with `db:push`), so the
-- adds are IF NOT EXISTS and the whole migration is safe to re-run against a
-- database that already has them.
CREATE TABLE IF NOT EXISTS "attempt_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN IF NOT EXISTS "owner_id" text;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "seed_key" text;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "owner_id" text;--> statement-breakpoint
-- Backfill BEFORE the NOT NULL is applied: the constraint must never fail, and
-- "unowned" must never silently become the default for existing history.
UPDATE "attempts" SET "owner_id" = 'demo:sample-library' WHERE "owner_id" IS NULL;--> statement-breakpoint
UPDATE "scenarios" SET "owner_id" = 'demo:sample-library' WHERE "owner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "attempts" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attempt_turns_attempt_id_attempts_id_fk'
  ) THEN
    ALTER TABLE "attempt_turns" ADD CONSTRAINT "attempt_turns_attempt_id_attempts_id_fk"
      FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attempt_turn_unique" ON "attempt_turns" USING btree ("attempt_id","turn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attempts_owner_idx" ON "attempts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scenarios_seed_key_unique" ON "scenarios" USING btree ("seed_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scenarios_owner_idx" ON "scenarios" USING btree ("owner_id");
