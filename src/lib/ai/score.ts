import { z } from "zod";

import { env } from "../env";
import type {
  CompPackage,
  HiddenState,
  NegotiationEvent,
  Outcome,
  ReportData,
  TranscriptTurn,
} from "../types";
import { MoveTypeEnum } from "../db/schema";

import { callJson, LlmUnavailableError } from "./llm";
import { buildScorerPrompt } from "./prompts";

// ---------------------------------------------------------------------------
// Response schema (parsed leniently, then coerced into ReportData pieces)
// ---------------------------------------------------------------------------

const EventOut = z.object({
  type: z.string(),
  actor: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  at_ms: z.number().int().nullish(),
});

const ScorerOut = z.object({
  overall_score: z.number(),
  rubric: z.array(
    z.object({
      dimension: z.string(),
      score: z.number(),
      weight: z.number().nullish(),
      feedback: z.string(),
    }),
  ),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  summary: z.string(),
  outcome: z.string().nullish(),
  final_offer: z
    .object({
      base: z.number(),
      sign_on: z.number().nullish(),
      equity: z.number().nullish(),
    })
    .nullish(),
  events: z.array(EventOut).default([]),
});

const DIMENSION_WEIGHTS: Record<string, number> = {
  anchoring: 0.15,
  information_gathering: 0.1,
  justification: 0.15,
  concession_management: 0.15,
  package_creativity: 0.1,
  composure: 0.1,
  information_control: 0.1,
  outcome: 0.15,
};

function coerceOutcome(v: string | null | undefined): Outcome | null {
  if (v === "accepted" || v === "rejected" || v === "stalemate" || v === "walked_away") return v;
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic fallback (AI_DEBUG=1)
// ---------------------------------------------------------------------------

export function debugReport(transcript: TranscriptTurn[], liveEvents: NegotiationEvent[]): ReportData {
  return {
    overall_score: 72,
    rubric: [
      { dimension: "anchoring", score: 7, weight: 0.15, feedback: "Debug score." },
      { dimension: "information_gathering", score: 6, weight: 0.1, feedback: "Debug score." },
      { dimension: "justification", score: 7, weight: 0.15, feedback: "Debug score." },
      { dimension: "concession_management", score: 8, weight: 0.15, feedback: "Debug score." },
      { dimension: "package_creativity", score: 7, weight: 0.1, feedback: "Debug score." },
      { dimension: "composure", score: 8, weight: 0.1, feedback: "Debug score." },
      { dimension: "information_control", score: 7, weight: 0.1, feedback: "Debug score." },
      { dimension: "outcome", score: 6, weight: 0.15, feedback: "Debug score." },
    ],
    strengths: ["Debug mode: strengths are placeholders."],
    improvements: ["Debug mode: improvements are placeholders."],
    summary: "Debug-mode report generated without any LLM calls.",
    outcome: "stalemate",
    final_offer: null,
    events: liveEvents,
    transcript: transcript.map((t) => ({
      role: t.role,
      text: t.text,
      interrupted: t.interrupted,
      at_ms: t.atMs,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main scoring entry
// ---------------------------------------------------------------------------

export interface ScoreInput {
  transcript: TranscriptTurn[];
  liveEvents: NegotiationEvent[];
  hidden: HiddenState;
  prepObjective?: string;
  sessionDurationSec?: number | null;
}

export async function scoreAttempt(input: ScoreInput): Promise<ReportData> {
  if (env().AI_DEBUG) {
    return debugReport(input.transcript, input.liveEvents);
  }

  const transcriptText = input.transcript
    .map((t) => `${t.role === "user" ? "CANDIDATE" : "RECRUITER"}: ${t.text}`)
    .join("\n");

  const liveEventsText = input.liveEvents
    .map(
      (e) =>
        `- [${e.source}] ${e.actor} ${e.type} ${JSON.stringify(e.payload)}${
          e.at_ms != null ? ` @${e.at_ms}ms` : ""
        }`,
    )
    .join("\n");

  const userPrompt = `
## Rubric spec
${Object.entries(DIMENSION_WEIGHTS)
  .map(([dim, w]) => `${dim}: weight ${w}`)
  .join("\n")}

## Hidden recruiter state (for grading what was achievable)
budget=${input.hidden.budget} reservation=${input.hidden.reservation} target=${input.hidden.target} opening_anchor=${input.hidden.opening_anchor}
flex=${JSON.stringify(input.hidden.flex)}

${input.prepObjective ? `## Coaching objective for this scenario\n${input.prepObjective}\n` : ""}
## Live-captured negotiation events
${liveEventsText || "(none captured)"}

## Transcript
${transcriptText || "(empty call)"}

Score the call now. Respond with JSON only.
`.trim();

  const { content: raw, provider } = await callJson({
    system: buildScorerPrompt(),
    user: userPrompt,
    schemaName: "report",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "overall_score",
        "rubric",
        "strengths",
        "improvements",
        "summary",
        "outcome",
        "final_offer",
        "events",
      ],
      properties: {
        overall_score: { type: "number" },
        rubric: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["dimension", "score", "feedback"],
            properties: {
              dimension: { type: "string", enum: Object.keys(DIMENSION_WEIGHTS) },
              score: { type: "number" },
              feedback: { type: "string" },
            },
          },
        },
        strengths: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        outcome: { type: "string", enum: ["accepted", "rejected", "stalemate", "walked_away", "unknown"] },
        final_offer: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["base"],
              properties: {
                base: { type: "number" },
                sign_on: { type: "number" },
                equity: { type: "number" },
              },
            },
            { type: "null" },
          ],
        },
        events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "actor", "payload"],
            properties: {
              type: { type: "string", enum: MoveTypeEnum as unknown as string[] },
              actor: { type: "string", enum: ["user", "opponent"] },
              payload: { type: "object", additionalProperties: true },
              at_ms: { type: "integer" },
            },
          },
        },
      },
    },
  });
  console.info(`[score] report generated via ${provider}`);
  const out = ScorerOut.parse(JSON.parse(raw));

  // Merge live events with extracted ones (live first, extracted appended with
  // source llm_extract). Dedupe near-identical user offers on amount.
  const merged: NegotiationEvent[] = [...input.liveEvents];
  for (const e of out.events) {
    const type = MoveTypeEnum.includes(e.type as never) ? (e.type as NegotiationEvent["type"]) : null;
    if (!type) continue;
    const actor = e.actor === "user" ? "user" : "opponent";
    if (
      (type === "user_offer" || type === "opponent_offer") &&
      merged.some(
        (m) =>
          m.type === type &&
          Math.abs(Number(m.payload.amount ?? -1) - Number(e.payload.amount ?? -2)) < 1,
      )
    ) {
      continue;
    }
    merged.push({
      type,
      actor,
      source: "llm_extract",
      payload: e.payload,
      at_ms: e.at_ms ?? null,
      seq: null,
    });
  }

  const finalOffer: CompPackage | null = out.final_offer
    ? {
        base: Math.round(out.final_offer.base),
        sign_on: out.final_offer.sign_on != null ? Math.round(out.final_offer.sign_on) : null,
        equity: out.final_offer.equity != null ? Math.round(out.final_offer.equity) : null,
      }
    : null;

  const rubric = out.rubric.map((r) => ({
    dimension: r.dimension,
    score: Math.max(0, Math.min(10, r.score)),
    weight: r.weight ?? DIMENSION_WEIGHTS[r.dimension] ?? 0.1,
    feedback: r.feedback,
  }));

  return {
    overall_score: Math.max(0, Math.min(100, Math.round(out.overall_score))),
    rubric,
    strengths: out.strengths,
    improvements: out.improvements,
    summary: out.summary,
    outcome: coerceOutcome(out.outcome),
    final_offer: finalOffer,
    events: merged,
    transcript: input.transcript.map((t) => ({
      role: t.role,
      text: t.text,
      interrupted: t.interrupted,
      at_ms: t.atMs,
    })),
  };
}
