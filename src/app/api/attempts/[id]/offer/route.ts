import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  applyRecruiterPackage,
  deserializeEngineState,
  initialEngineState,
  serializeEngineState,
} from "@/lib/engine-state";
import { getAttemptWithScenario, insertEvents, setAttemptEngineState } from "@/lib/db/queries";
import { hydrateAttempt } from "@/lib/negotiation";
import {
  detectDeferral,
  extractSpokenPackage,
  reconcileSpokenPackage,
} from "@/lib/negotiation-engine";
import type { CompPackage } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  agent_text: z.string().min(1).max(4000),
  at_ms: z.number().int().min(0).nullish(),
});

/**
 * Reconcile what the recruiter actually said with the authoritative economics.
 *
 * The voice model is directed to only speak engine-authorized numbers, but it
 * sometimes improvises a package — and once the candidate has HEARD those
 * numbers, the offer panel and the report must agree with the call. This route
 * parses the recruiter's utterance, folds it into the server-side engine state
 * (trimmed to the company ceiling, never reduced), and returns the package the
 * UI should display.
 *
 * It also reports whether the recruiter deferred the decision to an off-screen
 * team, which the call screen surfaces so the candidate can press for a real
 * answer instead of waiting on a promise that can never arrive.
 */
export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "agent_text is required");

    const { attempt, scenario } = await getAttemptWithScenario(id);
    const { effectiveHidden: hidden } = hydrateAttempt(attempt, scenario);
    const state = deserializeEngineState(attempt.engine_state) ?? initialEngineState(hidden);

    const text = body.data.agent_text;
    const atMs = body.data.at_ms ?? null;

    // 1. Spoken package → clamped, monotonic engine package.
    const spoken = extractSpokenPackage(text);
    const reconciled = reconcileSpokenPackage(hidden, state, spoken);

    let standing: CompPackage = state.currentOffer;
    const events: Parameters<typeof insertEvents>[1] = [];

    if (reconciled) {
      applyRecruiterPackage(state, hidden, reconciled.pkg);
      standing = reconciled.pkg;
      events.push({
        type: "opponent_offer",
        actor: "opponent",
        source: "tool",
        payload: {
          package: reconciled.pkg,
          spoken,
          impact: "neutral",
          note: reconciled.adjusted
            ? "recruiter's spoken package, trimmed to the approved band"
            : "recruiter stated a package on the call",
        },
        at_ms: atMs,
      });
    }

    // 2. Deferral → the engine now owes the candidate a real decision.
    const deferred = detectDeferral(text);
    const alreadyPending = state.pendingDecision;
    if (deferred && !alreadyPending) {
      state.pendingDecision = true;
      events.push({
        type: "pressure_tactic",
        actor: "opponent",
        source: "tool",
        payload: {
          impact: "risky",
          note: "recruiter deferred the decision to an internal team",
          quote: text.slice(0, 240),
        },
        at_ms: atMs,
      });
    }

    if (reconciled || (deferred && !alreadyPending)) {
      await setAttemptEngineState(id, serializeEngineState(state));
      await insertEvents(id, events);
    }

    return Response.json({
      offer: standing,
      changed: reconciled != null,
      adjusted: reconciled?.adjusted ?? false,
      previous: reconciled?.previous ?? null,
      deferral: {
        outstanding: state.pendingDecision,
        deferredNow: deferred,
        quote: deferred ? text.slice(0, 240) : null,
      },
    });
  },
);
