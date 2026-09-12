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
  decideRecruiterMove,
} from "@/lib/negotiation-engine";
import { getAttemptWithScenario, insertEvents } from "@/lib/db/queries";
import { hydrateAttempt } from "@/lib/negotiation";
import { MoveTypeEnum } from "@/lib/db/schema";
import type { CompPackage } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  user_text: z.string().min(1).max(2000),
  agent_text: z.string().max(2000).nullish(),
  user_interrupted: z.boolean().default(false),
});

export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid turn payload");

    const { attempt, scenario } = await getAttemptWithScenario(id);
    if (attempt.status !== "active") throw new ApiError(409, "Attempt is no longer active");
    const { effectiveHidden: hidden } = hydrateAttempt(attempt, scenario);

    // 1. Load or initialize engine state.
    const state = deserializeEngineState(attempt.engine_state) ?? initialEngineState(hidden);

    // 2. Classify the user's utterance and update trust scores.
    const classification = classifyUserMove(body.data.user_text, {
      userInterrupted: body.data.user_interrupted,
    });
    updateTrustScores(state, body.data.user_text);

    // 3. Decide the recruiter's move (deterministic).
    const recentUserMoves = [classification.primary];
    const move = decideRecruiterMove({ hidden, state, classification, recentUserMoves });

    // 4. Apply state transitions and record the verdict.
    if ("package" in move && move.package) {
      applyRecruiterPackage(state, hidden, move.package as CompPackage);
    }
    advanceRound(state);

    const engineVerdict =
      move.kind === "accept" ? "accepted" : move.kind === "hold_firm" ? "held" : move.kind;

    // 5. Persist engine state + negotiation events server-side.
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
      await insertEvents(
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
      );
    }

    const { setAttemptEngineState, setAttemptOutcomeIfAccepted } = await import(
      "@/lib/db/queries"
    );
    await setAttemptEngineState(id, serializeEngineState(state));
    if (move.kind === "accept") {
      await setAttemptOutcomeIfAccepted(id, move.package, []);
    }

    // 6. Build and return the directive for the voice LLM.
    const directive = buildDirective(move, hidden);
    return Response.json({ directive, verdict: engineVerdict });
  },
);
