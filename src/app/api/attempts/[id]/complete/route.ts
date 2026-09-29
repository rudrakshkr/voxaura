import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { degradedReport, scoreAttempt } from "@/lib/ai/score";
import { getSessionTimeline } from "@/lib/assemblyai/sessions";
import {
  bindAttemptSessionTx,
  findAttemptIdBySessionTx,
  getAttemptWithScenario,
  getReport,
  loadAttemptWithScenarioTx,
  snapshotForAttempt,
  withAttemptLock,
} from "@/lib/db/queries";
import { LLM_EXTRACTABLE_EVENTS } from "@/lib/db/schema";
import { deserializeEngineState } from "@/lib/engine-state";
import { env } from "@/lib/env";
import {
  abandonFinalization,
  awaitFinalReport,
  beginFinalization,
  commitFinalization,
  type BeginFinalization,
  type FinalizationWrite,
} from "@/lib/finalize";
import { releaseAttemptAgent } from "@/lib/agent-lifecycle";
import { hydrateAttempt } from "@/lib/negotiation";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";
import { decideSessionBinding } from "@/lib/session-binding";
import { canonicalTranscript, timelineToTurns } from "@/lib/transcript";
import {
  capEventPayload,
  clampEventAtMs,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_TURN_CHARS,
  MAX_TRANSCRIPT_TURNS,
} from "@/lib/types";
import type { BatchedEvent, CompPackage, Outcome, TranscriptTurn } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One budget for the whole completion.
 *
 * The route may live for 60s while each LLM call allows 45s plus retries, so
 * without a single deadline the nested retries can consume the entire route
 * budget and the function is killed mid-score (leaving the barrier to be
 * reclaimed). Everything expensive here is given the REMAINING time, and when it
 * runs out the attempt still completes — via the labeled degraded report.
 */
const COMPLETION_BUDGET_MS = 45_000;

const BodySchema = z.object({
  session_id: z.string().min(1).max(200).nullish(),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        text: z.string().min(1).max(MAX_TRANSCRIPT_TURN_CHARS),
        interrupted: z.boolean().default(false),
        at_ms: z.number().int().nullish(),
      }),
    )
    .max(MAX_TRANSCRIPT_TURNS)
    .default([]),
  /**
   * The ONLY outcome a client may suggest, and only for the one close the engine
   * cannot observe: the recruiter ending the call over abusive language.
   * Acceptance, walk-away and stalemate are decided server-side from the engine
   * state and the event log — a browser must not be able to declare a deal.
   */
  outcome: z.literal("rejected").nullish(),
});

/**
 * Outcome and final package for a frozen snapshot, SERVER-AUTHORITATIVE.
 *
 * Acceptance, walk-away and stalemate are read off the engine's own event log —
 * the same log the client saw — and the final package comes from the engine
 * state, never from the scorer and never from the request.
 */
function authoritativeResult(
  snapshot: BeginFinalization & { kind: "claimed" },
  requested: "rejected" | null | undefined,
) {
  const { attempt, events } = snapshot;
  let outcome: Outcome | null = attempt.outcome ?? null;
  if (!outcome) {
    const engineAccepted = [...events]
      .reverse()
      .find((e) => e.type === "acceptance" && e.actor === "opponent");
    if (engineAccepted) {
      outcome = "accepted";
    } else {
      const walked = [...events].reverse().find((e) => e.type === "walk_away" && e.actor === "user");
      if (walked) outcome = "walked_away";
      // The one engine-unobservable close (abuse) may be suggested by the
      // client; nothing else may.
      else if (requested === "rejected") outcome = "rejected";
    }
  }
  const engine = deserializeEngineState(attempt.engine_state);
  const finalOffer: CompPackage | null = attempt.final_offer ?? engine?.currentOffer ?? null;
  return { outcome, finalOffer };
}

/**
 * Resolve — and if necessary perform the FIRST bind of — the voice session this
 * attempt will be scored from.
 *
 * The body's session id is a request, not an instruction: it must match what the
 * attempt already recorded, or establish the binding for the first time. It can
 * never substitute a different session at completion time.
 */
async function resolveSessionForCompletion(
  attemptId: string,
  ownerId: string | null,
  requested: string | null | undefined,
): Promise<string | null> {
  return withAttemptLock(attemptId, async (tx) => {
    const { attempt } = await loadAttemptWithScenarioTx(tx, attemptId);
    assertAttemptAccess(attempt, ownerId, "write");
    if (attempt.status !== "active") return attempt.session_id;
    const ownerOfRequested = requested
      ? attempt.session_id === requested
        ? attemptId
        : await findAttemptIdBySessionTx(tx, requested)
      : null;
    const decision = decideSessionBinding({
      attemptId,
      stored: attempt.session_id,
      requested,
      ownerOfRequested,
      allowRebind: false,
    });
    if (decision.kind === "conflict") throw new ApiError(409, decision.message);
    if (decision.kind === "bind") {
      await bindAttemptSessionTx(tx, attemptId, decision.sessionId);
      return decision.sessionId;
    }
    if (decision.kind === "use") return decision.sessionId;
    return null;
  });
}

export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid completion payload");

    // Reject a transcript that is inside every per-turn limit but enormous in
    // aggregate BEFORE any LLM work: it would be interpolated into the prompt.
    const transcriptChars = body.data.transcript.reduce((n, t) => n + t.text.length, 0);
    if (transcriptChars > MAX_TRANSCRIPT_CHARS) {
      throw new ApiError(413, "Transcript too large to score");
    }

    const startedAt = Date.now();
    const deadline = startedAt + COMPLETION_BUDGET_MS;
    const remainingMs = () => Math.max(0, deadline - Date.now());

    const ownerId = await readOwnerId();

    // Cheap idempotency check before taking the barrier, so a retry of an
    // already-scored call does not even contend for the lock.
    const { attempt: pre } = await getAttemptWithScenario(id);
    assertAttemptAccess(pre, ownerId, "write");
    if (pre.status === "completed") {
      const existing = await getReport(id).catch(() => null);
      if (existing) {
        return Response.json({
          report_id: existing.id,
          overall_score: existing.overall_score,
          outcome: pre.outcome ?? "stalemate",
          already_completed: true,
        });
      }
    }

    // Bind/verify the session BEFORE the barrier: a conflicting session id must
    // be refused without ever touching the attempt's finalization state.
    const sessionId = await resolveSessionForCompletion(id, ownerId, body.data.session_id);

    // Phase 1 — take the completion barrier and freeze the snapshot. From here
    // until the report is written this attempt is closed to turns, offers and
    // events, so what is scored below is what the call actually ended as.
    const claim = await beginFinalization(id, ownerId);
    if (claim.kind === "already_completed") {
      return Response.json({
        report_id: claim.report.id,
        overall_score: claim.report.overall_score,
        outcome: claim.attempt.outcome ?? "stalemate",
        already_completed: true,
      });
    }
    if (claim.kind === "in_progress") {
      // The same completion, sent twice (a lost response, a double click). Wait
      // for the owner of the barrier to publish and return ITS report, so both
      // calls agree on one report id instead of the second failing outright.
      const settled = await awaitFinalReport(id);
      if (settled) {
        return Response.json({
          report_id: settled.report.id,
          overall_score: settled.report.overall_score,
          outcome: settled.attempt.outcome ?? "stalemate",
          already_completed: true,
        });
      }
      throw new ApiError(409, "This call is already being scored. Try again in a moment.");
    }

    const token = claim.token;
    try {
      // 2. The final result comes from the frozen snapshot — not from a second,
      //    later read that a concurrent acceptance could have changed.
      const { outcome, finalOffer } = authoritativeResult(claim, body.data.outcome);

      // 3. Canonical transcript: the client's live buffer reconciled against the
      //    recorded session timeline when one exists.
      const clientTranscript: TranscriptTurn[] = body.data.transcript.map((t) => ({
        role: t.role,
        text: t.text,
        interrupted: t.interrupted,
        atMs: clampEventAtMs(t.at_ms),
      }));
      let serverTranscript: TranscriptTurn[] = [];
      // Debug mode never reaches the voice service: the recorded timeline is a
      // network artifact and `AI_DEBUG` promises a deterministic, offline report.
      if (!env().AI_DEBUG && sessionId && Date.now() < deadline) {
        const timeline = await getSessionTimeline(sessionId, remainingMs());
        if (timeline) serverTranscript = timelineToTurns(timeline);
      }
      const canonical = canonicalTranscript(clientTranscript, serverTranscript);
      const transcript = canonical.turns;
      if (canonical.source !== "client" || clientTranscript.length !== transcript.length) {
        console.info(
          `[complete] transcript for ${id}: source=${canonical.source} (client=${clientTranscript.length}, server=${serverTranscript.length})`,
        );
      }

      // 4. Score with full evidence (engine state + hidden economics). Only
      //    AUTHORITATIVE events are evidence: a client annotation can never be a
      //    second scoring event for one utterance, and a fabricated one cannot
      //    move the score. If every provider is down — or the budget runs out —
      //    fall back to a clearly-labeled heuristic report.
      const { effectiveHidden } = hydrateAttempt(claim.attempt, claim.scenario);
      const snapshot = snapshotForAttempt(claim.attempt, claim.scenario);
      const authoritativeEvents = claim.events.filter((e) => e.authoritative);
      let report;
      if (Date.now() >= deadline) {
        report = degradedReport(
          transcript,
          authoritativeEvents.map((e) => ({
            type: e.type as never,
            actor: e.actor,
            source: e.source,
            payload: e.payload,
            at_ms: e.at_ms,
            seq: e.seq,
          })),
          finalOffer,
          outcome,
          effectiveHidden.opening_anchor,
        );
      } else {
        try {
          report = await scoreAttempt({
            transcript,
            liveEvents: authoritativeEvents.map((e) => ({
              type: e.type as never,
              actor: e.actor,
              source: e.source,
              payload: { ...e.payload, seq: e.seq },
              at_ms: e.at_ms,
              seq: e.seq,
            })),
            hidden: effectiveHidden,
            prepObjective: snapshot.prep_pack?.coaching_objective,
            finalOffer,
            outcome,
            openingOfferBase: effectiveHidden.opening_anchor,
            timeoutMs: remainingMs(),
            deadlineAt: deadline,
          });
        } catch (err) {
          console.error("[complete] scoring unavailable, using degraded report:", err);
          report = degradedReport(
            transcript,
            authoritativeEvents.map((e) => ({
              type: e.type as never,
              actor: e.actor,
              source: e.source,
              payload: e.payload,
              at_ms: e.at_ms,
              seq: e.seq,
            })),
            finalOffer,
            outcome,
            effectiveHidden.opening_anchor,
          );
        }
      }

      // 5. Scorer-recovered evidence. The durable log is written inside the
      //    commit, and only for events a transcript can genuinely evidence — a
      //    model may never recover an `acceptance`, an `opponent_offer` or any
      //    other server-owned fact, whoever produced it. These are NOT marked
      //    authoritative: they are derived from a transcript.
      const extractable = new Set<string>(LLM_EXTRACTABLE_EVENTS);
      const extracted: BatchedEvent[] = report.events
        .filter((e) => e.source === "llm_extract" && extractable.has(e.type))
        .map((e) => ({
          type: e.type,
          actor: "user" as const,
          source: "llm_extract" as const,
          payload: capEventPayload(e.payload),
          at_ms: e.at_ms ?? null,
        }));

      // Phase 3 — one locked write: the report, the recovered events, and the
      // attempt's final outcome, all from the frozen snapshot.
      const write: FinalizationWrite = {
        outcome: outcome ?? "stalemate",
        finalOffer,
        report,
        extracted,
        snapshotSeq: claim.events.reduce((max, e) => Math.max(max, e.seq), 0),
        transcriptSource: canonical.source,
      };
      const committed = await commitFinalization(id, ownerId, token, write);

      if (committed.kind === "stale") {
        // Another finalizer reclaimed our barrier while we were scoring. Its
        // result is the authoritative one; never publish ours over it.
        const settled = await awaitFinalReport(id);
        if (settled) {
          return Response.json({
            report_id: settled.report.id,
            overall_score: settled.report.overall_score,
            outcome: settled.attempt.outcome ?? "stalemate",
            already_completed: true,
          });
        }
        throw new ApiError(409, "This call is being scored by another request.");
      }

      // The attempt is terminal, so its stored opponent agent is dead weight.
      void releaseAttemptAgent(id);

      return Response.json({
        report_id: committed.report.id,
        overall_score: committed.report.overall_score,
        outcome: committed.outcome ?? outcome ?? "stalemate",
        transcript_source: canonical.source,
        ...(committed.kind === "lost" ? { already_completed: true } : {}),
      });
    } catch (err) {
      // Release the barrier so a transient failure leaves the call retryable
      // rather than permanently unfinishable. A no-op if we no longer own it.
      await abandonFinalization(id, token);
      throw err;
    }
  },
);