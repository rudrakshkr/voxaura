import { relations } from "drizzle-orm";
import {
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
} from "../types";

export const difficultyEnum = pgEnum("difficulty", ["easy", "medium", "hard"]);
export const attemptStatusEnum = pgEnum("attempt_status", ["active", "completed", "abandoned"]);
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
] as const;

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
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scenario_id: uuid("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    session_id: text("session_id"),
    agent_id: text("agent_id"),
    agent_mode: text("agent_mode").notNull().default("stored"),
    /** Hidden state actually used for this attempt (may be a retry variant). */
    effective_hidden: jsonb("effective_hidden").$type<HiddenState | null>(),
    /** Null for a first run; "harder" or "reroll" for retries. */
    retry_mode: text("retry_mode"),
    /** Server-authoritative negotiation engine state (current offer, granted, counters). */
    engine_state: jsonb("engine_state").$type<Record<string, unknown>>(),
    status: attemptStatusEnum("status").notNull().default("active"),
    outcome: outcomeEnum("outcome"),
    final_offer: jsonb("final_offer").$type<CompPackage>(),
    final_conditions: jsonb("final_conditions").$type<string[]>().notNull().default([]),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("attempts_scenario_idx").on(t.scenario_id)],
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
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scenarioRelations = relations(scenarios, ({ many }) => ({
  attempts: many(attempts),
}));

export const attemptRelations = relations(attempts, ({ one, many }) => ({
  scenario: one(scenarios, { fields: [attempts.scenario_id], references: [scenarios.id] }),
  events: many(negotiationEvents),
  report: one(reports),
}));
