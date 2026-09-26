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
    leverageChallenges: 0,
    lastAskAmount: null,
    repeatAskCount: 0,
    lastLeverageAmount: null,
    acceptAttempts: 0,
    evidenceTags: [],
    newEvidenceThisTurn: false,
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
    leverageChallenges: s.leverageChallenges ?? 0,
    lastAskAmount: s.lastAskAmount ?? null,
    repeatAskCount: s.repeatAskCount ?? 0,
    lastLeverageAmount: s.lastLeverageAmount ?? null,
    acceptAttempts: s.acceptAttempts ?? 0,
    evidenceTags: Array.isArray(s.evidenceTags) ? s.evidenceTags : [],
    newEvidenceThisTurn: s.newEvidenceThisTurn ?? false,
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

/**
 * Evidence arguments, tagged. Only NEW arguments earn a move: replaying the
 * same claim is pressure, not evidence. Without this a candidate could chant
 * "market data" for six turns in a row and extract the whole band.
 */
const EVIDENCE_TAGS: Array<[string, RegExp]> = [
  ["market", /market|levels\.?fyi|glassdoor|indeed|median|benchmark|survey|hiring\.?cafe/i],
  ["data", /\bdata\b|research|study|report|analysis/i],
  ["scope", /scope|premium|\bexperience\b|portfolio|shipped|revenue|impact|saved|grew|\bled\b|architected|years?\b|mentor/i],
  ["performance", /performance|rating|promotion|exceeded|top performer|top of (?:my|the) band/i],
  ["leverage", /competing offer|other offer|another offer|offer in hand|competing process|other process/i],
  ["risk", /retention|\brisk\b|de-?risk|backfill|ramp|cost of (?:hiring|turnover)|attrition|bus factor/i],
  // A reasoned argument counts even when it does not name a market study.
  ["argument", /\bbecause\b|\bso that\b|which means|the reason|given that|the case for|\bwhich is why\b/i],
];

const LEVERAGE_DETAIL =
  /signed|writing|in hand|deadline|expir\w+|ending|next week|by (?:friday|monday|tuesday|wednesday|thursday|tomorrow)|start date|already (?:accepted|signed)|verbal|written/i;

/**
 * Update trust scores based on what the user just said. Deterministic, cheap,
 * and mirrored later by the LLM scorer for the report.
 */
export function updateTrustScores(
  state: EngineState,
  utterance: string,
): void {
  const t = utterance.toLowerCase();

  // Novel arguments only. Repeats are remembered (evidenceTags), so the same
  // sentence twice cannot buy two moves.
  const fresh = EVIDENCE_TAGS.filter(
    ([tag, re]) => re.test(t) && !state.evidenceTags.includes(tag),
  ).map(([tag]) => tag);
  state.newEvidenceThisTurn = fresh.length > 0;
  if (fresh.length > 0) {
    state.evidenceTags = [...state.evidenceTags, ...fresh].slice(0, 24);
    const numberBonus = /\d/.test(utterance) ? 1 : 0;
    state.justificationScore = Math.min(5, state.justificationScore + Math.min(2, fresh.length) + numberBonus);
  }

  // Leverage credibility: a bare claim is noise, and repeating the same
  // verification detail does not make it more credible than the first time.
  const hasDetail = LEVERAGE_DETAIL.test(t);
  if (hasDetail && !state.evidenceTags.includes("leverage_detail")) {
    state.evidenceTags = [...state.evidenceTags, "leverage_detail"].slice(0, 24);
    state.leverageCredibility = Math.min(1, state.leverageCredibility + 0.35);
  }
  if (/another offer|competing offer|other offer|elsewhere/i.test(t) && !hasDetail) {
    // Bare claim: bump slightly so it registers, but stays below the 0.3
    // verification bar until the candidate supplies specifics.
    state.leverageCredibility = Math.min(0.2, state.leverageCredibility + 0.2);
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
  const moved =
    next.base !== state.currentOffer.base ||
    (next.sign_on ?? 0) !== (state.currentOffer.sign_on ?? 0) ||
    (next.equity ?? 0) !== (state.currentOffer.equity ?? 0);
  state.granted.base += Math.max(0, next.base - state.currentOffer.base);
  state.granted.sign_on += Math.max(0, (next.sign_on ?? 0) - (state.currentOffer.sign_on ?? 0));
  state.granted.equity += Math.max(0, (next.equity ?? 0) - (state.currentOffer.equity ?? 0));
  state.currentOffer = next;
  state.offerCount += 1;
  // Every granted move spends one argument. A candidate has to keep bringing
  // something new, otherwise "the recruiter moves on evidence" degrades into
  // "the recruiter moves on repetition".
  if (moved) state.justificationScore = Math.max(0, state.justificationScore - 1);
  void hidden;
}

/** Prepare the state for the next user turn. */
export function advanceRound(state: EngineState): void {
  state.round += 1;
}

export { acceptanceThreshold, classifyUserMove };
