import { z } from "zod";

import { ApiError } from "../api";
import { env } from "../env";
import type { Difficulty, HiddenState, PrepPack } from "../types";

import { callJson } from "./llm";
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

const HiddenSchema = z
  .object({
    budget: z.number().int().min(60000).max(900000),
    reservation: z.number().int().min(60000).max(900000),
    target: z.number().int().min(60000).max(900000),
    opening_anchor: z.number().int().min(60000).max(900000),
    hiring_urgency: z.number().int().min(1).max(5).default(3),
    flex: FlexSchema,
    persona: PersonaSchema,
  })
  .refine((h) => h.reservation < h.target, { message: "reservation must be below target" })
  .refine((h) => h.target <= h.budget, { message: "target must not exceed budget" })
  .refine((h) => h.opening_anchor < h.reservation, {
    message: "opening anchor must leave room to negotiate up",
  });

/** All flex caps are annual US-dollar amounts — never fractions or percents. */
function normalizeGeneratedFlex(h: HiddenState): HiddenState {
  const fix = (v: number | null | undefined): number => {
    const n = v ?? 0;
    return n > 0 && n < 1000 ? Math.round((n * h.opening_anchor) / 250) * 250 : Math.round(n);
  };
  return { ...h, flex: { ...h.flex, sign_on_max: fix(h.flex.sign_on_max), equity_max: fix(h.flex.equity_max) } };
}

/** Collapse whitespace and bound a single generated string. */
function boundText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Bound the generated persona and prep text.
 *
 * Individual field schemas only check shape, so a model was free to return a
 * 40-item priorities list, 10,000-character quirks, or a scenario with eight
 * comp notes — all of which are persisted, re-served on every library read, and
 * interpolated into later prompts. Every generated string and array is bounded
 * here, after parsing, so nothing unbounded reaches the database.
 */
function boundPrepTitles(prep: PrepPack): PrepPack {
  return {
    title: boundText(prep.title, 120),
    context: boundText(prep.context, 800),
    role: boundText(prep.role, 80),
    company: boundText(prep.company, 80),
    comp_notes: (Array.isArray(prep.comp_notes) ? prep.comp_notes : [])
      .map((n) => boundText(n, 200))
      .filter((n) => n.length > 0)
      .slice(0, 8),
    coaching_objective: boundText(prep.coaching_objective, 500),
    your_target: Math.round(prep.your_target),
    your_reservation: Math.round(prep.your_reservation),
  };
}

/**
 * Make a generated hidden state internally coherent.
 *
 * The zod schema rejects impossible orderings, but only for the values exactly
 * as they arrived — before flex repair and before persona trimming. Coherence is
 * therefore re-established AFTER normalization: caps are clamped into the band,
 * the persona is bounded, and the ordering invariants (opening anchor below the
 * walk-away floor, floor below target, target within budget) are enforced. A
 * scenario that cannot be made coherent is refused rather than stored, because a
 * band where the anchor exceeds the budget makes the whole negotiation nonsense.
 */
export function repairHidden(h: HiddenState): HiddenState | null {
  const budget = Math.round(h.budget);
  const target = Math.min(Math.round(h.target), budget);
  const reservation = Math.min(Math.round(h.reservation), target - 1_000);
  const opening = Math.min(Math.round(h.opening_anchor), reservation - 1_000);
  if (!(reservation > 0 && target > 0 && opening > 0 && budget >= target)) return null;

  const persona = {
    name: boundText(h.persona?.name, 60) || "Alex Morgan",
    title: boundText(h.persona?.title, 80) || "Head of Engineering",
    style: boundText(h.persona?.style, 60) || "brisk",
    aggression: Math.min(5, Math.max(1, Math.round(h.persona?.aggression ?? 3))),
    priorities: (h.persona?.priorities ?? []).map((p) => boundText(p, 120)).filter(Boolean).slice(0, 5),
    quirks: (h.persona?.quirks ?? []).map((q) => boundText(q, 120)).filter(Boolean).slice(0, 5),
  };
  if (persona.priorities.length === 0) persona.priorities = ["budget discipline"];
  if (persona.quirks.length === 0) persona.quirks = ["moves only on evidence"];

  return {
    ...h,
    budget,
    target,
    reservation,
    opening_anchor: opening,
    hiring_urgency: Math.min(5, Math.max(1, Math.round(h.hiring_urgency ?? 3))),
    flex: {
      sign_on_max: Math.max(0, Math.min(budget, Math.round(h.flex.sign_on_max ?? 0))),
      equity_max: Math.max(0, Math.min(budget, Math.round(h.flex.equity_max ?? 0))),
      remote_days: Math.max(0, Math.min(5, Math.round(h.flex.remote_days ?? 0))),
      start_date_weeks: Math.max(0, Math.min(12, Math.round(h.flex.start_date_weeks ?? 0))),
      extra_pto_days: Math.max(0, Math.min(15, Math.round(h.flex.extra_pto_days ?? 0))),
    },
    persona,
  };
}

/**
 * The candidate's prep guidance must be coherent too: a walk-away floor at or
 * above the goal inverts the candidate's own material, and the generator returns
 * these as separate numbers with no relationship stated.
 */
function repairPrepCoherence(prep: PrepPack): PrepPack {
  const target = prep.your_target;
  let reservation = prep.your_reservation;
  if (!(reservation < target)) reservation = Math.max(60_000, target - 10_000);
  return { ...prep, your_target: target, your_reservation: reservation };
}

const PrepSchema = z.object({
  title: z.string(),
  context: z.string(),
  role: z.string(),
  company: z.string(),
  comp_notes: z.array(z.string()),
  coaching_objective: z.string(),
  your_target: z.number().int().min(60000).max(900000),
  your_reservation: z.number().int().min(60000).max(900000),
});

// ---------------------------------------------------------------------------
// Archetype variety (spec §5): shape the LLM, never hard-code numbers
// ---------------------------------------------------------------------------

const ARCHETYPES = [
  "Senior Software Engineer at a large public tech company with structured bands",
  "Staff Engineer at a well-funded startup where equity is a major lever",
  "ML Engineer at a growth-stage company racing a product launch",
  "Frontend Engineer at a smaller company with tight base but flexible culture perks",
  "Engineering Manager at a mid-size company replacing a departing lead",
  "candidate who already has a competing written offer from another company",
  "candidate with deep specialist skills but no competing offer and limited leverage",
  "candidate who values remote flexibility and start date far more than base salary",
  "Backend Engineer at a fintech with a compliance-heavy, conservative comp committee",
  "Full-stack Engineer at an agency-turned-product company with modest budgets",
];

function pickArchetype(difficulty: Difficulty, brief?: string): string {
  if (brief && brief.trim().length > 3) return brief.trim();
  // Spread archetypes across difficulties so retries feel different.
  const idx =
    difficulty === "easy"
      ? Math.floor(Math.random() * 3)
      : difficulty === "hard"
        ? 5 + Math.floor(Math.random() * 5)
        : 2 + Math.floor(Math.random() * 5);
  return ARCHETYPES[Math.min(idx, ARCHETYPES.length - 1)];
}

/**
 * The scenario builder's inputs. Every field is optional: whatever the user
 * leaves blank is left to the generator, so a two-field form still produces a
 * complete simulation while a fully filled form is honored exactly.
 */
export interface ScenarioForm {
  role?: string;
  industry?: string;
  seniority?: string;
  stage?: string;
  persona_style?: string;
  leverage?: string;
  /** Levers that must genuinely exist in the scenario (base, equity, sign-on…). */
  levers?: string[];
  notes?: string;
}

function filled(v: string | undefined | null): string | undefined {
  const s = (v ?? "").trim();
  if (!s || /^(any|none|no preference)$/i.test(s)) return undefined;
  return s;
}

/** Turn the builder's fields into a concrete archetype direction for the model. */
export function describeForm(form: ScenarioForm | undefined, difficulty: Difficulty): string {
  if (!form) return pickArchetype(difficulty);
  const role = filled(form.role);
  const seniority = filled(form.seniority);
  const industry = filled(form.industry);
  const stage = filled(form.stage);
  const style = filled(form.persona_style);
  const leverage = filled(form.leverage);
  const levers = (form.levers ?? []).map((l) => l.trim()).filter(Boolean).slice(0, 8);
  const notes = filled(form.notes);

  const bits: string[] = [];
  if (role) bits.push(`${seniority ? `${seniority} ` : ""}${role} role`);
  if (industry) bits.push(`industry: ${industry}`);
  if (stage) bits.push(`company stage: ${stage}`);
  if (levers.length > 0) bits.push(`levers that must genuinely exist: ${levers.join(", ")}`);
  if (style) bits.push(`the recruiter's personality must be ${style}`);
  if (leverage) bits.push(`the candidate already has this leverage: ${leverage}`);
  if (notes) bits.push(`extra context: ${notes}`);

  if (bits.length === 0) return pickArchetype(difficulty);
  return bits.join("; ");
}

// ---------------------------------------------------------------------------
// Deterministic debug fallback (AI_DEBUG=1) — varied by difficulty
// ---------------------------------------------------------------------------

const DEBUG_SCENARIOS: Record<
  Difficulty,
  { hidden: Omit<HiddenState, "hiring_urgency"> & { hiring_urgency: number }; prep: PrepPack }
> = {
  easy: {
    hidden: {
      budget: 172000,
      reservation: 138000,
      target: 148000,
      opening_anchor: 132000,
      hiring_urgency: 2,
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
        style: "warm",
        aggression: 2,
        priorities: ["closing quickly", "candidate happiness", "staying within band"],
        quirks: ["responds well to market data", "dislikes aggressive tactics"],
      },
    },
    prep: {
      title: "Senior Engineer offer call at Nimbus Data",
      context:
        "Nimbus Data wants you for a Senior Engineer role. Dana Reyes is calling with the offer and hoping to wrap this up quickly.",
      role: "Senior Engineer",
      company: "Nimbus Data",
      comp_notes: [
        "Base salary is the main component",
        "Sign-on bonus and annual equity refresh exist",
        "Remote days and start date may be flexible",
      ],
      coaching_objective:
        "Practice anchoring above your target and trading concessions instead of donating them.",
      your_target: 152000,
      your_reservation: 138000,
    },
  },
  medium: {
    hidden: {
      budget: 168000,
      reservation: 140000,
      target: 150000,
      opening_anchor: 131000,
      hiring_urgency: 3,
      flex: {
        sign_on_max: 12000,
        equity_max: 16000,
        remote_days: 2,
        start_date_weeks: 4,
        extra_pto_days: 3,
      },
      persona: {
        name: "Marcus Webb",
        title: "Head of Engineering",
        style: "brisk",
        aggression: 3,
        priorities: ["band integrity", "fast close", "team culture fit"],
        quirks: ["answers questions with questions", "moves only on evidence"],
      },
    },
    prep: {
      title: "Backend Engineer offer call at Ledgerline",
      context:
        "Ledgerline, a Series B fintech, wants you for a Backend Engineer role. Marcus Webb is calling with the numbers.",
      role: "Backend Engineer",
      company: "Ledgerline",
      comp_notes: [
        "Base plus annual equity grant",
        "Sign-on possible but capped",
        "Hybrid: some remote days negotiable",
      ],
      coaching_objective:
        "Get the recruiter to reveal priorities, then trade on what they value.",
      your_target: 155000,
      your_reservation: 140000,
    },
  },
  hard: {
    hidden: {
      budget: 178000,
      reservation: 146000,
      target: 154000,
      opening_anchor: 133000,
      hiring_urgency: 4,
      flex: {
        sign_on_max: 8000,
        equity_max: 10000,
        remote_days: 1,
        start_date_weeks: 2,
        extra_pto_days: 0,
      },
      persona: {
        name: "Priya Nair",
        title: "VP of Engineering",
        style: "combative",
        aggression: 4,
        priorities: ["cost discipline", "precedent protection", "proving conviction"],
        quirks: ["challenges every claim", "punishes vagueness", "respects composure"],
      },
    },
    prep: {
      title: "Analytics Lead offer call at Corvid Partners",
      context:
        "Corvid Partners, a prestigious consulting firm, wants you to lead their analytics practice. Priya Nair is calling and she is famously tough.",
      role: "Analytics Lead",
      company: "Corvid Partners",
      comp_notes: [
        "Base-heavy structure, modest equity",
        "Small sign-on flexibility",
        "Limited remote flexibility",
      ],
      coaching_objective:
        "Hold your anchor under pressure without revealing your floor. Make her move first.",
      your_target: 160000,
      your_reservation: 147500,
    },
  },
};

export function debugScenario(difficulty: Difficulty = "medium"): {
  hidden: HiddenState;
  prep: PrepPack;
} {
  const d = DEBUG_SCENARIOS[difficulty] ?? DEBUG_SCENARIOS.medium;
  return { hidden: d.hidden, prep: d.prep };
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
  /** Structured scenario-builder fields (preferred over a free-text brief). */
  form?: ScenarioForm;
}): Promise<GeneratedScenario> {
  if (env().AI_DEBUG) {
    const dbg = debugScenario(input.difficulty);
    return { hidden: dbg.hidden, prepPack: dbg.prep };
  }

  const archetype = input.brief
    ? pickArchetype(input.difficulty, input.brief)
    : describeForm(input.form, input.difficulty);
  const { content: raw, provider } = await callJson({
    system:
      "You design realistic US salary negotiation simulations (all amounts in USD per year). You invent plausible companies, roles, and compensation bands. Hidden numbers must be internally consistent: opening_anchor < reservation < target <= budget; your_target and your_reservation (the CANDIDATE's prep guidance) must overlap the company band plausibly — the candidate's target should be near or slightly above the company's target. Flex values must be consistent with the archetype (a startup gives equity, a consulting firm barely any). ALL flex values (sign_on_max, equity_max) are whole-dollar annual USD amounts — equity_max 0.05 is invalid, 12000 is valid. Prep pack must NOT leak the company's private numbers, but your_target/your_reservation are the candidate's own guidance and are expected.",
    user: `Difficulty: ${input.difficulty}. Archetype direction: ${archetype}. Honor every constraint in the direction literally — the role, industry, company stage, recruiter personality, candidate leverage and the listed levers must all be real in the simulation you invent (a listed lever must have a non-zero flex range). Invent a complete simulation with a specific invented company name (not Nimbus Data or any generic placeholder), named recruiter persona, and internally consistent economics. Respond with JSON only.`,
    schemaName: "scenario",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["hidden", "prep"],
      properties: {
        hidden: {
          type: "object",
          additionalProperties: false,
          required: [
            "budget",
            "reservation",
            "target",
            "opening_anchor",
            "hiring_urgency",
            "flex",
            "persona",
          ],
          properties: {
            budget: { type: "integer", description: "Absolute ceiling for base salary in USD" },
            reservation: { type: "integer", description: "Company walk-away floor in USD" },
            target: { type: "integer", description: "Where the recruiter wants to land in USD" },
            opening_anchor: { type: "integer", description: "The opening offer in USD" },
            hiring_urgency: { type: "integer", minimum: 1, maximum: 5, description: "1 = desperate, 5 = leisurely" },
            flex: {
              type: "object",
              additionalProperties: false,
              required: ["sign_on_max", "equity_max", "remote_days", "start_date_weeks", "extra_pto_days"],
              properties: {
            sign_on_max: { type: "integer", description: "Maximum extra sign-on bonus in annual USD (e.g. 12000) — never a fraction or percent" },
            equity_max: { type: "number", description: "Maximum annual equity value in USD per year (e.g. 15000) — never a fraction or percent like 0.05" },
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
        },
        prep: {
          type: "object",
          additionalProperties: false,
          required: ["title", "context", "comp_notes", "coaching_objective", "role", "company", "your_target", "your_reservation"],
          properties: {
            title: { type: "string" },
            context: { type: "string", description: "2-3 sentences of scene-setting for the candidate" },
            comp_notes: { type: "array", items: { type: "string" } },
            coaching_objective: { type: "string" },
            role: { type: "string" },
            company: { type: "string" },
            your_target: { type: "integer", description: "Candidate's prep target in USD" },
            your_reservation: { type: "integer", description: "Candidate's prep walk-away floor in USD" },
          },
        },
      },
    },
  });
  console.info(`[scenario] generated via ${provider}`);

  const parsed = JSON.parse(raw) as {
    hidden: HiddenState;
    prep: PrepPack;
  };

  // Normalize, then BOUND, then re-establish coherence: the schema has already
  // checked that the numbers are individually in range, but the ordering rules
  // and every string/array limit have to hold for the final value too.
  const repaired = repairHidden(normalizeGeneratedFlex(HiddenSchema.parse(parsed.hidden)));
  if (!repaired) {
    throw new ApiError(
      503,
      "The scenario generator returned incoherent economics. Try generating again.",
    );
  }
  const prepPack = repairPrepCoherence(boundPrepTitles(PrepSchema.parse(parsed.prep)));

  return { hidden: repaired, prepPack };
}

// ---------------------------------------------------------------------------
// Retry variants: SAME core economics (spec §12) — only persona pressure changes
// ---------------------------------------------------------------------------

export function deriveVariant(
  hidden: HiddenState,
  opts: { harder?: boolean; reRoll?: boolean },
): HiddenState {
  if (opts.harder) {
    // Harder = more resistant recruiter. Economics (budget/reservation/target/
    // anchor) are untouched so the underlying problem is identical.
    return {
      ...hidden,
      persona: {
        ...hidden.persona,
        aggression: Math.min(5, hidden.persona.aggression + 1) as 1 | 2 | 3 | 4 | 5,
        style:
          hidden.persona.aggression >= 4
            ? "stone-walled and terse"
            : hidden.persona.style,
        quirks: [
          ...new Set([
            ...hidden.persona.quirks,
            "concedes only with strong evidence",
            "counters with questions before numbers",
          ]),
        ].slice(0, 5),
      },
      hiring_urgency: Math.min(5, hidden.hiring_urgency + 1),
    };
  }
  // reroll: same economics, persona color varies for a fresh conversational run.
  if (opts.reRoll) {
    const styles = ["warm", "brisk", "poker-face", "avuncular", "combative"];
    const newStyle = styles[Math.floor(Math.random() * styles.length)];
    const names = ["Jordan Hale", "Sam Okafor", "Riley Chen", "Morgan Diaz", "Alex Ferreira"];
    const newName = names[Math.floor(Math.random() * names.length)];
    return {
      ...hidden,
      persona: {
        ...hidden.persona,
        name: newName,
        style: newStyle,
        quirks: [
          ...new Set([...hidden.persona.quirks, "opens with a different framing"]),
        ].slice(0, 5),
      },
    };
  }
  return hidden;
}

/**
 * Build the stored-agent system prompt for a scenario/variant. Scenario facts
 * (company/role/level/situation) are public prep data; without them the voice
 * model invents employers and roles mid-call.
 */
export function agentPromptFor(
  hidden: HiddenState,
  facts?: { company: string; role: string; level: string; context?: string | null },
): string {
  return buildOpponentPrompt(hidden, facts);
}
