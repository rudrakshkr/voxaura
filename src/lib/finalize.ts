import { assertAttemptAccess } from "./access";
import { ApiError } from "./api";
import type {
  AttemptRow,
  EventRow,
  ReportRow,
  ReportWrite,
  ScenarioRow,
} from "./db/queries";
import {
  claimAttemptForFinalizationTx,
  findReport,
  finishAttemptTx,
  getAttempt,
  getReportTx,
  insertEventsTx,
  listEventsTx,
  loadAttemptWithScenarioTx,
  releaseAttemptFinalizationTx,
  saveReportTx,
  withAttemptLock,
} from "./db/queries";
import type { BatchedEvent, CompPackage, Outcome, ReportData } from "./types";

/**
 * The completion barrier.
 *
 * Completion is a three-phase operation: take a frozen snapshot, score it (an
 * LLM call, which must NOT hold a pooled connection or a lock), then write the
 * report. The tempting implementation — snapshot, score, then write whatever
 * outcome you computed — has a data-loss race, and it was real:
 *
 *   - `/complete` read the attempt (status `active`, outcome `null`) and started
 *     scoring.
 *   - the candidate's last turn arrived, the engine accepted the deal, and the
 *     attempt was committed as `accepted` with the agreed package.
 *   - scoring finished and `/complete` wrote its STALE outcome — `stalemate`,
 *     final offer `null` — over the accepted deal. The candidate had agreed to a
 *     job and the report said the negotiation failed.
 *
 * Three mechanisms close it, and all are needed:
 *
 *  1. **A barrier.** `beginFinalization` atomically moves the attempt to
 *     `finalizing` under the same advisory lock every mutation takes. Every
 *     mutating route requires `active`, so once the barrier is up no turn, offer
 *     or event can change the state the report is being scored from — the
 *     snapshot IS the final state, and the report's evidence pointers, the
 *     replay and the history all describe the same call.
 *  2. **Ownership.** `finalizing_at` says WHEN the barrier was taken, not WHO
 *     took it. A killed function's barrier can be reclaimed after
 *     `FINALIZE_STALE_MS`, and without a token the old request could still come
 *     back and release or overwrite it. `finalization_token` is minted on every
 *     claim/reclaim and is required to commit or abandon, so a reclaimed
 *     finalizer's late work is a no-op.
 *  3. **A guard.** `commitFinalization` refuses to write an outcome that would
 *     downgrade a settled `accepted` attempt, whatever stale value the caller
 *     computed. The barrier makes this unreachable; the guard means a future bug
 *     cannot resurrect the old data loss.
 */

/** How long a barrier may be held before another request may reclaim it. */
export const FINALIZE_STALE_MS = 120_000;

export type BeginFinalization =
  | {
      kind: "claimed";
      /** Proof of ownership, required to commit or abandon this barrier. */
      token: string | null;
      attempt: AttemptRow;
      scenario: ScenarioRow;
      events: EventRow[];
    }
  | { kind: "already_completed"; report: ReportRow; attempt: AttemptRow }
  | { kind: "in_progress" };

function isStale(finalizingAt: Date | null): boolean {
  if (!finalizingAt) return true;
  return Date.now() - finalizingAt.getTime() > FINALIZE_STALE_MS;
}

/**
 * Phase 1: take the barrier and read the snapshot everything is scored from.
 *
 * Runs entirely inside the per-attempt lock, so it either sees the state a
 * concurrent turn committed, or it wins and the turn is refused.
 */
export async function beginFinalization(
  attemptId: string,
  ownerId: string | null,
): Promise<BeginFinalization> {
  return withAttemptLock(attemptId, async (tx) => {
    const { attempt, scenario } = await loadAttemptWithScenarioTx(tx, attemptId);
    // Writing: a sample attempt is readable by anyone and writable by no one.
    assertAttemptAccess(attempt, ownerId, "write");

    const existing = await getReportTx(tx, attemptId);
    if (existing) return { kind: "already_completed" as const, report: existing, attempt };

    if (attempt.status === "finalizing" && !isStale(attempt.finalizing_at)) {
      // Another completion owns this attempt right now. It is not an error the
      // caller should retry blindly: the winner will publish a report.
      return { kind: "in_progress" as const };
    }

    if (attempt.status === "abandoned") {
      throw new ApiError(409, "This attempt was abandoned and cannot be finalized. Start a new attempt.");
    }

    if (attempt.status === "completed") {
      // The engine already settled this attempt during a turn or an offer, so
      // every mutating route already refuses it. It is scored as-is: no barrier
      // is needed, and none is taken — moving a settled attempt back to
      // `finalizing` would let a failed completion "release" it into `active`.
      const events = await listEventsTx(tx, attemptId);
      return { kind: "claimed" as const, token: null, attempt, scenario, events };
    }

    // Take (or reclaim) the barrier and record who holds it.
    const token = await claimAttemptForFinalizationTx(tx, attemptId);
    const events = await listEventsTx(tx, attemptId);
    return {
      kind: "claimed" as const,
      token,
      attempt: { ...attempt, status: "finalizing" as const },
      scenario,
      events,
    };
  });
}

export interface FinalizationWrite {
  /** Server-authoritative outcome, decided from the frozen snapshot. */
  outcome: Outcome;
  /** Server-authoritative final package, from the engine state. */
  finalOffer: CompPackage | null;
  /** The scored report (model output — merged, never authoritative for state). */
  report: ReportData;
  /** Scorer-recovered events to append to the durable log. */
  extracted: BatchedEvent[];
  /** Highest event seq the scoring snapshot contained. */
  snapshotSeq: number;
  /** Where the scored transcript came from (report provenance). */
  transcriptSource?: string | null;
}

export type CommitFinalization =
  | { kind: "written"; report: ReportRow; outcome: Outcome }
  | { kind: "lost"; report: ReportRow; outcome: Outcome | null }
  /** This caller no longer owns the barrier — another finalizer has it. */
  | { kind: "stale" };

/**
 * Phase 3: write the report and close the attempt, under the lock.
 *
 * Idempotent under concurrency: two requests that both scored the same call
 * cannot both publish — the loser returns the winner's report instead of a
 * second, different score for the same conversation.
 */
export async function commitFinalization(
  attemptId: string,
  ownerId: string | null,
  token: string | null,
  write: FinalizationWrite,
): Promise<CommitFinalization> {
  return withAttemptLock(attemptId, async (tx) => {
    const { attempt: fresh } = await loadAttemptWithScenarioTx(tx, attemptId);
    assertAttemptAccess(fresh, ownerId, "write");

    // A barrier we do not own is not ours to write through. (An attempt the
    // engine already settled carries no barrier, so there is nothing to own.)
    if (fresh.status === "finalizing" && fresh.finalization_token !== token) {
      console.warn(
        `[finalize] refusing a stale completion for ${attemptId}: barrier belongs to another request`,
      );
      return { kind: "stale" as const };
    }
    // The stale sweep reclaimed this attempt while we were scoring (it had been
    // silent far longer than a live completion can be). Ownership passed with
    // the barrier, so this write is not ours to make.

    // The stale sweep reclaimed this attempt while we were scoring (it had been
    // silent far longer than a live completion can be). Ownership passed with
    // the barrier, so this write is not ours to make.
    if (fresh.status === "abandoned") {
      console.warn(
        `[finalize] refusing a completion for ${attemptId}: the attempt was reclaimed while scoring`,
      );
      return { kind: "stale" as const };
    }

    const existing = await getReportTx(tx, attemptId);
    if (existing) return { kind: "lost" as const, report: existing, outcome: fresh.outcome };

    // An accepted deal is never downgraded by a stale completion. (With the
    // barrier in place this cannot trigger — it is here so the invariant is
    // enforced where the write happens, not only where the decision is made.)
    let outcome = write.outcome;
    let finalOffer = write.finalOffer;
    if (fresh.outcome === "accepted" && write.outcome !== "accepted") {
      console.error(
        `[finalize] stale completion for ${attemptId}: keeping accepted over ${write.outcome}`,
      );
      outcome = "accepted";
      finalOffer = fresh.final_offer ?? write.finalOffer;
    } else if (fresh.outcome === "accepted") {
      // Agreed figures come from the attempt row, never from the scorer.
      finalOffer = fresh.final_offer ?? write.finalOffer;
    }

    // Read the durable log on THIS connection: the report cites events by seq,
    // and citing a move that is not on record (or missing one that is) is exactly
    // the replay/report disagreement this barrier exists to prevent.
    const events = await listEventsTx(tx, attemptId);
    const maxSeq = events.reduce((max, e) => Math.max(max, e.seq), 0);
    if (maxSeq !== write.snapshotSeq) {
      console.warn(
        `[finalize] event log moved during scoring for ${attemptId}: snapshot=${write.snapshotSeq}, now=${maxSeq}`,
      );
    }

    await saveReportTx(tx, attemptId, {
      ...withRealEventRefs(write.report, events),
      transcript_source: write.transcriptSource ?? null,
    });
    if (write.extracted.length > 0) {
      await insertEventsTx(tx, attemptId, write.extracted);
    }
    await finishAttemptTx(tx, attemptId, outcome, finalOffer);

    const saved = await getReportTx(tx, attemptId);
    if (!saved) throw new ApiError(500, "The report could not be saved.");
    return { kind: "written" as const, report: saved, outcome };
  });
}

/** How long a second completion waits for the first one's report. */
export const FINALIZE_WAIT_MS = 20_000;

const FINALIZE_POLL_MS = 400;

/**
 * Wait (bounded) for the completion that owns the barrier to publish.
 *
 * A duplicate completion is not an error — it is the same request twice, from a
 * client whose first response was lost. Rather than 409 the caller (who would
 * then have to poll), the second request waits for the first one's report and
 * returns it, so both calls agree on one report id.
 */
export async function awaitFinalReport(
  attemptId: string,
  timeoutMs = FINALIZE_WAIT_MS,
): Promise<{ report: ReportRow; attempt: AttemptRow } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FINALIZE_POLL_MS));
    const report = await findReport(attemptId);
    if (report) return { report, attempt: await getAttempt(attemptId) };
  }
  return null;
}

/**
 * Release the barrier after an unexpected failure, so a transient error (a
 * scoring provider outage, a killed request) leaves the attempt retryable
 * instead of stuck.
 *
 * Only ever releases a barrier this caller still OWNS: if the barrier went stale
 * and another request reclaimed it, this is a no-op and the new owner keeps it.
 */
export async function abandonFinalization(
  attemptId: string,
  token: string | null,
): Promise<void> {
  if (!token) return;
  try {
    await withAttemptLock(attemptId, async (tx) => {
      await releaseAttemptFinalizationTx(tx, attemptId, token);
    });
  } catch (err) {
    console.error(`[finalize] could not release the barrier for ${attemptId}:`, err);
  }
}

/**
 * Drop any evidence pointer that does not name a stored event.
 *
 * `event_seqs` is model output, and the report renders each value as a link into
 * the replay — an invented seq would point at a move that never happened.
 * Intersecting with the events actually on record makes "every dimension cites
 * real moves" true by construction rather than by trusting the model.
 */
export function withRealEventRefs(
  report: ReportData,
  events: Array<{ seq: number }>,
): ReportWrite {
  const real = new Set(events.map((e) => e.seq));
  return {
    overall_score: report.overall_score,
    rubric: report.rubric.map((d) => ({
      ...d,
      event_seqs: d.event_seqs.filter((s) => real.has(s)),
    })),
    strengths: report.strengths,
    improvements: report.improvements,
    summary: report.summary,
    communication: report.communication,
    transcript: report.transcript,
  };
}