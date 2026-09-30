import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { ApiError } from "../api";
import { DEMO_OWNER_ID, isDemoOwner } from "../ownership";
import type {
  BatchedEvent,
  CompPackage,
  Difficulty,
  HiddenState,
  Outcome,
  PrepPack,
  ScenarioPublic,
  ScenarioSnapshot,
} from "../types";
import { clampEventAtMs, eventSignature } from "../types";

import { db } from "./client";
import {
  attemptAuthorizations,
  attempts,
  attemptTurns,
  negotiationEvents,
  reports,
  scenarios,
} from "./schema";

export type ScenarioRow = typeof scenarios.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type EventRow = typeof negotiationEvents.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type AuthorizationRow = typeof attemptAuthorizations.$inferSelect;

/**
 * The transaction handle Drizzle hands to `db.transaction`. Everything that
 * mutates one attempt's state runs on this type so the whole mutation shares a
 * single connection — and therefore a single advisory lock and one commit.
 */
export type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Strip hidden state — this is the ONLY shape of scenario that may leave the
 * server.
 *
 * `is_demo` is part of the public shape so the library UI can label the sample
 * scenarios and stop offering edit/delete on them, instead of letting a visitor
 * discover the read-only rule by hitting an error. It reveals nothing that the
 * library does not already show.
 */
export function toPublicScenario(row: ScenarioRow): ScenarioPublic {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    role: row.role,
    level: row.level,
    difficulty: row.difficulty as Difficulty,
    prep_pack: row.prep_pack as PrepPack,
    is_demo: isDemoOwner(row.owner_id),
    created_at: row.created_at.toISOString(),
  };
}

/**
 * What a caller may see in the library: the public sample scenarios, plus the
 * ones they created themselves.
 *
 * This used to be an unscoped `select * from scenarios`, so any visitor — cookie
 * or not — was handed every other user's custom scenario: its title, company and
 * the whole `prep_pack` (their objective, their target, their walk-away number).
 * A scenario's hidden economics were never in the payload, but the candidate-side
 * prep material belongs to its creator all the same.
 *
 * `ownerId` is nullable because "no cookie yet" must mean "samples only", not
 * "everything".
 */
function scenarioVisibilityFilter(ownerId: string | null) {
  return ownerId
    ? or(eq(scenarios.owner_id, DEMO_OWNER_ID), eq(scenarios.owner_id, ownerId))
    : eq(scenarios.owner_id, DEMO_OWNER_ID);
}

export async function listScenarios(ownerId: string | null = null): Promise<ScenarioPublic[]> {
  const rows = await db
    .select()
    .from(scenarios)
    .where(scenarioVisibilityFilter(ownerId))
    .orderBy(desc(scenarios.created_at));
  return rows.map(toPublicScenario);
}

/**
 * Scenario list plus how many attempts the CALLER has made on each one (for
 * delete warnings).
 *
 * The count is deliberately scoped to the caller: the raw "attempts per
 * scenario" figure is cross-owner metadata (it tells one visitor how much
 * activity another visitor's scenario has seen).
 */
export async function listScenariosWithCounts(
  ownerId: string | null = null,
): Promise<Array<ScenarioPublic & { attempt_count: number }>> {
  const rows = await db
    .select({ scenario: scenarios, count: sql<number>`count(${attempts.id})::int` })
    .from(scenarios)
    .leftJoin(
      attempts,
      and(
        eq(attempts.scenario_id, scenarios.id),
        ownerId ? eq(attempts.owner_id, ownerId) : sql`false`,
      ),
    )
    .where(scenarioVisibilityFilter(ownerId))
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
  seedKey?: string | null;
  /**
   * Anonymous owner cookie, so mutation can be limited to the creator, or
   * `DEMO_OWNER_ID` for the built-in sample library. Required (the column is NOT
   * NULL) so no code path can create an unowned row again.
   */
  ownerId: string;
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
      seed_key: values.seedKey ?? null,
      owner_id: values.ownerId,
    })
    .returning();
  return row;
}

/**
 * Idempotent seed write. The built-in demo scenarios carry a stable `seed_key`,
 * so re-running the seed script refreshes the candidate-facing material instead
 * of either duplicating scenarios or refusing to fill a half-seeded database.
 *
 * Hidden economics are deliberately NOT overwritten: a scenario someone has
 * already practised against keeps the problem it was generated with.
 *
 * A seed is part of the sample library, so it is owned by `DEMO_OWNER_ID`:
 * public to read, read-only to everyone.
 */
export async function upsertSeededScenario(
  seedKey: string,
  values: {
    title: string;
    company: string;
    role: string;
    level: string;
    difficulty: Difficulty;
    hidden: HiddenState;
    prep_pack: PrepPack;
  },
): Promise<{ row: ScenarioRow; created: boolean }> {
  const [existing] = await db
    .select()
    .from(scenarios)
    .where(eq(scenarios.seed_key, seedKey))
    .limit(1);
  if (!existing) {
    const row = await insertScenario({ ...values, seedKey, ownerId: DEMO_OWNER_ID });
    return { row, created: true };
  }
  const [row] = await db
    .update(scenarios)
    .set({
      title: values.title,
      company: values.company,
      role: values.role,
      level: values.level,
      difficulty: values.difficulty,
      prep_pack: values.prep_pack,
    })
    .where(eq(scenarios.id, existing.id))
    .returning();
  return { row: row ?? existing, created: false };
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
  const patch: Record<string, unknown> = {};
  if (values.title !== undefined) patch.title = values.title;
  if (values.company !== undefined) patch.company = values.company;
  if (values.role !== undefined) patch.role = values.role;
  if (values.level !== undefined) patch.level = values.level;
  if (values.difficulty !== undefined) patch.difficulty = values.difficulty;
  if (values.prep_pack !== undefined) {
    patch.prep_pack = { ...(current.prep_pack as PrepPack), ...values.prep_pack };
  }
  // An edit that names no field is a no-op, not an invalid UPDATE (an empty SET
  // list is a query error).
  if (Object.keys(patch).length === 0) return current;
  const [row] = await db.update(scenarios).set(patch).where(eq(scenarios.id, id)).returning();
  return row ?? current;
}

/** Delete a scenario; its attempts, events and reports cascade with it. */
export async function deleteScenario(id: string): Promise<number> {
  const rows = await db.delete(scenarios).where(eq(scenarios.id, id)).returning({ id: scenarios.id });
  return rows.length;
}

/**
 * How many attempts the CALLER has on this scenario (and therefore how many of
 * their reports a delete would take with it). Scoped like the library count:
 * another owner's activity is not the caller's metadata.
 */
export async function countScenarioAttempts(
  id: string,
  ownerId: string | null = null,
): Promise<number> {
  const rows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      ownerId
        ? and(eq(attempts.scenario_id, id), eq(attempts.owner_id, ownerId))
        : and(eq(attempts.scenario_id, id), eq(attempts.owner_id, DEMO_OWNER_ID)),
    );
  return rows.length;
}

export async function createAttempt(
  scenarioId: string,
  /** `ownerId` is required: the column is NOT NULL, so a caller cannot forget. */
  opts: {
    effectiveHidden: HiddenState;
    retryMode: string | null;
    ownerId: string;
    /**
     * Candidate-facing material frozen at creation. Stored so scoring, the
     * report, the greeting and the counterfactuals all describe the scenario as
     * it was when the call was recorded, not as it is now.
     */
    snapshot?: ScenarioSnapshot | null;
  },
): Promise<AttemptRow> {
  const [row] = await db
    .insert(attempts)
    .values({
      scenario_id: scenarioId,
      effective_hidden: opts.effectiveHidden,
      retry_mode: opts.retryMode,
      owner_id: opts.ownerId,
      scenario_snapshot: opts.snapshot ?? null,
    })
    .returning();
  return row;
}

/** Build the candidate-facing snapshot stored on an attempt. */
export function scenarioSnapshotOf(row: ScenarioRow): ScenarioSnapshot {
  return {
    title: row.title,
    company: row.company,
    role: row.role,
    level: row.level,
    difficulty: row.difficulty as Difficulty,
    prep_pack: row.prep_pack as PrepPack,
  };
}

/**
 * The scenario material an attempt was actually run with.
 *
 * Falls back to the live row for attempts recorded before snapshots existed, so
 * historical attempts keep working while new ones are frozen.
 */
export function snapshotForAttempt(attempt: AttemptRow, scenario: ScenarioRow): ScenarioSnapshot {
  return attempt.scenario_snapshot ?? scenarioSnapshotOf(scenario);
}

/**
 * Delete an attempt row (its events, turns and report cascade).
 *
 * Used ONLY to undo an attempt whose setup could not be completed — a row that
 * nothing could ever call, and that would otherwise appear in history as an
 * already-failed "active" call.
 */
export async function deleteAttempt(id: string): Promise<void> {
  await db.delete(attempts).where(eq(attempts.id, id));
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

/**
 * Which attempt (if any) already owns this voice session.
 *
 * A session id is issued by the voice service to whoever held the temp token, so
 * binding it here is what stops one attempt from attaching another call's
 * session and importing its transcript into its own report.
 */
export async function findAttemptIdBySession(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.session_id, sessionId))
    .limit(1);
  return row?.id ?? null;
}

/** Same session-owner lookup on the locked transaction's own connection. */
export async function findAttemptIdBySessionTx(
  tx: DbClient,
  sessionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.session_id, sessionId))
    .limit(1);
  return row?.id ?? null;
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

export async function setAttemptOutcomeIfAcceptedTx(
  tx: DbClient,
  id: string,
  finalOffer: CompPackage,
  conditions: string[],
): Promise<void> {
  await tx
    .update(attempts)
    .set({
      outcome: "accepted",
      final_offer: finalOffer,
      final_conditions: conditions,
      status: "completed",
      ended_at: new Date(),
      finalizing_at: null,
    })
    .where(eq(attempts.id, id));
}

/** Re-read an attempt and its scenario on the locked transaction. */
export async function loadAttemptWithScenarioTx(
  tx: DbClient,
  id: string,
): Promise<{ attempt: AttemptRow; scenario: ScenarioRow }> {
  const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  if (!attempt) throw new ApiError(404, "Attempt not found");
  const [scenario] = await tx
    .select()
    .from(scenarios)
    .where(eq(scenarios.id, attempt.scenario_id))
    .limit(1);
  if (!scenario) throw new ApiError(404, "Scenario not found");
  return { attempt, scenario };
}

export async function setAttemptEngineStateTx(
  tx: DbClient,
  id: string,
  engineState: Record<string, unknown>,
): Promise<void> {
  await tx.update(attempts).set({ engine_state: engineState }).where(eq(attempts.id, id));
}

export async function setAttemptSessionTx(
  tx: DbClient,
  id: string,
  sessionId: string,
): Promise<void> {
  await tx.update(attempts).set({ session_id: sessionId }).where(eq(attempts.id, id));
}

/** Bind an attempt to a voice session (rules in `lib/session-binding.ts`). */
export async function bindAttemptSessionTx(
  tx: DbClient,
  id: string,
  sessionId: string,
): Promise<void> {
  await tx.update(attempts).set({ session_id: sessionId }).where(eq(attempts.id, id));
}

/**
 * Mark attempts that have been untouched far longer than a call can last as
 * abandoned, and return their ids.
 *
 * `markAbandoned()` existed but nothing ever called it, so a browser that was
 * closed mid-call (or a tab that crashed) left an `active` attempt forever.
 * Reclaiming is lazy and conservative: only attempts with no report and no
 * activity — neither the start nor the newest event — within `idleMs` are
 * touched, so a call that is genuinely still running (its events keep arriving)
 * is never abandoned, and nothing is deleted: events, reports and history stay
 * exactly as they were.
 *
 * A `finalizing` attempt whose barrier is older than `idleMs` is reclaimed too.
 * A completion holds the barrier for at most the route's own budget (under a
 * minute), so a barrier idle for fifteen minutes belongs to a function that is
 * gone — and leaving it up would keep the attempt unsettled forever and its
 * stored agent alive with it. The token is cleared with the barrier, so the
 * dead finalizer can neither commit nor release it afterwards.
 *
 * The ids come back so the caller can release whatever the reclaimed attempts
 * were still holding (their stored agents) — see `lib/db/reclaim.ts`.
 */
export async function reclaimStaleAttempts(idleMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - Math.max(1, idleMs));

  // Find candidates cheaply first. Every candidate is rechecked under the same
  // attempt advisory lock used by /turn, /events and /complete before the row is
  // actually reclaimed, so a concurrent mutation cannot race the final decision.
  const candidates = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      or(
        and(eq(attempts.status, "active"), sql`
          not exists (select 1 from reports r where r.attempt_id = attempts.id)
          and greatest(
            attempts.started_at,
            coalesce(
              (select max(e.created_at) from negotiation_events e where e.attempt_id = attempts.id),
              attempts.started_at
            )
          ) < ${cutoff}
        `),
        and(
          eq(attempts.status, "finalizing"),
          sql`coalesce(attempts.finalizing_at, attempts.started_at) < ${cutoff}`,
        ),
      ),
    );

  const reclaimed: string[] = [];

  for (const candidate of candidates) {
    const didReclaim = await withAttemptLock(candidate.id, async (tx) => {
      const [attempt] = await tx
        .select({
          id: attempts.id,
          status: attempts.status,
          startedAt: attempts.started_at,
          finalizingAt: attempts.finalizing_at,
        })
        .from(attempts)
        .where(eq(attempts.id, candidate.id))
        .limit(1);

      if (!attempt) return false;

      if (attempt.status === "active") {
        const [report] = await tx
          .select({ id: reports.id })
          .from(reports)
          .where(eq(reports.attempt_id, candidate.id))
          .limit(1);
        if (report) return false;

        const [lastEvent] = await tx
          .select({ createdAt: negotiationEvents.created_at })
          .from(negotiationEvents)
          .where(eq(negotiationEvents.attempt_id, candidate.id))
          .orderBy(desc(negotiationEvents.created_at))
          .limit(1);

        const lastActivity = Math.max(
          attempt.startedAt.getTime(),
          lastEvent?.createdAt?.getTime() ?? 0,
        );
        if (lastActivity >= cutoff.getTime()) return false;
      } else if (attempt.status === "finalizing") {
        const finalizingAt = attempt.finalizingAt?.getTime() ?? attempt.startedAt.getTime();
        if (finalizingAt >= cutoff.getTime()) return false;
      } else {
        return false;
      }

      await tx
        .update(attempts)
        .set({
          status: "abandoned",
          ended_at: new Date(),
          finalizing_at: null,
          finalization_token: null,
        })
        .where(eq(attempts.id, candidate.id));

      return true;
    });

    if (didReclaim) reclaimed.push(candidate.id);
  }

  return reclaimed;
}

/**
 * Drop recruiter-action authorizations that can no longer be redeemed.
 *
 * One row is written per authorized turn, so without this the table grows with
 * every call forever. A token is useless once it has expired (a day is far past
 * the two-minute window), and deleting it cannot affect an attempt that is still
 * running. Rows also cascade away with their attempt.
 */
export async function purgeExpiredAuthorizations(): Promise<number> {
  const res = await db.execute(sql`
    delete from attempt_authorizations
    where expires_at < now() - interval '1 day'
    returning id
  `);
  const rows = (res as unknown as { rows?: unknown[] }).rows ?? [];
  return rows.length;
}

/** How many attempts are still holding a scenario (used to guard deletion). */
export async function countActiveAttemptsForScenario(scenarioId: string): Promise<number> {
  const rows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(eq(attempts.scenario_id, scenarioId), inArray(attempts.status, ["active", "finalizing"])),
    );
  return rows.length;
}

/** Next monotonic seq for an attempt's events (must run inside the turn lock). */
async function nextEventSeqTx(tx: DbClient, attemptId: string): Promise<number> {
  const [row] = await tx
    .select({ m: sql<number>`coalesce(max(${negotiationEvents.seq}), 0)` })
    .from(negotiationEvents)
    .where(eq(negotiationEvents.attempt_id, attemptId));
  return Number(row?.m ?? 0) + 1;
}

/** Signatures of every event already stored for an attempt. */
async function listEventSignaturesTx(tx: DbClient, attemptId: string): Promise<string[]> {
  const rows = await tx
    .select({
      type: negotiationEvents.type,
      actor: negotiationEvents.actor,
      payload: negotiationEvents.payload,
      at_ms: negotiationEvents.at_ms,
    })
    .from(negotiationEvents)
    .where(eq(negotiationEvents.attempt_id, attemptId));
  return rows.map((r) => eventSignature(r));
}

/**
 * Insert events on an existing transaction (seq allocated under its lock).
 *
 * `dedupe` makes the write idempotent, which matters for anything a client
 * retries: a flush whose response was lost is sent again, and without this the
 * same move would be recorded twice (double-counted by the scorer, shown twice
 * in the replay). The check runs inside the caller's lock, so two concurrent
 * flushes cannot both decide the event is new.
 */
export async function insertEventsTx(
  tx: DbClient,
  attemptId: string,
  events: BatchedEvent[],
  opts: { dedupe?: boolean; authoritative?: boolean } = {},
): Promise<number> {
  if (events.length === 0) return 0;
  let toInsert = events;
  if (opts.dedupe) {
    const seen = new Set(await listEventSignaturesTx(tx, attemptId));
    toInsert = [];
    for (const e of events) {
      const signature = eventSignature(e);
      if (seen.has(signature)) continue;
      seen.add(signature);
      toInsert.push(e);
    }
    if (toInsert.length === 0) return 0;
  }
  let seq = await nextEventSeqTx(tx, attemptId);
  const rows = toInsert.map((e) => ({
    attempt_id: attemptId,
    seq: seq++,
    type: e.type,
    actor: e.actor,
    source: e.source,
    payload: e.payload as Record<string, unknown>,
    at_ms: clampEventAtMs(e.at_ms),
    // Only a server rule may mark an event authoritative; the default is false,
    // so a client batch is never scoring evidence by accident.
    authoritative: opts.authoritative ?? false,
  }));
  await tx.insert(negotiationEvents).values(rows);
  return rows.length;
}

// There is deliberately no non-transactional event writer. `insertEventsTx` is
// the only way events are appended, because allocation of `seq`, the attempt's
// status check and the dedupe check must all happen inside the same lock — and a
// caller that could append events without them is a caller that can slip a move
// into a call that has already been scored. (Sequence numbers used to be
// `MAX(seq) + 1` read *outside* any transaction, so two concurrent flushes could
// pick the same number and one batch would hit the `(attempt_id, seq)` unique
// index and be silently lost.)

/**
 * Run `fn` with exclusive access to one attempt's negotiation state.
 *
 * Two concurrent `/turn` requests for the same attempt must never read the same
 * state, mutate it independently, and clobber one another. A transaction-scoped
 * advisory lock keyed on the attempt id serialises them: the second waits,
 * re-reads the committed state, and processes against it.
 */
export async function withAttemptLock<T>(
  attemptId: string,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${attemptId}))`);
    return fn(tx);
  });
}

/** A previously-processed turn's stored response, or null. */
export async function getTurnReceipt(
  attemptId: string,
  turnId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ response: attemptTurns.response })
    .from(attemptTurns)
    .where(and(eq(attemptTurns.attempt_id, attemptId), eq(attemptTurns.turn_id, turnId)))
    .limit(1);
  return (row?.response as Record<string, unknown> | undefined) ?? null;
}

/** Same lookup on the locked transaction (the race-free check). */
export async function getTurnReceiptTx(
  tx: DbClient,
  attemptId: string,
  turnId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ response: attemptTurns.response })
    .from(attemptTurns)
    .where(and(eq(attemptTurns.attempt_id, attemptId), eq(attemptTurns.turn_id, turnId)))
    .limit(1);
  return (row?.response as Record<string, unknown> | undefined) ?? null;
}

/** Record a turn's response so a replay returns it instead of re-negotiating. */
export async function saveTurnReceiptTx(
  tx: DbClient,
  attemptId: string,
  turnId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(attemptTurns)
    .values({ attempt_id: attemptId, turn_id: turnId, response })
    .onConflictDoNothing();
}

export async function listEvents(attemptId: string): Promise<EventRow[]> {
  return db
    .select()
    .from(negotiationEvents)
    .where(eq(negotiationEvents.attempt_id, attemptId))
    .orderBy(asc(negotiationEvents.seq));
}

/**
 * Events on the locked transaction's own connection.
 *
 * The completion barrier freezes the log, so reading it here is how the report
 * can be written from the *same* snapshot it was scored from — and cite only
 * events that are genuinely on record.
 */
export async function listEventsTx(tx: DbClient, attemptId: string): Promise<EventRow[]> {
  return tx
    .select()
    .from(negotiationEvents)
    .where(eq(negotiationEvents.attempt_id, attemptId))
    .orderBy(asc(negotiationEvents.seq));
}

/**
 * Move an attempt between attempt-level states (see the finalization barrier in
 * `lib/finalize.ts`). `finalizing_at` is stamped when the barrier is taken and
 * cleared when it is released, so a crashed finalization can be recognised and
 * reclaimed instead of wedging the attempt forever.
 */
export async function setAttemptStatusTx(
  tx: DbClient,
  id: string,
  status: AttemptRow["status"],
): Promise<void> {
  await tx
    .update(attempts)
    .set({
      status,
      ...(status === "finalizing" ? { finalizing_at: new Date() } : { finalizing_at: null }),
    })
    .where(eq(attempts.id, id));
}

/**
 * Take the completion barrier and record WHO holds it.
 *
 * The token is minted here, never accepted from the caller, so a request that
 * reclaims a stale barrier owns it outright — the previous finalizer's token no
 * longer matches and its `commitFinalization`/`abandonFinalization` become no-ops.
 */
export async function claimAttemptForFinalizationTx(tx: DbClient, id: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await tx
    .update(attempts)
    .set({ status: "finalizing", finalizing_at: new Date(), finalization_token: token })
    .where(eq(attempts.id, id));
  return token;
}

/** Release a barrier this caller still owns; a no-op otherwise. */
export async function releaseAttemptFinalizationTx(
  tx: DbClient,
  id: string,
  token: string,
): Promise<boolean> {
  const rows = await tx
    .update(attempts)
    .set({ status: "active", finalizing_at: null, finalization_token: null })
    .where(and(eq(attempts.id, id), eq(attempts.finalization_token, token)))
    .returning({ id: attempts.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Recruiter-action authorizations
// ---------------------------------------------------------------------------

/**
 * How long a recruiter-action authorization stays redeemable.
 *
 * The voice model calls its tool within a second or two of receiving the
 * directive that asked for it, so two minutes is generous for a slow round-trip
 * while still making a captured token useless later in the call.
 */
export const AUTHORIZATION_TTL_MS = 120_000;

/**
 * Record a single-use authorization for an action the engine just decided.
 *
 * Minted only by `/turn` (the authoritative source of recruiter decisions), so a
 * browser cannot conjure one. The token is bound to the attempt, the turn, the
 * action and the EXACT package, and expires quickly — a tool call arrives within
 * seconds of the directive that requested it, and a stale token must not be
 * replayable later in the call.
 */
export async function grantAuthorizationTx(
  tx: DbClient,
  input: {
    attemptId: string;
    turnId: string | null;
    action: "offer" | "accept";
    package: CompPackage;
    conditions?: string[];
    ttlMs: number;
  },
): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await tx.insert(attemptAuthorizations).values({
    attempt_id: input.attemptId,
    token,
    turn_id: input.turnId,
    action: input.action,
    package: input.package,
    conditions: input.conditions ?? [],
    expires_at: new Date(Date.now() + input.ttlMs),
  });
  return token;
}

export interface ConsumedAuthorization {
  ok: boolean;
  reason?:
    | "unknown"
    | "foreign_attempt"
    | "used"
    | "expired"
    | "action_mismatch"
    | "package_mismatch"
    | "conditions_mismatch"
    | "stale";
  authorization?: AuthorizationRow;
}

/**
 * Verify and consume an authorization, atomically.
 *
 * Everything runs inside the caller's per-attempt lock, and the row is marked
 * used in the same statement that checks it, so two concurrent requests cannot
 * both consume one token. A mismatch is reported rather than thrown so the route
 * can fall back to recording the observed speech as a diagnostic.
 */
export async function consumeAuthorizationTx(
  tx: DbClient,
  input: {
    attemptId: string;
    token: string;
    action: "offer" | "accept";
    package: CompPackage;
    conditions?: string[];
  },
): Promise<ConsumedAuthorization> {
  const [row] = await tx
    .select()
    .from(attemptAuthorizations)
    .where(eq(attemptAuthorizations.token, input.token))
    .limit(1);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.attempt_id !== input.attemptId) return { ok: false, reason: "foreign_attempt" };
  if (row.used_at != null) return { ok: false, reason: "used" };
  if (row.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.action !== input.action) return { ok: false, reason: "action_mismatch" };
  if (!samePackage(row.package, input.package)) return { ok: false, reason: "package_mismatch" };
  if (!sameConditions(row.conditions ?? [], input.conditions ?? [])) {
    return { ok: false, reason: "conditions_mismatch" };
  }

  // An authorization belongs only to the latest committed turn. This prevents
  // a captured token from an earlier recruiter decision being redeemed after a
  // later `/turn` has already advanced the negotiation.
  if (!row.turn_id) return { ok: false, reason: "stale" };
  const [latestTurn] = await tx
    .select({ turnId: attemptTurns.turn_id })
    .from(attemptTurns)
    .where(eq(attemptTurns.attempt_id, input.attemptId))
    .orderBy(desc(attemptTurns.created_at))
    .limit(1);
  if (!latestTurn || latestTurn.turnId !== row.turn_id) {
    return { ok: false, reason: "stale" };
  }

  const claimed = await tx
    .update(attemptAuthorizations)
    .set({ used_at: new Date() })
    .where(and(eq(attemptAuthorizations.id, row.id), sql`${attemptAuthorizations.used_at} is null`))
    .returning({ id: attemptAuthorizations.id });
  if (claimed.length === 0) return { ok: false, reason: "used" };
  return { ok: true, authorization: { ...row, used_at: new Date() } };
}

/** Exact economic equality — a token authorizes one package, to the dollar. */
export function samePackage(a: CompPackage, b: CompPackage): boolean {
  return (
    Math.round(a.base) === Math.round(b.base) &&
    Math.round(a.sign_on ?? 0) === Math.round(b.sign_on ?? 0) &&
    Math.round(a.equity ?? 0) === Math.round(b.equity ?? 0)
  );
}

/** Exact ordered equality for recruiter-action conditions. */
export function sameConditions(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && a.every((value, index) => value.trim() === b[index]?.trim());
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

/** The attempt's report if it has one, without throwing — for polling. */
export async function findReport(attemptId: string): Promise<ReportRow | null> {
  const [row] = await db.select().from(reports).where(eq(reports.attempt_id, attemptId)).limit(1);
  return row ?? null;
}

/**
 * Report lookup on the locked transaction.
 *
 * Every read and write a locked operation performs has to travel on the SAME
 * connection: a second pooled connection inside an open transaction can wait on
 * a connection that the transaction itself is holding, which wedges the pool.
 */
export async function getReportTx(tx: DbClient, attemptId: string): Promise<ReportRow | null> {
  const [row] = await tx.select().from(reports).where(eq(reports.attempt_id, attemptId)).limit(1);
  return row ?? null;
}

export async function finishAttemptTx(
  tx: DbClient,
  id: string,
  outcome: Outcome,
  finalOffer: CompPackage | null,
): Promise<void> {
  await tx
    .update(attempts)
    .set({
      status: "completed",
      outcome,
      final_offer: finalOffer,
      ended_at: new Date(),
      finalizing_at: null,
      // The barrier is finished, so its ownership proof goes with it.
      finalization_token: null,
    })
    .where(eq(attempts.id, id));
}

/**
 * Best-effort release of an attempt's stored voice agent.
 *
 * Agents are provisioned per attempt and are pointless once the call is over, so
 * they are ephemeral. The guard is deliberate: an agent that an `active` or
 * `finalizing` attempt could still be using is never deleted.
 */
export async function releaseAttemptAgentTx(
  tx: DbClient,
  attemptId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ agentId: attempts.agent_id, status: attempts.status })
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!row?.agentId) return null;
  if (row.status === "active" || row.status === "finalizing") return null;
  await tx.update(attempts).set({ agent_id: null }).where(eq(attempts.id, attemptId));
  return row.agentId;
}

export interface ReportWrite {
  overall_score: number;
  rubric: unknown;
  strengths: string[];
  improvements: string[];
  summary: string;
  communication?: unknown;
  transcript: unknown;
  /** `server` | `client` | `server+client` — provenance of the scored transcript. */
  transcript_source?: string | null;
}

export async function saveReport(attemptId: string, report: ReportWrite): Promise<void> {
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

/** Report upsert on the locked transaction (same body, one connection). */
export async function saveReportTx(
  tx: DbClient,
  attemptId: string,
  report: ReportWrite,
): Promise<void> {
  const values = {
    attempt_id: attemptId,
    overall_score: report.overall_score,
    rubric: report.rubric as never,
    strengths: report.strengths,
    improvements: report.improvements,
    summary: report.summary,
    communication: (report.communication ?? null) as never,
    transcript: report.transcript as never,
    transcript_source: report.transcript_source ?? null,
  };
  await tx
    .insert(reports)
    .values(values)
    .onConflictDoUpdate({
      target: reports.attempt_id,
      set: {
        overall_score: values.overall_score,
        rubric: values.rubric,
        strengths: values.strengths,
        improvements: values.improvements,
        summary: values.summary,
        communication: values.communication,
        transcript: values.transcript,
        transcript_source: values.transcript_source,
      },
    });
}

/**
 * Overall score of the caller's most recent EARLIER scored attempt on the same
 * scenario, or null.
 *
 * The report page used to render this attempt's own score as "previous", so the
 * progress line always read `84 → 84 (+0)`. Progress is only meaningful against
 * a real prior attempt, so it is looked up properly — scoped to the caller, and
 * never against the sample library, which is not the caller's history.
 */
export async function getPreviousScore(
  scenarioId: string,
  attemptId: string,
  ownerId: string | null,
): Promise<number | null> {
  // No cookie means no history of the caller's own. Falling through to "any
  // attempt on this scenario" would report a stranger's score as their progress.
  if (!ownerId) return null;
  const res = await db.execute(sql`
    select r.overall_score as score
    from attempts a
    join reports r on r.attempt_id = a.id
    where a.scenario_id = ${scenarioId}
      and a.id <> ${attemptId}
      and a.owner_id = ${ownerId}
      and a.started_at < (select started_at from attempts where id = ${attemptId})
    order by a.started_at desc
    limit 1
  `);
  const rows = (res as unknown as { rows?: Array<{ score: number | null }> }).rows ?? [];
  const score = rows[0]?.score;
  return score == null ? null : Number(score);
}

/**
 * The caller's attempt history, and nothing else.
 *
 * Deliberately STRICTLY owner-scoped: rows owned by the sample-library sentinel
 * are no longer mixed in. Those rows predate per-visitor ownership (their NULL
 * owner was migrated to the sentinel), so every new visitor saw a pile of
 * strangers' attempts dressed up as "Sample" rows on their history page. The
 * purge of pre-2026-09-29 attempts removed the existing rows, and scoping here
 * to `owner_id = ownerId` is what guarantees no such row can ever show up again.
 *
 * No cookie means no history — never "everyone's history".
 */
export async function listHistory(ownerId: string | null = null): Promise<
  Array<{
    attempt: AttemptRow;
    scenarioTitle: string;
    score: number | null;
    /** Overall score of the user's PREVIOUS attempt on the same scenario. */
    previousScore: number | null;
    /** True for the public, read-only sample library. */
    isDemo: boolean;
  }>
> {
  const rows = await db
    .select({ attempt: attempts, scenario: scenarios, report: reports })
    .from(attempts)
    .innerJoin(scenarios, eq(attempts.scenario_id, scenarios.id))
    .leftJoin(reports, eq(reports.attempt_id, attempts.id))
    // Only the caller's own attempts. A caller with no owner cookie therefore
    // sees an empty history, never another visitor's rows. (This used to fall
    // through to an unscoped query when the cookie was absent, and later included
    // the sample-library sentinel — both handed a fresh browser profile the ids,
    // outcomes, agreed figures and scores of attempts that were not theirs.)
    .where(ownerId ? eq(attempts.owner_id, ownerId) : sql`false`)
    .orderBy(desc(attempts.started_at))
    .limit(100);

  // Previous attempt = the caller's most recent EARLIER SCORED attempt on the
  // same scenario (this is what "72 → 84" compares against). Walked oldest-first
  // so "previous" is genuinely earlier rather than merely lower down the page,
  // and scoped to the caller's own rows so a SAMPLE attempt can never become
  // someone's "previous score".
  const lastScoreByScenario = new Map<string, number>();
  const previousById = new Map<string, number>();
  for (const r of [...rows].reverse()) {
    if (isDemoOwner(r.attempt.owner_id)) continue;
    const sid = r.attempt.scenario_id;
    const previous = lastScoreByScenario.get(sid);
    if (previous != null) previousById.set(r.attempt.id, previous);
    if (r.report?.overall_score != null) lastScoreByScenario.set(sid, r.report.overall_score);
  }

  return rows.map((r) => ({
    attempt: r.attempt,
    scenarioTitle: r.scenario.title,
    score: r.report?.overall_score ?? null,
    previousScore: previousById.get(r.attempt.id) ?? null,
    isDemo: isDemoOwner(r.attempt.owner_id),
  }));
}