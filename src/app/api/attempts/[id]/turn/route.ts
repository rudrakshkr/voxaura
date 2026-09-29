import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  advanceRound,
  applyRecruiterPackage,
  deserializeEngineState,
  initialEngineState,
  serializeEngineState,
  updateTrustScores,
} from "@/lib/engine-state";
import {
  buildDirective,
  classifyUserMove,
  closingOutcome,
  decideRecruiterMove,
  type RecruiterMove,
} from "@/lib/negotiation-engine";
import {
  AUTHORIZATION_TTL_MS,
  getAttempt,
  getTurnReceipt,
  getTurnReceiptTx,
  grantAuthorizationTx,
  insertEventsTx,
  loadAttemptWithScenarioTx,
  saveTurnReceiptTx,
  setAttemptEngineStateTx,
  setAttemptOutcomeIfAcceptedTx,
  withAttemptLock,
} from "@/lib/db/queries";
import { hydrateAttempt } from "@/lib/negotiation";
import { MoveTypeEnum } from "@/lib/db/schema";
import { readOwnerId, assertAttemptAccess } from "@/lib/ownership";
import { takeTurnSlot } from "@/lib/rate-limit";
import type { CompPackage } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The recruiter actions this move AUTHORIZES the browser to perform.
 *
 * This is the trust boundary for `/offer`: only here — inside the locked turn
 * that the deterministic engine decided — is a recruiter package or acceptance
 * declared real. The token minted with it is what `/offer` redeems, so a browser
 * cannot manufacture an opponent offer, an acceptance, or an engine mutation by
 * calling `/offer` directly.
 *
 * Deterministic from the move, so the directive the model obeys and the
 * authorization the server issues can never describe different numbers.
 */
function authorizationFor(
  move: RecruiterMove,
): { action: "offer" | "accept"; package: CompPackage } | null {
  switch (move.kind) {
    case "counter":
    case "trade":
    case "recover_from_walkaway":
      return { action: "offer", package: move.package };
    case "accept":
      return { action: "accept", package: move.package };
    default:
      return null;
  }
}

const BodySchema = z.object({
  user_text: z.string().min(1).max(2000),
  agent_text: z.string().max(2000).nullish(),
  user_interrupted: z.boolean().default(false),
  /**
   * Idempotency key for this utterance. The voice client retries on timeout, so
   * the same turn can arrive twice — replaying either processes the sentence
   * twice against a mutated state, or double-counts a concession.
   */
  turn_id: z.string().min(8).max(80).nullish(),
});

export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid turn payload");

    const ownerId = await readOwnerId();
    // Ownership first: a replay must not become a way to read another caller's
    // attempt by guessing a turn id. Writing, so a sample attempt is refused.
    assertAttemptAccess(await getAttempt(id), ownerId, "write");
    const turnId = body.data.turn_id ?? null;

    // Idempotent replay: a turn we already processed returns its original
    // response and never touches the negotiation state again. Checked before the
    // lock (cheap) and again inside it (a retry that arrived while the first
    // request was still committing must not be processed twice).
    if (turnId) {
      const receipt = await getTurnReceipt(id, turnId);
      if (receipt) return Response.json({ ...receipt, replayed: true });
    }

    if (!takeTurnSlot(id)) {
      throw new ApiError(429, "Too many turns in flight for this call.");
    }

    // Everything below runs inside one transaction holding the per-attempt
    // advisory lock, so concurrent turns serialise: the second waits, re-reads
    // the committed state, and processes against it rather than overwriting it.
    const payload = await withAttemptLock(id, async (tx) => {
      if (turnId) {
        const receipt = await getTurnReceiptTx(tx, id, turnId);
        if (receipt) return receipt;
      }
      const { attempt, scenario } = await loadAttemptWithScenarioTx(tx, id);
      assertAttemptAccess(attempt, ownerId, "write");
      if (attempt.status !== "active") throw new ApiError(409, "Attempt is no longer active");
      const { effectiveHidden: hidden } = hydrateAttempt(attempt, scenario);

      // 1. Load or initialize engine state (authoritative, server-side only).
      const state = deserializeEngineState(attempt.engine_state) ?? initialEngineState(hidden);

      // 2. Classify the user's utterance and update trust scores.
      const classification = classifyUserMove(body.data.user_text, {
        userInterrupted: body.data.user_interrupted,
      });
      updateTrustScores(state, body.data.user_text);

      // 3. Decide the recruiter's move (deterministic).
      const move = decideRecruiterMove({
        hidden,
        state,
        classification,
        recentUserMoves: [classification.primary],
      });

      // 4. Apply state transitions and record the verdict.
      if ("package" in move && move.package) {
        applyRecruiterPackage(state, hidden, move.package as CompPackage);
      }
      advanceRound(state);

      const engineVerdict =
        move.kind === "accept" ? "accepted" : move.kind === "hold_firm" ? "held" : move.kind;

      // 5. Persist negotiation events server-side.
      const events: Array<{
        type: string;
        actor: "user" | "opponent";
        source: "tool";
        impact?: "strong" | "neutral" | "risky";
        payload: Record<string, unknown>;
        at_ms: number | null;
      }> = [];

      if (classification.primary !== "rapport") {
        events.push({
          type: classification.primary,
          actor: "user",
          source: "tool",
          impact: classification.primary === "information_revealed" ? "risky" : "neutral",
          payload: {
            amount: classification.askedAmount ?? null,
            note: body.data.user_text.slice(0, 200),
            leverage: classification.leverage.amount ?? null,
            reservation_reveal: classification.reservationReveal ?? null,
            turn_id: turnId,
          },
          at_ms: null,
        });
      }

      if (move.kind === "counter" || move.kind === "trade" || move.kind === "recover_from_walkaway") {
        events.push({
          type: move.kind === "counter" ? "counteroffer" : "package_trade",
          actor: "opponent",
          source: "tool",
          impact: "neutral",
          payload: {
            package: move.package,
            conditions: move.conditions,
            note: engineVerdict,
          },
          at_ms: null,
        });
      } else if (move.kind === "accept") {
        events.push({
          type: "acceptance",
          actor: "opponent",
          source: "tool",
          impact: "strong",
          payload: { package: move.package, note: "engine-validated acceptance" },
          at_ms: null,
        });
      } else if (move.kind === "hold_firm" || move.kind === "challenge_leverage") {
        events.push({
          type: move.kind === "challenge_leverage" ? "leverage_challenged" : "opponent_offer",
          actor: "opponent",
          source: "tool",
          impact: "neutral",
          payload: { note: engineVerdict },
          at_ms: null,
        });
      }

      if (events.length > 0) {
        // `authoritative: true` — this is the canonical record of what the
        // candidate did this turn and what the engine decided. A client
        // `log_user_move` annotation for the same sentence is stored too (for the
        // live UI and the replay) but is never scoring evidence, so one utterance
        // produces exactly one authoritative event.
        await insertEventsTx(
          tx,
          id,
          events.map((e) => ({
            type: (MoveTypeEnum as readonly string[]).includes(e.type)
              ? (e.type as (typeof MoveTypeEnum)[number])
              : "rapport",
            actor: e.actor,
            source: e.source,
            payload: { ...e.payload, impact: e.impact },
            at_ms: e.at_ms,
          })),
          { authoritative: true },
        );
      }

      await setAttemptEngineStateTx(tx, id, serializeEngineState(state));
      if (move.kind === "accept") {
        await setAttemptOutcomeIfAcceptedTx(tx, id, move.package, []);
      }

      // 6. Build the directive for the voice LLM. The standing package and the
      //    turn number travel with it so a hold-firm turn may restate the exact
      //    figures (never raise them), and the recruiter never asks the same
      //    probing question twice.
      const directive = buildDirective(move, hidden, {
        standingOffer: state.currentOffer,
        round: state.round,
      });

      // 7. Authorize the recruiter action this move dictates. The token is
      //    bound to the attempt, the turn, the action and the EXACT package, and
      //    is single-use — so `/offer` can accept a package here and nowhere
      //    else. Without this, a browser could call `/offer` directly with any
      //    package (or `accept_candidate_package`) and manufacture a recruiter
      //    offer or an acceptance the recruiter never made.
      const authorized = authorizationFor(move);
      const authorizationToken =
        authorized && turnId
          ? await grantAuthorizationTx(tx, {
              attemptId: id,
              turnId,
              action: authorized.action,
              package: authorized.package,
              conditions: "conditions" in move ? move.conditions : [],
              ttlMs: AUTHORIZATION_TTL_MS,
            })
          : null;

      // `final` marks the recruiter's definitive last word, and `close` names
      // the outcome the call should end with when the negotiation truly cannot
      // continue (the candidate walked, or the numbers are definitively dead).
      const response: Record<string, unknown> = {
        directive,
        verdict: engineVerdict,
        final: move.kind === "hold_firm" && move.final === true,
        close: closingOutcome(move),
        // The engine's own view of the package, so the client can show an
        // authoritative figure without echoing anything the model said.
        standing: state.currentOffer,
        round: state.round,
        // Proof the client may present to `/offer` to make this exact action
        // authoritative. Null for moves that authorize no recruiter action.
        authorization: authorizationToken
          ? { token: authorizationToken, action: authorized!.action, package: authorized!.package }
          : null,
      };

      if (turnId) await saveTurnReceiptTx(tx, id, turnId, response);
      return response;
    });

    return Response.json(payload);
  },
);