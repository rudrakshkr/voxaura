import { and, asc, desc, eq, isNotNull, max, sql } from "drizzle-orm";

import { ApiError } from "../api";
import type {
  BatchedEvent,
  CompPackage,
  Difficulty,
  HiddenState,
  Outcome,
  PrepPack,
  ScenarioPublic,
} from "../types";

import { db } from "./client";
import {
  attempts,
  negotiationEvents,
  reports,
  scenarios,
} from "./schema";

export type ScenarioRow = typeof scenarios.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type EventRow = typeof negotiationEvents.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;

/** Strip hidden state — this is the ONLY shape of scenario that may leave the server. */
export function toPublicScenario(row: ScenarioRow): ScenarioPublic {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    role: row.role,
    level: row.level,
    difficulty: row.difficulty as Difficulty,
    prep_pack: row.prep_pack as PrepPack,
    created_at: row.created_at.toISOString(),
  };
}

export async function listScenarios(): Promise<ScenarioPublic[]> {
  const rows = await db.select().from(scenarios).orderBy(desc(scenarios.created_at));
  return rows.map(toPublicScenario);
}

/** Scenario list plus how many attempts each one has (for delete warnings). */
export async function listScenariosWithCounts(): Promise<
  Array<ScenarioPublic & { attempt_count: number }>
> {
  const rows = await db
    .select({ scenario: scenarios, count: sql<number>`count(${attempts.id})::int` })
    .from(scenarios)
    .leftJoin(attempts, eq(attempts.scenario_id, scenarios.id))
    .groupBy(scenarios.id)
    .orderBy(desc(scenarios.created_at));
  return rows.map((r) => ({ ...toPublicScenario(r.scenario), attempt_count: r.count ?? 0 }));
}

export async function getScenario(id: string): Promise<ScenarioRow> {
  const [row] = await db.select().from(scenarios).where(eq(scenarios.id, id)).limit(1);
  if (!row) throw new ApiError(404, "Scenario not found");
  return row;
}

export async function insertScenario(values: {
  title: string;
  company: string;
  role: string;
  level: string;
  difficulty: Difficulty;
  hidden: HiddenState;
  prep_pack: PrepPack;
}): Promise<ScenarioRow> {
  const [row] = await db
    .insert(scenarios)
    .values({
      title: values.title,
      company: values.company,
      role: values.role,
      level: values.level,
      difficulty: values.difficulty,
      budget: values.hidden.budget,
      reservation: values.hidden.reservation,
      target: values.hidden.target,
      opening_anchor: values.hidden.opening_anchor,
      flex: values.hidden.flex,
      persona: values.hidden.persona,
      prep_pack: values.prep_pack,
    })
    .returning();
  return row;
}

/** Update the user-editable parts of a scenario (never the hidden economics). */
export async function updateScenario(
  id: string,
  values: {
    title?: string;
    company?: string;
    role?: string;
    level?: string;
    difficulty?: Difficulty;
    prep_pack?: Partial<PrepPack>;
  },
): Promise<ScenarioRow> {
  const current = await getScenario(id);
  const [row] = await db
    .update(scenarios)
    .set({
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.company !== undefined ? { company: values.company } : {}),
      ...(values.role !== undefined ? { role: values.role } : {}),
      ...(values.level !== undefined ? { level: values.level } : {}),
      ...(values.difficulty !== undefined ? { difficulty: values.difficulty } : {}),
      ...(values.prep_pack !== undefined
        ? { prep_pack: { ...(current.prep_pack as PrepPack), ...values.prep_pack } }
        : {}),
    })
    .where(eq(scenarios.id, id))
    .returning();
  return row;
}

/** Delete a scenario; its attempts, events and reports cascade with it. */
export async function deleteScenario(id: string): Promise<number> {
  const rows = await db.delete(scenarios).where(eq(scenarios.id, id)).returning({ id: scenarios.id });
  return rows.length;
}

/** How many attempts (and therefore reports) a scenario would take with it. */
export async function countScenarioAttempts(id: string): Promise<number> {
  const rows = await db.select({ id: attempts.id }).from(attempts).where(eq(attempts.scenario_id, id));
  return rows.length;
}

export async function createAttempt(
  scenarioId: string,
  opts: { effectiveHidden: HiddenState; retryMode: string | null },
): Promise<AttemptRow> {
  const [row] = await db
    .insert(attempts)
    .values({
      scenario_id: scenarioId,
      effective_hidden: opts.effectiveHidden,
      retry_mode: opts.retryMode,
    })
    .returning();
  return row;
}

export async function getAttempt(id: string): Promise<AttemptRow> {
  const [row] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  if (!row) throw new ApiError(404, "Attempt not found");
  return row;
}

/** Attempt + its scenario, 404s if either is missing. */
export async function getAttemptWithScenario(id: string): Promise<{
  attempt: AttemptRow;
  scenario: ScenarioRow;
}> {
  const attempt = await getAttempt(id);
  const scenario = await getScenario(attempt.scenario_id);
  return { attempt, scenario };
}

export async function setAttemptAgent(
  id: string,
  agentId: string,
  mode: "stored" | "inline",
): Promise<void> {
  await db.update(attempts).set({ agent_id: agentId, agent_mode: mode }).where(eq(attempts.id, id));
}

export async function setAttemptSession(id: string, sessionId: string): Promise<void> {
  await db.update(attempts).set({ session_id: sessionId }).where(eq(attempts.id, id));
}

export async function finishAttempt(
  id: string,
  outcome: Outcome,
  finalOffer: CompPackage | null,
): Promise<void> {
  await db
    .update(attempts)
    .set({
      status: "completed",
      outcome,
      final_offer: finalOffer,
      ended_at: new Date(),
    })
    .where(eq(attempts.id, id));
}

export async function markAbandoned(id: string): Promise<void> {
  await db
    .update(attempts)
    .set({ status: "abandoned", ended_at: new Date() })
    .where(eq(attempts.id, id));
}

export async function setAttemptEngineState(
  id: string,
  engineState: Record<string, unknown>,
): Promise<void> {
  await db.update(attempts).set({ engine_state: engineState }).where(eq(attempts.id, id));
}

/** Server-authoritative acceptance: only the engine may finalize the deal. */
export async function setAttemptOutcomeIfAccepted(
  id: string,
  finalOffer: CompPackage,
  conditions: string[],
): Promise<void> {
  await db
    .update(attempts)
    .set({
      outcome: "accepted",
      final_offer: finalOffer,
      final_conditions: conditions,
      status: "completed",
      ended_at: new Date(),
    })
    .where(eq(attempts.id, id));
}

/** Next monotonic seq for an attempt's events. */
export async function nextEventSeq(attemptId: string): Promise<number> {
  const [row] = await db
    .select({ m: max(negotiationEvents.seq) })
    .from(negotiationEvents)
    .where(eq(negotiationEvents.attempt_id, attemptId));
  return (row?.m ?? 0) + 1;
}

export async function insertEvents(
  attemptId: string,
  events: BatchedEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  let seq = await nextEventSeq(attemptId);
  const rows = events.map((e) => ({
    attempt_id: attemptId,
    seq: seq++,
    type: e.type,
    actor: e.actor,
    source: e.source,
    payload: e.payload as Record<string, unknown>,
    at_ms: e.at_ms ?? null,
  }));
  try {
    await db.insert(negotiationEvents).values(rows);
  } catch (err) {
    // Unique violation on (attempt_id, seq): concurrent flushes raced. Retry once.
    if (err instanceof Error && err.message.includes("duplicate key")) {
      const retrySeq = await nextEventSeq(attemptId);
      await db
        .insert(negotiationEvents)
        .values(
          rows.map((r, i) => ({ ...r, seq: retrySeq + i })),
        );
    } else {
      throw err;
    }
  }
  return rows.length;
}

export async function listEvents(attemptId: string): Promise<EventRow[]> {
  return db
    .select()
    .from(negotiationEvents)
    .where(eq(negotiationEvents.attempt_id, attemptId))
    .orderBy(asc(negotiationEvents.seq));
}

export async function listAttemptsForScenario(
  scenarioId: string,
): Promise<AttemptRow[]> {
  return db
    .select()
    .from(attempts)
    .where(and(eq(attempts.scenario_id, scenarioId), isNotNull(attempts.ended_at)))
    .orderBy(desc(attempts.started_at));
}

export async function getReport(attemptId: string): Promise<ReportRow> {
  const [row] = await db.select().from(reports).where(eq(reports.attempt_id, attemptId)).limit(1);
  if (!row) throw new ApiError(404, "Report not found — complete the attempt first");
  return row;
}

export async function saveReport(
  attemptId: string,
  report: {
    overall_score: number;
    rubric: unknown;
    strengths: string[];
    improvements: string[];
    summary: string;
    communication?: unknown;
    transcript: unknown;
  },
): Promise<void> {
  // Upsert: re-completing an attempt (retry scoring, engine re-finalize)
  // must replace the row, not trip the unique constraint.
  await db
    .insert(reports)
    .values({
      attempt_id: attemptId,
      overall_score: report.overall_score,
      rubric: report.rubric as never,
      strengths: report.strengths,
      improvements: report.improvements,
      summary: report.summary,
      communication: (report.communication ?? null) as never,
      transcript: report.transcript as never,
    })
    .onConflictDoUpdate({
      target: reports.attempt_id,
      set: {
        overall_score: report.overall_score,
        rubric: report.rubric as never,
        strengths: report.strengths,
        improvements: report.improvements,
        summary: report.summary,
        communication: (report.communication ?? null) as never,
        transcript: report.transcript as never,
      },
    });
}

export async function listHistory(): Promise<
  Array<{
    attempt: AttemptRow;
    scenarioTitle: string;
    score: number | null;
    /** Overall score of the user's PREVIOUS attempt on the same scenario. */
    previousScore: number | null;
  }>
> {
  const rows = await db
    .select({ attempt: attempts, scenario: scenarios, report: reports })
    .from(attempts)
    .innerJoin(scenarios, eq(attempts.scenario_id, scenarios.id))
    .leftJoin(reports, eq(reports.attempt_id, attempts.id))
    .orderBy(desc(attempts.started_at))
    .limit(100);

  // Previous attempt = the user's most recent earlier SCORED attempt on the
  // same scenario (this is what "72 → 84" compares against). Rows arrive
  // newest-first, so the last score seen per scenario is the previous one.
  const lastScoreByScenario = new Map<string, number>();
  const enriched = rows.map((r) => {
    const sid = r.attempt.scenario_id;
    const previousScore = lastScoreByScenario.get(sid) ?? null;
    if (r.report?.overall_score != null) {
      lastScoreByScenario.set(sid, r.report.overall_score);
    }
    return { ...r, previousScore };
  });
  return enriched.map((r) => ({
    attempt: r.attempt,
    scenarioTitle: r.scenario.title,
    score: r.report?.overall_score ?? null,
    previousScore: r.previousScore,
  }));
}
