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

import { callJson } from "./llm";
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
  overall_score: z.number().nullish(),
  rubric: z.array(
    z.object({
      dimension: z.string(),
      score: z.number(),
      feedback: z.string().default(""),
    }),
  ),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  // Lenient: small models in json_object mode sometimes drop optional-ish fields.
  summary: z.string().default(""),
  communication: z
    .object({
      clarity: z.string().default(""),
      confidence: z.string().default(""),
      composure: z.string().default(""),
      rapport: z.string().default(""),
    })
    .nullish(),
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
  anchoring: 0.2,
  leverage: 0.2,
  information_control: 0.2,
  concession_management: 0.2,
  outcome: 0.2,
};

/** Weight for a rubric dimension, tolerant of display-name variants. */
function dimensionWeight(dimension: string): number {
  const key = dimension.toLowerCase().replace(/\s+/g, "_");
  return DIMENSION_WEIGHTS[key] ?? 0.2;
}

function coerceOutcome(v: string | null | undefined): Outcome | null {
  if (v === "accepted" || v === "rejected" || v === "stalemate" || v === "walked_away") return v;
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic fallback (AI_DEBUG=1)
// ---------------------------------------------------------------------------

export function debugReport(
  transcript: TranscriptTurn[],
  liveEvents: NegotiationEvent[],
  finalOffer: CompPackage | null,
  outcome: Outcome | null,
): ReportData {
  return {
    overall_score: 72,
    rubric: [
      { dimension: "anchoring", score: 7, weight: 0.2, feedback: "Debug score — add API keys for evidence-based coaching." },
      { dimension: "leverage", score: 6, weight: 0.2, feedback: "Debug score." },
      { dimension: "information_control", score: 7, weight: 0.2, feedback: "Debug score." },
      { dimension: "concession_management", score: 7, weight: 0.2, feedback: "Debug score." },
      { dimension: "outcome", score: 6, weight: 0.2, feedback: "Debug score." },
    ],
    strengths: ["Debug mode: strengths are placeholders."],
    improvements: ["Debug mode: improvements are placeholders."],
    communication: {
      clarity: "Debug placeholder.",
      confidence: "Debug placeholder.",
      composure: "Debug placeholder.",
      rapport: "Debug placeholder.",
    },
    summary: "Debug-mode report generated without any LLM calls.",
    outcome: outcome ?? "stalemate",
    final_offer: finalOffer,
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
  /** Server-authoritative final package (engine state), if any. */
  finalOffer: CompPackage | null;
  /** Server-authoritative outcome, if known. */
  outcome: Outcome | null;
  openingOfferBase: number;
}

export async function scoreAttempt(input: ScoreInput): Promise<ReportData> {
  if (env().AI_DEBUG) {
    return debugReport(input.transcript, input.liveEvents, input.finalOffer, input.outcome);
  }

  const transcriptText = input.transcript
    .map(
      (t, i) =>
        `${t.role === "user" ? "CANDIDATE" : "RECRUITER"} [${i}]: ${t.text}${
          t.interrupted ? " (interrupted)" : ""
        }`,
    )
    .join("\n");

  const liveEventsText = input.liveEvents
    .map(
      (e) =>
        `- [${e.source}] ${e.actor} ${e.type}${
          e.payload.amount != null ? ` $${e.payload.amount}` : ""
        }${e.payload.package ? ` pkg=${JSON.stringify(e.payload.package)}` : ""}${
          e.payload.note ? ` — ${String(e.payload.note).slice(0, 120)}` : ""
        }`,
    )
    .join("\n");

  const finalPkg = input.finalOffer
    ? `base $${input.finalOffer.base.toLocaleString()}${
        input.finalOffer.sign_on ? `, sign-on $${input.finalOffer.sign_on.toLocaleString()}` : ""
      }${input.finalOffer.equity ? `, equity $${input.finalOffer.equity.toLocaleString()}/yr` : ""}`
    : "no final package was agreed";

  const userPrompt = `
## Hidden recruiter state (for judging what was achievable — never reveal to the candidate)
budget=${input.hidden.budget} reservation=${input.hidden.reservation} target=${input.hidden.target} opening_anchor=${input.hidden.opening_anchor}

## Recruiter's opening offer
base $${input.openingOfferBase.toLocaleString()}

## Final package (server-verified)
${finalPkg}

## Outcome (server-verified)
${input.outcome ?? "not set"}

${input.prepObjective ? `## Coaching objective for this scenario\n${input.prepObjective}\n` : ""}
## Canonical event timeline (detected live)
${liveEventsText || "(none captured)"}

## Full transcript
${transcriptText || "(empty call)"}

Score the CANDIDATE now. Every dimension feedback MUST cite or closely paraphrase a specific candidate moment from the transcript. Respond with JSON only.
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
        "communication",
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
        communication: {
          type: "object",
          additionalProperties: false,
          required: ["clarity", "confidence", "composure", "rapport"],
          properties: {
            clarity: { type: "string" },
            confidence: { type: "string" },
            composure: { type: "string" },
            rapport: { type: "string" },
          },
        },
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

  // Defensive: repair-tolerant parse (small models sometimes drop fields).
  const parsedJson = JSON.parse(raw) as Record<string, unknown>;
  const out = ScorerOut.parse({
    strengths: [],
    improvements: [],
    rubric: [],
    ...parsedJson,
  });
  // Ensure every rubric dimension required by the report exists.
  const requiredDims = ["Anchoring", "Leverage", "Information Control", "Concession Management", "Outcome"];
  for (const dim of requiredDims) {
    if (!out.rubric.some((d) => d.dimension.toLowerCase().includes(dim.toLowerCase().split(" ")[0]))) {
      out.rubric.push({
        dimension: dim,
        score: 5,
        feedback: "Not assessed by the scorer model; defaulted to neutral.",
      });
    }
  }

  // When the model omits strengths/improvements/communication (common with
  // smaller models or json_object fallback), build them from the rubric so the
  // report page never renders empty sections.
  if (out.strengths.length === 0) {
    out.strengths = out.rubric
      .filter((r) => r.score >= 6)
      .map((r) => `Strong ${r.dimension}: ${r.feedback}`);
    if (out.strengths.length === 0) out.strengths.push("Complete negotiation attempt — review the dimension scores for specifics.");
  }
  if (out.improvements.length === 0) {
    out.improvements = out.rubric
      .filter((r) => r.score < 6)
      .map((r) => `Work on ${r.dimension}: ${r.feedback}`);
    if (out.improvements.length === 0) out.improvements.push("Continued practice — review the dimension scores for areas to develop.");
  }
  if (!out.communication || (out.communication.clarity === "" && out.communication.confidence === "" && out.communication.composure === "" && out.communication.rapport === "")) {
    const lowDims = out.rubric.filter((r) => r.score < 6).map((r) => r.dimension.toLowerCase());
    out.communication = {
      clarity: lowDims.some((d) => d.includes("information")) ? "You shared numbers before fully understanding the recruiter's flexibility — state your ask first, then ask what they can do." : "Your statements were understandable; keep answers short and direct on a live call.",
      confidence: out.rubric.some((r) => r.score >= 6) ? "You made concrete asks and held your position — carry that same specificity into the next call." : "Speak in full sentences and avoid hedging phrases like 'maybe' or 'I was hoping.' State numbers directly.",
      composure: "Stay calm when the recruiter pushes back — a pause before responding reads as deliberation, not hesitation.",
      rapport: "Acknowledge the recruiter's constraints briefly before making your next ask; it keeps the exchange collaborative.",
    };
  }

  // Merge live events with extracted ones (live first, extracted appended).
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

  const finalOffer: CompPackage | null =
    input.finalOffer ??
    (out.final_offer
      ? {
          base: Math.round(out.final_offer.base),
          sign_on: out.final_offer.sign_on != null ? Math.round(out.final_offer.sign_on) : null,
          equity: out.final_offer.equity != null ? Math.round(out.final_offer.equity) : null,
        }
      : null);

  const rubric = out.rubric.map((r) => ({
    dimension: r.dimension,
    score: Math.max(0, Math.min(10, r.score)),
    weight: dimensionWeight(r.dimension),
    feedback: r.feedback,
  }));

  // Overall: model-provided when present, otherwise computed from the rubric
  // (each dimension is 0–10 → average × 10 = 0–100).
  const overall =
    out.overall_score ??
    (rubric.length
      ? Math.round((rubric.reduce((s, d) => s + d.score, 0) / rubric.length) * 10)
      : 0);

  return {
    overall_score: Math.max(0, Math.min(100, Math.round(overall))),
    rubric,
    strengths: out.strengths,
    improvements: out.improvements,
    communication: out.communication ?? { clarity: "", confidence: "", composure: "", rapport: "" },
    summary: out.summary,
    outcome: input.outcome ?? coerceOutcome(out.outcome),
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
