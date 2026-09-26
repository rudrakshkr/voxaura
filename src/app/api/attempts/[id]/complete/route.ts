import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { degradedReport, scoreAttempt } from "@/lib/ai/score";
import { getSessionTimeline } from "@/lib/assemblyai/sessions";
import {
  finishAttempt,
  getAttemptWithScenario,
  getReport,
  insertEvents,
  listEvents,
  saveReport,
} from "@/lib/db/queries";
import { hydrateAttempt } from "@/lib/negotiation";
import { dedupeTranscriptTurns } from "@/lib/negotiation-engine";
import { clampEventAtMs, Outcome } from "@/lib/types";
import type { TranscriptTurn } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({
  session_id: z.string().min(1).nullish(),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        text: z.string().min(1),
        interrupted: z.boolean().default(false),
        at_ms: z.number().int().nullish(),
      }),
    )
    .max(500)
    .default([]),
  outcome: Outcome.nullish(),
});

export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid completion payload");

    const { attempt, scenario } = await getAttemptWithScenario(id);

    // 1. Outcome is SERVER-AUTHORITATIVE: the engine finalizes acceptances.
    //    Client hints only fill gaps (walk-away detection when the engine
    //    never accepted and the candidate explicitly rejected).
    const events = await listEvents(id);
    let outcome = attempt.outcome ?? body.data.outcome ?? null;
    const finalOffer = attempt.final_offer ?? null;
    if (!outcome) {
      const engineAccepted = [...events]
        .reverse()
        .find((e) => e.type === "acceptance" && e.actor === "opponent");
      if (engineAccepted) {
        outcome = "accepted";
      } else {
        const walked = [...events].reverse().find(
          (e) => e.type === "walk_away" && e.actor === "user",
        );
        if (walked) outcome = "walked_away";
      }
    }

    // 2. Merge live transcript with the recorded session timeline when the
    //    client couldn't provide one (tab crash, reload).
    let transcript: TranscriptTurn[] = body.data.transcript.map((t) => ({
      role: t.role,
      text: t.text,
      interrupted: t.interrupted,
      atMs: clampEventAtMs(t.at_ms),
    }));
    if (transcript.length === 0 && attempt.session_id) {
      const timeline = await getSessionTimeline(attempt.session_id);
      if (timeline) {
        transcript = timeline
          .map((turn) => ({
            role: (turn.user_transcript ? "user" : "agent") as "user" | "agent",
            text: (turn.user_transcript ?? turn.agent_text ?? "").trim(),
            interrupted: false,
            atMs: null,
          }))
          .filter((t) => t.text.length > 0);
      }
    }
    // The voice service occasionally finalises one utterance twice. Collapsing
    // those here keeps the report from showing the recruiter repeating itself
    // verbatim (and from scoring a duplicate turn as a real one).
    transcript = dedupeTranscriptTurns(transcript);

    // 3. Score with full evidence (engine state + hidden economics).
    //    If every LLM provider is down (out of credits, outage), fall back to
    //    a clearly-labeled heuristic report instead of failing the request —
    //    the user keeps their transcript, timeline, and outcome either way.
    const { effectiveHidden } = hydrateAttempt(attempt, scenario);
    const scoreInput = {
      transcript,
      liveEvents: events.map((e) => ({
        type: e.type as never,
        actor: e.actor,
        source: e.source,
        payload: e.payload,
        at_ms: e.at_ms,
        seq: e.seq,
      })),
      hidden: effectiveHidden,
      prepObjective: scenario.prep_pack?.coaching_objective,
      finalOffer,
      outcome,
      openingOfferBase: effectiveHidden.opening_anchor,
    };
    let report;
    try {
      report = await scoreAttempt(scoreInput);
    } catch (err) {
      console.error("[complete] scoring unavailable, using degraded report:", err);
      report = degradedReport(
        transcript,
        scoreInput.liveEvents,
        finalOffer,
        outcome,
        effectiveHidden.opening_anchor,
      );
    }

    // 4. Persist report + any extracted events the scorer recovered.
    await saveReport(id, report);
    const extracted = report.events.filter((e) => e.source === "llm_extract");
    if (extracted.length > 0) {
      await insertEvents(
        id,
        extracted.map((e) => ({
          type: e.type,
          actor: e.actor,
          source: "llm_extract" as const,
          payload: e.payload as Record<string, unknown>,
          at_ms: e.at_ms ?? null,
        })),
      );
    }
    if (outcome) await finishAttempt(id, outcome, finalOffer);
    else await finishAttempt(id, "stalemate", finalOffer);

    const saved = await getReport(id);
    return Response.json({
      report_id: saved.id,
      overall_score: report.overall_score,
      outcome,
    });
  },
);
