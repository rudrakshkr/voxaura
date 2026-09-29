import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  CompPackage,
  HiddenState,
  PrepPack,
  ReportData,
  ScenarioSnapshot,
} from "../types";

export const difficultyEnum = pgEnum("difficulty", ["easy", "medium", "hard"]);
export const attemptStatusEnum = pgEnum("attempt_status", [
  "active",
  "completed",
  "finalizing",
  "abandoned",
]);
export const outcomeEnum = pgEnum("outcome", ["accepted", "rejected", "stalemate", "walked_away"]);
export const eventActorEnum = pgEnum("event_actor", ["user", "opponent"]);
export const eventSourceEnum = pgEnum("event_source", ["tool", "llm_extract"]);
export const eventImpactEnum = pgEnum("event_impact", ["strong", "neutral", "risky"]);

export const MoveTypeEnum = [
  "user_offer",
  "opponent_offer",
  "concession",
  "target_covered",
  "pressure_tactic",
  "objection_raised",
  "rapport",
  "commitment_signal",
  "interruption",
  "user_anchor",
  "opponent_anchor",
  "counteroffer",
  "leverage_introduced",
  "leverage_challenged",
  "information_request",
  "information_revealed",
  "package_trade",
  "missed_opportunity",
  "acceptance",
  "rejection",
  "walk_away",
  "voice_engine_inconsistency",
] as const;

/**
 * Event types a CLIENT may report through `/events`.
 *
 * Everything about the opponent (offers, acceptances, concessions, engine
 * inconsistencies) is server-generated: without this split a browser could POST
 * `{type:"acceptance", actor:"opponent"}` and manufacture an agreed deal, or
 * fabricate an opponent offer that the panel then displays as fact. What a
 * client legitimately knows is what the CANDIDATE did, so that is all it may
 * report — and the actor is forced to "user" server-side.
 */
export const CLIENT_REPORTABLE_EVENTS = [
  "user_offer",
  "user_anchor",
  "counteroffer",
  "concession",
  "target_covered",
  "pressure_tactic",
  "objection_raised",
  "rapport",
  "commitment_signal",
  "interruption",
  "leverage_introduced",
  "leverage_challenged",
  "information_request",
  "information_revealed",
  "package_trade",
  "missed_opportunity",
  "rejection",
  "walk_away",
] as const;

/**
 * Event types a SCORER may recover from the transcript and persist.
 *
 * Exactly the same rule as the client, for exactly the same reason: a transcript
 * can evidence what the CANDIDATE did, and nothing else. The opponent's offers
 * and the settlement — `opponent_offer`, `acceptance`, `walk_away`,
 * `voice_engine_inconsistency` — are server facts written by the routes that own
 * that economics. A scorer is an LLM call: without this list, a confused or
 * hostile response could write an `acceptance` into the durable event log and an
 * agreed deal would exist that the engine never made.
 *
 * `walk_away` is excluded on top of that. It is the candidate's own move, but it
 * also DECIDES the attempt's outcome, and the client reports it the moment it
 * happens — so letting a model inject one could only ever turn a transcript into
 * a walk-away the engine never saw.
 */
export const LLM_EXTRACTABLE_EVENTS = CLIENT_REPORTABLE_EVENTS.filter(
  (t) => t !== "walk_away",
) as readonly (typeof CLIENT_REPORTABLE_EVENTS)[number][];

export const scenarios = pgTable("scenarios", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  role: text("role").notNull(),
  level: text("level").notNull(),
  difficulty: difficultyEnum("difficulty").notNull().default("medium"),
  // Hidden state — server-side only, never returned by public APIs.
  budget: integer("budget").notNull(),
  reservation: integer("reservation").notNull(),
  target: integer("target").notNull(),
  opening_anchor: integer("opening_anchor").notNull(),
  flex: jsonb("flex").$type<HiddenState["flex"]>().notNull(),
  persona: jsonb("persona").$type<HiddenState["persona"]>().notNull(),
  hiring_urgency: integer("hiring_urgency").notNull().default(3),
  // User-visible prep material.
  prep_pack: jsonb("prep_pack").$type<PrepPack>().notNull(),
  /**
   * Stable identity for the built-in demo seeds. The seed script upserts on
   * this key, so re-running `npm run seed` never duplicates or half-fills the
   * library (the old `if (existing.length >= 3) return` guard did both).
   */
  seed_key: text("seed_key"),
  /**
   * Creator of this scenario (anonymous owner cookie), or `DEMO_OWNER_ID` for
   * the sample library. NOT NULL on purpose: a NULL here meant "public by
   * accident", which let any anonymous visitor who could list the library
   * DELETE a scenario and cascade every attempt and report made against it.
   * Sample data is now public by explicit, read-only design instead.
   */
  owner_id: text("owner_id").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("scenarios_seed_key_unique").on(t.seed_key),
  index("scenarios_owner_idx").on(t.owner_id),
]);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scenario_id: uuid("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    /**
     * Anonymous owner (opaque httpOnly cookie), or `DEMO_OWNER_ID` for a sample
     * attempt. Attempt UUIDs are not auth: every attempt-scoped route checks
     * this. NOT NULL so "no owner" can never be written again — the leftover
     * NULLs that predated ownership were migrated to the sample-library sentinel
     * (see drizzle/0002_ownership.sql).
     */
    owner_id: text("owner_id").notNull(),
    session_id: text("session_id"),
    agent_id: text("agent_id"),
    agent_mode: text("agent_mode").notNull().default("stored"),
    /** Hidden state actually used for this attempt (may be a retry variant). */
    effective_hidden: jsonb("effective_hidden").$type<HiddenState | null>(),
    /** Null for a first run; "harder" or "reroll" for retries. */
    retry_mode: text("retry_mode"),
    /** Server-authoritative negotiation engine state (current offer, granted, counters). */
    engine_state: jsonb("engine_state").$type<Record<string, unknown>>(),
    /**
     * `finalizing` is the completion barrier: set the moment `/complete` claims
     * an attempt and cleared only when its report is written. While it is set no
     * turn, offer or event may touch the attempt, so the report is scored from a
     * state snapshot that nothing can change underneath it.
     */
    status: attemptStatusEnum("status").notNull().default("active"),
    outcome: outcomeEnum("outcome"),
    final_offer: jsonb("final_offer").$type<CompPackage>(),
    final_conditions: jsonb("final_conditions").$type<string[]>().notNull().default([]),
    /**
     * When the barrier was taken. A function that dies mid-scoring would
     * otherwise leave the attempt unfinishable, so a barrier older than
     * `FINALIZE_STALE_MS` may be reclaimed.
     */
    finalizing_at: timestamp("finalizing_at", { withTimezone: true }),
    /**
     * Proof of who currently owns the completion barrier.
     *
     * `finalizing_at` alone says WHEN the barrier was taken, not WHO took it, so
     * a reclaimed (stale) finalizer could still come back and call
     * `abandonFinalization()` or `commitFinalization()` and act on a barrier that
     * now belongs to another request. A fresh token is minted on every claim and
     * reclaim; only the holder may release or write. Cleared when the report is
     * written.
     */
    finalization_token: text("finalization_token"),
    /**
     * Candidate-facing scenario material, frozen at attempt creation.
     *
     * Scoring, the report, the session greeting and the counterfactuals used to
     * read the LIVE scenario row, so editing a scenario silently rewrote the
     * context and coaching objective of every attempt already made against it.
     * The snapshot is what the call was actually run with; `effective_hidden`
     * remains the authoritative hidden economics.
     */
    scenario_snapshot: jsonb("scenario_snapshot").$type<ScenarioSnapshot | null>(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("attempts_scenario_idx").on(t.scenario_id),
    index("attempts_owner_idx").on(t.owner_id),
    uniqueIndex("attempts_session_unique").on(t.session_id),
  ],
);

/**
 * Idempotency receipts for `/turn`. A voice client retries on timeout, so the
 * same utterance can arrive twice; the second request replays the stored
 * response instead of negotiating the same sentence against a mutated state.
 */
/**
 * Short-lived, single-use server authorization for a recruiter action.
 *
 * `/turn` is the only authoritative source of recruiter decisions: when its
 * engine picks a move whose directive tells the voice model to call
 * `offer_to_candidate` or `accept_user_offer`, it also writes a row here. The
 * browser cannot mint one of these — it can only present the token it received.
 * `/offer` treats a package as authoritative ONLY when it matches an unused,
 * unexpired token bound to this attempt and this exact action/package, so a
 * forged request cannot manufacture a recruiter offer or an acceptance.
 */
export const attemptAuthorizations = pgTable(
  "attempt_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    turn_id: text("turn_id"),
    /** `offer` | `accept` — never inferred from the request. */
    action: text("action").notNull(),
    package: jsonb("package").$type<CompPackage>().notNull(),
    conditions: jsonb("conditions").$type<string[]>().notNull().default([]),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("attempt_authorization_token_unique").on(t.token),
    index("attempt_authorization_attempt_idx").on(t.attempt_id),
  ],
);

export const attemptTurns = pgTable(
  "attempt_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    turn_id: text("turn_id").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attempt_turn_unique").on(t.attempt_id, t.turn_id)],
);

export const negotiationEvents = pgTable(
  "negotiation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    actor: eventActorEnum("actor").notNull(),
    source: eventSourceEnum("source").notNull(),
    impact: eventImpactEnum("impact").notNull().default("neutral"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    at_ms: integer("at_ms"),
    /**
     * True when a SERVER rule produced this event (the `/turn` classifier, the
     * engine's acceptance, a locked `/offer` mutation).
     *
     * False for anything the browser or the scorer suggested. A candidate
     * utterance produces exactly one authoritative event — the one `/turn`
     * classified — so a client `log_user_move` annotation (or a scorer-recovered
     * duplicate) can be kept for the live UI and replay without becoming
     * independent scoring evidence. The scorer is fed authoritative events only.
     */
    authoritative: boolean("authoritative").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attempt_seq_unique").on(t.attempt_id, t.seq)],
);

export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  attempt_id: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id, { onDelete: "cascade" })
    .unique(),
  overall_score: integer("overall_score").notNull(),
  rubric: jsonb("rubric").$type<ReportData["rubric"]>().notNull(),
  strengths: jsonb("strengths").$type<string[]>().notNull(),
  improvements: jsonb("improvements").$type<string[]>().notNull(),
  summary: text("summary").notNull(),
  communication: jsonb("communication").$type<ReportData["communication"]>(),
  transcript: jsonb("transcript").$type<ReportData["transcript"]>().notNull().default([]),
  /**
   * Where the scored transcript came from: `server` (the voice service's own
   * timeline — the authoritative record), `client` (the browser's buffer, used
   * only when no server timeline exists and labeled as unverified), or
   * `server+client` (server timeline corroborated by client-only turns).
   */
  transcript_source: text("transcript_source"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scenarioRelations = relations(scenarios, ({ many }) => ({
  attempts: many(attempts),
}));

export const attemptRelations = relations(attempts, ({ one, many }) => ({
  scenario: one(scenarios, { fields: [attempts.scenario_id], references: [scenarios.id] }),
  events: many(negotiationEvents),
  report: one(reports),
  turns: many(attemptTurns),
  authorizations: many(attemptAuthorizations),
}));