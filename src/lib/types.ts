import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums / primitives
// ---------------------------------------------------------------------------

export const Difficulty = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Outcome = z.enum(["accepted", "rejected", "stalemate", "walked_away"]);
export type Outcome = z.infer<typeof Outcome>;

export const AttemptStatus = z.enum(["active", "completed", "abandoned"]);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

/** Move taxonomy — the vocabulary of negotiation events (plan §4, §7). */
export const MoveType = z.enum([
  "user_offer",
  "opponent_offer",
  "concession",
  "target_covered",
  "pressure_tactic",
  "objection_raised",
  "rapport",
  "commitment_signal",
  "interruption",
]);
export type MoveType = z.infer<typeof MoveType>;

export const EventActor = z.enum(["user", "opponent"]);
export type EventActor = z.infer<typeof EventActor>;

export const EventSource = z.enum(["tool", "llm_extract"]);
export type EventSource = z.infer<typeof EventSource>;

// ---------------------------------------------------------------------------
// Money / compensation payloads
// ---------------------------------------------------------------------------

/** A compensation package offer, in plain integers (yearly USD). */
export const CompPackage = z.object({
  base: z.number().int().min(0),
  sign_on: z.number().int().min(0).nullish(),
  equity: z.number().min(0).nullish(), // annualized $ value of equity
});
export type CompPackage = z.infer<typeof CompPackage>;

export function packageTotal(p: CompPackage | null | undefined): number {
  if (!p) return 0;
  return p.base + (p.sign_on ?? 0) + (p.equity ?? 0);
}

// ---------------------------------------------------------------------------
// Hidden state (server-side only — never serialized to the client)
// ---------------------------------------------------------------------------

export const HiddenState = z.object({
  /** Absolute ceiling the company can pay for base. */
  budget: z.number().int(),
  /** Below this the opponent walks; candidate must never need to go here. */
  reservation: z.number().int(),
  /** Where the opponent wants to land. */
  target: z.number().int(),
  /** The opening number the opponent names. */
  opening_anchor: z.number().int(),
  /** Secondary levers and their flex ranges. */
  flex: z.object({
    sign_on_max: z.number().int().nullish(),
    equity_max: z.number().nullish(),
    remote_days: z.number().int().nullish(),
    start_date_weeks: z.number().int().nullish(),
    extra_pto_days: z.number().int().nullish(),
  }),
  persona: z.object({
    name: z.string(),
    title: z.string(),
    /** One of: warm, brisk, poker-face, combative, avuncular */
    style: z.string(),
    /** 1 (pushover) … 5 (stone wall) */
    aggression: z.number().int().min(1).max(5),
    priorities: z.array(z.string()),
    quirks: z.array(z.string()),
  }),
});
export type HiddenState = z.infer<typeof HiddenState>;

// ---------------------------------------------------------------------------
// Visible prep pack (safe to ship to the browser)
// ---------------------------------------------------------------------------

export const PrepPack = z.object({
  title: z.string(),
  context: z.string(),
  role: z.string(),
  company: z.string(),
  /** Comp components the candidate is told exist (names + rough ranges). */
  comp_notes: z.array(z.string()),
  coaching_objective: z.string(),
});
export type PrepPack = z.infer<typeof PrepPack>;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export const ScenarioPublic = z.object({
  id: z.string().uuid(),
  title: z.string(),
  company: z.string(),
  role: z.string(),
  level: z.string(),
  difficulty: Difficulty,
  prep_pack: PrepPack,
  created_at: z.string().datetime(),
});
export type ScenarioPublic = z.infer<typeof ScenarioPublic>;

// ---------------------------------------------------------------------------
// Negotiation events (live + extracted)
// ---------------------------------------------------------------------------

export const NegotiationEvent = z.object({
  type: MoveType,
  actor: EventActor,
  source: EventSource,
  /** e.g. { amount?: number, package?: CompPackage, note?: string, tactic?: string } */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Millisecond offset into the session when it happened. */
  at_ms: z.number().int().min(0).nullish(),
  seq: z.number().int().nullish(),
});
export type NegotiationEvent = z.infer<typeof NegotiationEvent>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const RubricDimension = z.object({
  dimension: z.string(),
  score: z.number().min(0).max(10),
  weight: z.number().min(0).max(1),
  feedback: z.string(),
});
export type RubricDimension = z.infer<typeof RubricDimension>;

export const ReportData = z.object({
  overall_score: z.number().min(0).max(100),
  rubric: z.array(RubricDimension),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  summary: z.string(),
  outcome: Outcome.nullish(),
  final_offer: CompPackage.nullish(),
  events: z.array(NegotiationEvent).default([]),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        text: z.string(),
        interrupted: z.boolean().default(false),
        at_ms: z.number().int().nullish(),
      }),
    )
    .default([]),
});
export type ReportData = z.infer<typeof ReportData>;

// ---------------------------------------------------------------------------
// Transcript turn (what the client accumulates live)
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  role: "user" | "agent";
  text: string;
  interrupted: boolean;
  atMs: number | null;
}

// ---------------------------------------------------------------------------
// Client → server event batching contract (POST /api/attempts/:id/events)
// ---------------------------------------------------------------------------

export const BatchedEvent = z.object({
  type: MoveType,
  actor: EventActor,
  source: EventSource,
  payload: z.record(z.string(), z.unknown()).default({}),
  at_ms: z.number().int().min(0).nullish(),
});
export type BatchedEvent = z.infer<typeof BatchedEvent>;
