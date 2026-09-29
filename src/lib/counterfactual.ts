import {
  advanceRound,
  applyRecruiterPackage,
  initialEngineState,
  updateTrustScores,
} from "./engine-state";
import {
  classifyUserMove,
  closingOutcome,
  decideRecruiterMove,
  packageEnvelope,
  total,
  type EngineState,
  type RecruiterMove,
} from "./negotiation-engine";
import type { CompPackage, HiddenState, Outcome } from "./types";

/**
 * Counterfactual negotiation simulation.
 *
 * After a call, the interesting question is never "what score did I get" — it is
 * "what would have happened if I had done that differently". Answering it with
 * an LLM would be a story. Answering it with the SAME deterministic engine that
 * ran the live call is a measurement: the alternative is played against the
 * identical hidden economics, with the same concession rules, the same deadlock
 * rule and the same acceptance predicate the recruiter used in the real call.
 *
 * So this module contains no economics of its own. It scripts what the
 * candidate did differently and lets `decideRecruiterMove` respond, exactly as
 * it did during the call. Results are labeled as modeling in the UI, because a
 * simulated outcome is a modeled answer to "what if", not a promise.
 *
 * Everything here is pure and synchronous, which is what makes it testable.
 */

export interface CounterfactualPlan {
  /** Stable key, so the UI and tests can refer to a plan by name. */
  key: string;
  label: string;
  summary: string;
  /** Base figure the candidate anchors at (null = no anchor statement). */
  anchor: number | null;
  /** Verified competing figure, announced on round 0. */
  leverageAmount: number | null;
  /** Round at which the candidate walks. */
  walkAwayAtRound: number | null;
  /** Accept the standing package once its first-year total clears this. */
  acceptAtOrAboveTotal: number | null;
  /** Take the opening offer immediately, no negotiation. */
  acceptImmediately: boolean;
}

export interface CounterfactualResult {
  plan: CounterfactualPlan;
  finalPackage: CompPackage;
  finalTotal: number;
  finalBase: number;
  outcome: Outcome;
  rounds: number;
  /** The scripted candidate lines, for an auditable read of the simulation. */
  turns: string[];
}

/** Rounds a simulated call may run before it is called a stalemate. */
const MAX_SIM_ROUNDS = 14;
/** Anchors are allowed a little above the envelope — the recruiter still refuses. */
const ANCHOR_HEADROOM = 25_000;

/**
 * Play one alternative strategy against a scenario's hidden economics.
 * Deterministic: same plan + same hidden state ⇒ same result, every time.
 */
export function simulatePlan(hidden: HiddenState, plan: CounterfactualPlan): CounterfactualResult {
  const state: EngineState = initialEngineState(hidden);
  const turns: string[] = [];
  const anchorCap = packageEnvelope(hidden) + ANCHOR_HEADROOM;
  const anchor = plan.anchor == null ? null : Math.min(anchorCap, Math.max(0, plan.anchor));

  const say = (text: string): RecruiterMove => {
    const classification = classifyUserMove(text);
    updateTrustScores(state, text);
    const move = decideRecruiterMove({
      hidden,
      state,
      classification,
      recentUserMoves: [classification.primary],
    });
    if ("package" in move && move.package) {
      applyRecruiterPackage(state, hidden, move.package as CompPackage);
    }
    advanceRound(state);
    turns.push(text);
    return move;
  };

  let outcome: Outcome = "stalemate";
  let rounds = 0;

  const ACCEPT_LINE = "We have a deal — I'll accept that package.";
  /**
   * Would this candidate say yes to what is on the table right now?
   *
   * Stated as a rule rather than a one-off: a candidate who has decided to close
   * KEEPS saying yes until they are answered, which is exactly the path the
   * engine honours (a genuine yes is never stonewalled). That keeps the
   * simulation faithful to the live rules instead of inventing a shortcut.
   */
  const wantsToAccept = (): boolean =>
    plan.acceptImmediately ||
    (plan.acceptAtOrAboveTotal != null && total(state.currentOffer) >= plan.acceptAtOrAboveTotal);

  for (let round = 0; round < MAX_SIM_ROUNDS; round++) {
    rounds = round + 1;

    let text: string;
    if (wantsToAccept()) {
      text = ACCEPT_LINE;
    } else if (plan.leverageAmount != null && round === 0) {
      text = `I have a signed competing offer in writing for ${plan.leverageAmount}, expiring Friday.`;
    } else if (plan.walkAwayAtRound != null && round === plan.walkAwayAtRound) {
      text = "I'm going to walk away and take the other offer.";
    } else if (round === 0) {
      text =
        anchor == null
          ? "I'd like to talk through the package before we settle."
          : `I'm looking for ${anchor} base — market data for this scope supports that number.`;
    } else {
      text =
        anchor == null
          ? "I'm still hoping we can find a better number for the package."
          : `I'm holding at ${anchor} base; the market data for this scope still supports it.`;
    }

    const move = say(text);

    if (move.kind === "accept") {
      outcome = "accepted";
      break;
    }
    const close = closingOutcome(move);
    if (close) {
      outcome = close;
      break;
    }
  }

  return {
    plan,
    finalPackage: state.currentOffer,
    finalTotal: total(state.currentOffer),
    finalBase: state.currentOffer.base,
    outcome,
    rounds,
    turns,
  };
}

export interface PlanContext {
  /** The candidate's own prep target, when the scenario has one. */
  prepTarget?: number | null;
  /** The candidate's own prep walk-away figure. */
  prepReservation?: number | null;
  /** First-year total actually agreed/final in the real call, for labeling. */
  actualTotal?: number | null;
}

/**
 * The alternatives worth showing. Each one is a *behavior*, not a number the
 * user tunes: judges and candidates both understand "anchor higher" or "lead
 * with leverage", and every plan is honest about what it changes.
 */
export function buildPlans(hidden: HiddenState, ctx: PlanContext = {}): CounterfactualPlan[] {
  const target = ctx.prepTarget ?? Math.round(hidden.target + (hidden.budget - hidden.target) * 0.4);
  const bar = Math.max(hidden.reservation, ctx.prepReservation ?? hidden.reservation);
  const leverage = Math.min(
    packageEnvelope(hidden) + 15_000,
    Math.max(target + 5_000, hidden.opening_anchor + 20_000),
  );

  const plans: CounterfactualPlan[] = [
    {
      key: "anchor_higher_10k",
      label: "Anchored $10k higher",
      summary: `Open at ${(hidden.opening_anchor + 10_000).toLocaleString("en-US")} instead of the recruiter's number.`,
      anchor: hidden.opening_anchor + 10_000,
      leverageAmount: null,
      walkAwayAtRound: null,
      acceptAtOrAboveTotal: bar,
      acceptImmediately: false,
    },
    {
      key: "anchor_at_target",
      label: "Anchored at your prep target",
      summary: `Open at your own target (${target.toLocaleString("en-US")}) with market justification.`,
      anchor: target,
      leverageAmount: null,
      walkAwayAtRound: null,
      acceptAtOrAboveTotal: bar,
      acceptImmediately: false,
    },
    {
      key: "lead_with_leverage",
      label: "Led with real leverage",
      summary: `Announce a signed competing offer at ${leverage.toLocaleString("en-US")} on the first turn.`,
      anchor: target,
      leverageAmount: leverage,
      walkAwayAtRound: null,
      acceptAtOrAboveTotal: bar,
      acceptImmediately: false,
    },
    {
      key: "walk_away_early",
      label: "Walked away at the first hold",
      summary: "Pushed to the point of walking on round two instead of continuing to negotiate.",
      anchor: target,
      leverageAmount: null,
      walkAwayAtRound: 2,
      acceptAtOrAboveTotal: bar,
      acceptImmediately: false,
    },
    {
      key: "accept_opening",
      label: "Accepted the first number",
      summary: "Said yes to the opening package instead of negotiating it.",
      anchor: null,
      leverageAmount: null,
      walkAwayAtRound: null,
      acceptAtOrAboveTotal: null,
      acceptImmediately: true,
    },
  ];

  // Only offer alternatives that are actually different from one another — an
  // anchor already at the target makes "anchor higher" pointless noise.
  const seen = new Set<string>();
  return plans.filter((p) => {
    const sig = `${p.anchor ?? "-"}:${p.leverageAmount ?? "-"}:${p.walkAwayAtRound ?? "-"}:${p.acceptImmediately}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export interface CounterfactualReport {
  actual: { total: number; base: number; outcome: Outcome | null } | null;
  results: Array<CounterfactualResult & { deltaTotal: number; deltaBase: number }>;
  /** Explicit, so no UI can present this as a guaranteed outcome. */
  disclaimer: string;
}

export function runCounterfactuals(
  hidden: HiddenState,
  ctx: PlanContext & { actual?: { total: number; base: number; outcome: Outcome | null } | null } = {},
): CounterfactualReport {
  const actual = ctx.actual ?? null;
  const results = buildPlans(hidden, ctx).map((plan) => {
    const result = simulatePlan(hidden, plan);
    return {
      ...result,
      deltaTotal: actual ? result.finalTotal - actual.total : result.finalTotal,
      deltaBase: actual ? result.finalBase - actual.base : result.finalBase,
    };
  });
  return {
    actual,
    results,
    disclaimer:
      "Modeled, not guaranteed: each alternative is replayed against this scenario's exact negotiation rules and economics. Real recruiters, markets and timing differ.",
  };
}
