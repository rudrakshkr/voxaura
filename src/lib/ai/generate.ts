import { z } from "zod";

import { env } from "../env";
import type { Difficulty, HiddenState, PrepPack } from "../types";

import { callJson, LlmUnavailableError } from "./llm";
import { buildOpponentPrompt } from "./prompts";

// ---------------------------------------------------------------------------
// Schemas the model must fill (strict JSON via json_schema)
// ---------------------------------------------------------------------------

const FlexSchema = z.object({
  sign_on_max: z.number().int().min(0),
  equity_max: z.number().min(0),
  remote_days: z.number().int().min(0).max(5),
  start_date_weeks: z.number().int().min(0).max(12),
  extra_pto_days: z.number().int().min(0).max(15),
});

const PersonaSchema = z.object({
  name: z.string(),
  title: z.string(),
  style: z.string(),
  aggression: z.number().int().min(1).max(5),
  priorities: z.array(z.string()),
  quirks: z.array(z.string()),
});

const HiddenSchema = z.object({
  budget: z.number().int().min(40000).max(900000),
  reservation: z.number().int().min(40000).max(900000),
  target: z.number().int().min(40000).max(900000),
  opening_anchor: z.number().int().min(40000).max(900000),
  flex: FlexSchema,
  persona: PersonaSchema,
});

const PrepSchema = z.object({
  title: z.string(),
  context: z.string(),
  comp_notes: z.array(z.string()),
  coaching_objective: z.string(),
});

// ---------------------------------------------------------------------------
// Deterministic debug fallback (AI_DEBUG=1) so UI work needs no API keys
// ---------------------------------------------------------------------------

export function debugScenario(): {
  hidden: HiddenState;
  prep: Omit<PrepPack, "role" | "company"> & { title: string };
} {
  return {
    hidden: {
      budget: 172000,
      reservation: 138000,
      target: 148000,
      opening_anchor: 132000,
      flex: {
        sign_on_max: 15000,
        equity_max: 12000,
        remote_days: 3,
        start_date_weeks: 6,
        extra_pto_days: 5,
      },
      persona: {
        name: "Dana Reyes",
        title: "Director of Engineering",
        style: "brisk",
        aggression: 3,
        priorities: ["staying within band", "fast close", "team culture fit"],
        quirks: ["responds well to market data", "gets impatient with rambling"],
      },
    },
    prep: {
      title: "Senior Engineer offer call at Nimbus Data",
      context:
        "You just received good news: Nimbus Data wants to extend an offer for a Senior Engineer role. Dana Reyes, Director of Engineering, is calling to walk through compensation.",
      comp_notes: [
        "Base salary is the main component",
        "Sign-on bonus and annual equity refresh are negotiable levers",
        "Remote days and start date may be flexible",
      ],
      coaching_objective:
        "Practice anchoring above your target and trading concessions instead of donating them.",
    },
  };
}

// ---------------------------------------------------------------------------
// LLM generation
// ---------------------------------------------------------------------------

export interface GeneratedScenario {
  hidden: HiddenState;
  prepPack: PrepPack;
}

export async function generateScenario(input: {
  difficulty: Difficulty;
  /** Brief user steer, e.g. "nonprofit startup, first job out of bootcamp". */
  brief?: string;
}): Promise<GeneratedScenario> {
  if (env().AI_DEBUG) {
    const d = debugScenario();
    return {
      hidden: d.hidden,
      prepPack: {
        role: "Senior Engineer",
        company: "Nimbus Data",
        ...d.prep,
      },
    };
  }

  const { content: raw, provider } = await callJson({
    system:
      "You design realistic salary negotiation simulations. You invent plausible companies, roles, and compensation bands (USD, annual). Hidden numbers must be internally consistent: reservation < target <= budget, opening_anchor between reservation and target. Prep pack must NOT leak hidden numbers or the persona's private constraints.",
    user: `Difficulty: ${input.difficulty}. ${
      input.brief ? `Extra direction: ${input.brief}.` : ""
    } Invent a complete simulation. Respond with JSON only.`,
    schemaName: "scenario",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["hidden", "prep"],
      properties: {
        hidden: HiddenZodToJson(),
        prep: {
          type: "object",
          additionalProperties: false,
          required: ["title", "context", "comp_notes", "coaching_objective", "role", "company"],
          properties: {
            title: { type: "string" },
            context: { type: "string", description: "2-3 sentences of scene-setting for the candidate" },
            comp_notes: { type: "array", items: { type: "string" } },
            coaching_objective: { type: "string" },
            role: { type: "string" },
            company: { type: "string" },
          },
        },
      },
    },
  });
  console.info(`[scenario] generated via ${provider}`);

  const parsed = JSON.parse(raw) as {
    hidden: HiddenState;
    prep: {
      title: string;
      context: string;
      comp_notes: string[];
      coaching_objective: string;
      role: string;
      company: string;
    };
  };

  const hidden = HiddenSchema.parse(parsed.hidden);
  const prepPack: PrepPack = {
    role: parsed.prep.role,
    company: parsed.prep.company,
    title: parsed.prep.title,
    context: parsed.prep.context,
    comp_notes: parsed.prep.comp_notes,
    coaching_objective: parsed.prep.coaching_objective,
  };

  return { hidden, prepPack };
}

// ---------------------------------------------------------------------------
// Retry variants: re-roll hidden numbers with slight variance + harder persona
// ---------------------------------------------------------------------------

export function deriveVariant(
  hidden: HiddenState,
  opts: { harder?: boolean; reRoll?: boolean },
): HiddenState {
  const jitter = (n: number, pct: number) => Math.round(n * (1 + (Math.random() * 2 - 1) * pct));

  const reRolled: HiddenState = opts.reRoll
    ? {
        ...hidden,
        budget: jitter(hidden.budget, 0.04),
        reservation: jitter(hidden.reservation, 0.05),
        target: jitter(hidden.target, 0.05),
        opening_anchor: jitter(hidden.opening_anchor, 0.05),
      }
    : hidden;

  if (!opts.harder) return reRolled;

  return {
    ...reRolled,
    reservation: Math.min(
      reRolled.budget - 2000,
      Math.round(reRolled.reservation * 1.05),
    ),
    persona: {
      ...reRolled.persona,
      aggression: Math.min(5, reRolled.persona.aggression + 1) as 1 | 2 | 3 | 4 | 5,
      style: reRolled.persona.style === "combative" ? "stone-walled and terse" : reRolled.persona.style,
    },
  };
}

/** Build the stored-agent system prompt for a scenario/variant. */
export function agentPromptFor(hidden: HiddenState): string {
  return buildOpponentPrompt(hidden);
}

// Keep a local JSON-schema mirror of HiddenSchema for strict responses.
function HiddenZodToJson(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["budget", "reservation", "target", "opening_anchor", "flex", "persona"],
    properties: {
      budget: { type: "integer", description: "Absolute ceiling for base salary in USD" },
      reservation: { type: "integer", description: "Walk-away floor in USD" },
      target: { type: "integer", description: "Where the recruiter wants to land in USD" },
      opening_anchor: { type: "integer", description: "The opening offer in USD" },
      flex: {
        type: "object",
        additionalProperties: false,
        required: ["sign_on_max", "equity_max", "remote_days", "start_date_weeks", "extra_pto_days"],
        properties: {
          sign_on_max: { type: "integer" },
          equity_max: { type: "number" },
          remote_days: { type: "integer" },
          start_date_weeks: { type: "integer" },
          extra_pto_days: { type: "integer" },
        },
      },
      persona: {
        type: "object",
        additionalProperties: false,
        required: ["name", "title", "style", "aggression", "priorities", "quirks"],
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          style: { type: "string", description: "warm, brisk, poker-face, combative, or avuncular" },
          aggression: { type: "integer", minimum: 1, maximum: 5 },
          priorities: { type: "array", items: { type: "string" } },
          quirks: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}
