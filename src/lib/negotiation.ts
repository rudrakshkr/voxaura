import { ApiError } from "./api";
import type { AttemptRow, ScenarioRow } from "./db/queries";
import type { HiddenState } from "./types";

/** Reconstruct the base hidden state from scenario columns. */
export function hiddenOf(scenario: ScenarioRow): HiddenState {
  return {
    budget: scenario.budget,
    reservation: scenario.reservation,
    target: scenario.target,
    opening_anchor: scenario.opening_anchor,
    hiring_urgency: scenario.hiring_urgency,
    flex: scenario.flex,
    persona: scenario.persona,
  };
}

export interface HydratedAttempt {
  attempt: AttemptRow;
  scenario: ScenarioRow;
  hidden: HiddenState;
  effectiveHidden: HiddenState;
  agentMode: "stored" | "inline";
}

/**
 * Load an attempt + scenario and derive the exact hidden state the opponent
 * agent was configured with. The effective variant is persisted on the attempt
 * at creation time so agent prompt and scorer always agree.
 */
export function hydrateAttempt(attempt: AttemptRow, scenario: ScenarioRow): HydratedAttempt {
  const base = hiddenOf(scenario);
  const effectiveHidden = attempt.effective_hidden ?? base;
  return {
    attempt,
    scenario,
    hidden: base,
    effectiveHidden,
    agentMode: attempt.agent_mode === "inline" ? "inline" : "stored",
  };
}

/**
 * The total-package level at which the recruiter accepts. Between target and
 * budget — deliberately above the target so creative packaging matters.
 */
export function acceptanceThreshold(hidden: HiddenState): number {
  return Math.round(hidden.target + (hidden.budget - hidden.target) * 0.55);
}

export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
