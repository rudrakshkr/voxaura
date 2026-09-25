import type { CompPackage, HiddenState } from "./types";
import {
  acceptanceThreshold,
  classifyUserMove,
  type EngineState,
} from "./negotiation-engine";

export function initialEngineState(hidden: HiddenState): EngineState {
  return {
    currentOffer: {
      base: hidden.opening_anchor,
      sign_on: 0,
      equity: 0,
    },
    granted: {
      base: 0,
      sign_on: 0,
      equity: 0,
      remote_days: 0,
      start_date_weeks: 0,
      pto_days: 0,
    },
    turnsWithoutUserMovement: 0,
    justificationScore: 0,
    leverageCredibility: 0,
    offerCount: 1,
    userAskedForInfo: false,
    leverageActive: false,
    hasRecovered: false,
    pendingDecision: false,
    round: 0,
  };
}

export function serializeEngineState(s: EngineState): Record<string, unknown> {
  return s as unknown as Record<string, unknown>;
}

export function deserializeEngineState(raw: unknown): EngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<EngineState>;
  if (!s.currentOffer || typeof s.currentOffer.base !== "number") return null;
  return {
    currentOffer: s.currentOffer,
    granted: s.granted ?? initialGrants(),
    turnsWithoutUserMovement: s.turnsWithoutUserMovement ?? 0,
    justificationScore: s.justificationScore ?? 0,
    leverageCredibility: s.leverageCredibility ?? 0,
    offerCount: s.offerCount ?? 1,
    userAskedForInfo: s.userAskedForInfo ?? false,
    leverageActive: s.leverageActive ?? false,
    hasRecovered: s.hasRecovered ?? false,
    pendingDecision: s.pendingDecision ?? false,
    round: s.round ?? 0,
  };
}

function initialGrants(): EngineState["granted"] {
  return {
    base: 0,
    sign_on: 0,
    equity: 0,
    remote_days: 0,
    start_date_weeks: 0,
    pto_days: 0,
  };
}

const EVIDENCE_WORDS =
  /market|research|levels|levels\.fyi|glassdoor|indeed|median|data|survey|benchmark|premium|experience|portfolio|shipped|revenue|impact|saved|grew|led|architected|years?\b|performance|rating|promotion|competing|offer|retention|risk|cost of (?:hiring|turnover)|backfill|ramp/i;

const LEVERAGE_DETAIL =
  /signed|writing|in hand|deadline|expir\w+|ending|next week|by (?:friday|monday|tuesday|wednesday|thursday|tomorrow)|start date|already (?:accepted|signed)|verbal|written/i;

/**
 * Update trust scores based on what the user just said. Deterministic,
 * cheap, and mirrored later by the LLM scorer for the report.
 */
export function updateTrustScores(
  state: EngineState,
  utterance: string,
): void {
  const t = utterance.toLowerCase();

  if (EVIDENCE_WORDS.test(t)) state.justificationScore = Math.min(5, state.justificationScore + 1);
  if (/\d/.test(utterance) && EVIDENCE_WORDS.test(t)) {
    state.justificationScore = Math.min(5, state.justificationScore + 1); // number + evidence
  }

  // Leverage credibility: a bare claim is noise; verification details build trust.
  if (LEVERAGE_DETAIL.test(t)) state.leverageCredibility = Math.min(1, state.leverageCredibility + 0.35);
  if (/another offer|competing offer|other offer|elsewhere/i.test(t)) {
    if (!LEVERAGE_DETAIL.test(t)) {
      // Bare claim: bump slightly so it registers, but stays below the 0.3
      // verification bar until the candidate supplies specifics.
      state.leverageCredibility = Math.min(0.2, state.leverageCredibility + 0.2);
    }
  }

  if (/what.*flexibility|any (?:room|flexibility)|sign.?on|equity|rsu|remote|start date/i.test(t)) {
    state.userAskedForInfo = true;
  }

  if (LEVERAGE_DETAIL.test(t) || /another offer|competing offer|other offer|elsewhere/i.test(t)) {
    state.leverageActive = true;
  }
  if (/going with the other|accept(?:ed|ing) the other|withdrawing|walking away/i.test(t)) {
    state.leverageActive = false;
  }
}

/** Apply a recruiter package to the engine state after a counter/trade/accept. */
export function applyRecruiterPackage(
  state: EngineState,
  hidden: HiddenState,
  next: CompPackage,
): void {
  state.granted.base += Math.max(0, next.base - state.currentOffer.base);
  state.granted.sign_on += Math.max(0, (next.sign_on ?? 0) - (state.currentOffer.sign_on ?? 0));
  state.granted.equity += Math.max(0, (next.equity ?? 0) - (state.currentOffer.equity ?? 0));
  state.currentOffer = next;
  state.offerCount += 1;
  void hidden;
}

/** Prepare the state for the next user turn. */
export function advanceRound(state: EngineState): void {
  state.round += 1;
}

export { acceptanceThreshold, classifyUserMove };
