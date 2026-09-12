import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { scoreAttempt } from "@/lib/ai/score";
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
import { Outcome } from "@/lib/types";
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
    const { effectiveHidden } = hydrateAttempt(attempt, scenario);

    // 1. Freeze outcome + final offer from the client if provided; otherwise
    //    fall back to the last opponent acceptance event.
    const events = await listEvents(id);
    let outcome = body.data.outcome ?? null;
    let finalOffer = attempt.final_offer ?? null;
    if (!outcome) {
      const accepted = [...events]
        .reverse()
        .find((e) => e.type === "commitment_signal" && e.actor === "opponent");
      if (accepted) {
        outcome = "accepted";
        const p = accepted.payload as { final_base?: number; sign_on?: number; equity?: number };
        finalOffer =
          finalOffer ??
          (p.final_base
            ? { base: p.final_base, sign_on: p.sign_on ?? null, equity: p.equity ?? null }
            : null);
      }
    }

    // 2. Merge live transcript with the recorded session timeline when the
    //    client couldn't provide one (tab crash, reload).
    let transcript: TranscriptTurn[] = body.data.transcript.map((t) => ({
      role: t.role,
      text: t.text,
      interrupted: t.interrupted,
      atMs: t.at_ms ?? null,
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

    // 3. Score.
    const report = await scoreAttempt({
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
      sessionDurationSec: null,
    });

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
