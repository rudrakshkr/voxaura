import type { AttemptRow, ScenarioRow } from "./db/queries";
import { normalizeHidden, type HiddenState } from "./types";

/**
 * Attempt/scenario hydration.
 *
 * Economics live in exactly one place: `negotiation-engine.ts`. This module used
 * to re-implement `acceptanceThreshold` with a slightly different formula
 * (unrounded, so a dollar or two off the engine's), which is precisely how a
 * panel and a directive end up disagreeing about the same scenario. The
 * duplicate is gone: anything that needs the acceptance bar imports it from the
 * engine.
 */

/** Reconstruct the base hidden state from scenario columns. */
export function hiddenOf(scenario: ScenarioRow): HiddenState {
  return normalizeHidden({
    budget: scenario.budget,
    reservation: scenario.reservation,
    target: scenario.target,
    opening_anchor: scenario.opening_anchor,
    hiring_urgency: scenario.hiring_urgency,
    flex: scenario.flex,
    persona: scenario.persona,
  });
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
  // Attempt variants were persisted at creation; normalize repairs any that
  // predate the fraction-vs-dollars fix.
  const effectiveHidden = attempt.effective_hidden
    ? normalizeHidden(attempt.effective_hidden)
    : base;
  return {
    attempt,
    scenario,
    hidden: base,
    effectiveHidden,
    agentMode: attempt.agent_mode === "inline" ? "inline" : "stored",
  };
}
