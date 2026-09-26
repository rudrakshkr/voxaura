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
  type SpokenPackage,
} from "@/lib/negotiation-engine";
import { clampEventAtMs, type CompPackage } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    agent_text: z.string().min(1).max(4000).nullish(),
    /**
     * The structured arguments of an `offer_to_candidate` tool call. This path
     * exists because the tool call used to set the panel directly on the client,
     * bypassing the engine entirely — so a hallucinated package could reach the
     * panel without the engine state (and the next directive's FACT line)
     * learning about it.
     */
    package: z
      .object({
        base: z.number().int().min(0),
        sign_on: z.number().int().min(0).nullish(),
        equity: z.number().min(0).nullish(),
      })
      .nullish(),
    /** Conditions/notes attached to the offer, shown on the panel. */
    conditions: z.array(z.string().min(1).max(160)).max(3).nullish(),
    // Call-elapsed milliseconds. Clamped server-side before insert — see
    // clampEventAtMs — because a naive client sending Date.now() epoch-millis
    // would overflow the 4-byte integer column.
    at_ms: z.number().int().min(0).nullish(),
  })
  .refine((b) => Boolean(b.agent_text) || Boolean(b.package), {
    message: "agent_text or package is required",
  });

/**
 * Reconcile what the recruiter actually said (or called offer_to_candidate with)
 * against the authoritative economics.
 *
 * The voice model is directed to only speak engine-authorized numbers, but it
 * sometimes improvises a package — and once the candidate has HEARD those
 * numbers, the offer panel and the report must agree with the call. This route
 * parses the recruiter's utterance (or takes the tool-call package), folds it
 * into the server-side engine state by MIRRORING it: the panel shows exactly
 * what the recruiter said, the moment it said it. The engine state (and the next
 * directive's FACT line) adopts the spoken package so every later turn quotes
 * the same figures. A spoken figure beyond the approved band is not rewritten —
 * it becomes a scoring signal in the final report.
 *
 * It also reports whether the recruiter deferred the decision to an off-screen
 * team, which the call screen surfaces so the candidate can press for a real
 * answer instead of waiting on a promise that can never arrive.
 */
export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "agent_text or package is required");

    const { attempt, scenario } = await getAttemptWithScenario(id);
    const { effectiveHidden: hidden } = hydrateAttempt(attempt, scenario);
    const state = deserializeEngineState(attempt.engine_state) ?? initialEngineState(hidden);

    const text = body.data.agent_text?.trim() ?? "";
    const atMs = clampEventAtMs(body.data.at_ms);
    const conditions = (body.data.conditions ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .slice(0, 3);

    // 1. Spoken package (or structured tool-call package) → clamped, monotonic
    //    engine package.
    const spoken: SpokenPackage = body.data.package
      ? {
          base: body.data.package.base > 0 ? body.data.package.base : null,
          sign_on: body.data.package.sign_on ?? null,
          equity: body.data.package.equity ?? null,
          total: null,
        }
      : extractSpokenPackage(text);
    const reconciled = reconcileSpokenPackage(hidden, state, spoken);

    let standing: CompPackage = state.currentOffer;
    const events: Parameters<typeof insertEvents>[1] = [];

    if (reconciled) {
      if (reconciled.changed) {
        // The recruiter said a new package — that IS the package. It is mirrored
        // verbatim onto the panel and folded into the engine state so the next
        // directive's FACT line quotes the same figures. No clamping, no
        // reshaping: a figure beyond the approved band is a scoring signal in
        // the report, not a number the server silently rewrites.
        applyRecruiterPackage(state, hidden, reconciled.pkg);
        standing = reconciled.pkg;
      }
      // Only a real change of package is worth logging — restating the same
      // figures is not an event.
      if (reconciled.changed) {
        events.push({
          type: "opponent_offer",
          actor: "opponent",
          source: "tool",
          payload: {
            package: standing,
            spoken,
            impact: "neutral",
            note: "recruiter stated a package on the call",
          },
          at_ms: atMs,
        });
      }
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

    if (reconciled?.changed || (deferred && !alreadyPending)) {
      await setAttemptEngineState(id, serializeEngineState(state));
      if (events.length > 0) await insertEvents(id, events);
    }

    return Response.json({
      offer: standing,
      changed: reconciled?.changed ?? false,
      adjusted: false,
      previous: reconciled?.changed ? reconciled.previous : null,
      notice: null,
      conditions: conditions.length > 0 ? conditions : null,
      deferral: {
        outstanding: state.pendingDecision,
        deferredNow: deferred,
        quote: deferred ? text.slice(0, 240) : null,
      },
    });
  },
);
