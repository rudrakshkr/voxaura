import type { CompPackage, HiddenState, MoveType } from "./types";

/**
 * Deterministic negotiation strategy engine (P0).
 *
 * The LLM voices the recruiter; THIS module owns the economics. Each turn:
 *  1. `classifyUserMove` heuristically classifies the user utterance.
 *  2. `decideRecruiterMove` applies hard economic rules to pick the move.
 *  3. `buildDirective` ships the verdict to the voice LLM as a binding
 *     directive. Raw numbers the model may speak are whitelisted — anything
 *     not in the list must not be said, so hidden state can never leak.
 *
 * Nothing here calls an LLM; it is fully testable.
 */

// ---------------------------------------------------------------------------
// User move classification (heuristic, pre-LLM, server-side)
// ---------------------------------------------------------------------------

export interface UserMoveClassification {
  primary: MoveType;
  /** Mentions of another offer / external options. */
  leverage: { present: boolean; amount: number | null; vague: boolean };
  /** Stated acceptance floors: "I couldn't go below X", "I need at least X". */
  reservationReveal: number | null;
  /** Concrete numeric asks (max number spoken that plausibly is an ask). */
  askedAmount: number | null;
  /** Asks for information about flexibility/components. */
  informationRequest: boolean;
  /** Signals intending to accept / close: "we have a deal", "I can commit". */
  commitmentSignal: boolean;
  /** Signals walking away / rejecting. */
  walkAwaySignal: boolean;
  /** Asks about a decision the recruiter previously deferred ("what did the team say?"). */
  decisionRequest: boolean;
  /** Talked over the recruiter (server marks separately, mirrored here). */
  interruption: boolean;
}

const BASE_RE =
  /\$?\s?(\d{2,3})(?:[,.](\d{1,3}))?\s?(?:k\b|thousand|grand|,\d{3}|\.\d{3})?/gi;

function extractAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(BASE_RE)) {
    const hundreds = parseInt(m[1], 10);
    const frac = m[2] ? parseInt(m[1] + m[2].padEnd(3, "0"), 10) : null;
    let val: number;
    if (/k\b|thousand|grand/i.test(m[0])) val = hundreds * 1000;
    else if (frac !== null && frac >= 40000) val = frac;
    else if (hundreds >= 40) val = hundreds * 1000; // "145" → 145k
    else val = frac ?? hundreds * 1000;
    if (val >= 40000 && val <= 990000) out.push(val);
  }
  return out;
}

export function classifyUserMove(
  text: string,
  opts: { userInterrupted?: boolean } = {},
): UserMoveClassification {
  const t = text.toLowerCase();
  const amounts = extractAmounts(text);

  const leverage = {
    present: /another offer|other offer|competing offer|counter.?offer from|other company|elsewhere|another company|competing offer|other process|in stage|final rounds? (?:with|at)/.test(t),
    amount: amounts.length ? amounts[amounts.length - 1] : null,
    vague: /another offer|competing offer|elsewhere/.test(t) && amounts.length === 0,
  };

  const reservationReveal = (() => {
    const m = t.match(
      /(?:would accept|could accept|i'?d take|would need at least|need at least|can'?t go below|couldn'?t go below|at minimum|minimum i|floor is|bottom line is)[^\d$]{0,15}\$?\s?([\d,.]{3,9})\s*(k|thousand|grand)?/,
    );
    if (m) {
      const digits = m[1].replace(/[,.]/g, "");
      let v: number;
      if (m[2]) v = parseInt(digits, 10) * 1000;
      else {
        const n = parseInt(digits, 10);
        v = n >= 40000 ? n : n * 1000;
      }
      if (v >= 40000) return v;
    }
    return null;
  })();

  const informationRequest =
    /what(?:'s| is) your|how much flexibility|any flexibility|any room|room to move|willing to go|range (?:for|on) (?:base|salary)|what can you do|what(?:'s| is) possible|sign.?on|equity|stock|rsu|remote|start date|pto|vacation|benefits|bonus/.test(t) ||
    /flexibility/.test(t);

  const commitmentSignal =
    /we have a deal|we'?ve got a deal|sounds? like a deal|i'?m happy with|let'?s do it|i accept|i can commit|i'?m ready to sign|that works for me|deal\.?$|happy to accept|would be happy to|gladly accept|sign today|accept (?:that|this|the) offer/.test(t);

  const walkAwaySignal =
    /walk away|walking away|not a fit|not the right fit|go(?:ing)? with (?:the )?other|accept the other|decline|turn(?:ing)? (?:you |this )?down|not going to (?:be able to|work)|can'?t accept|cannot accept|not interested|pass on (?:this|the) (?:role|offer)|withdraw/.test(t);

  // "What did the team say?" — the candidate is chasing a decision the
  // recruiter already promised. Must be answered, never deferred again.
  const decisionRequest =
    /what did (?:the|they|your|his|her) (?:team|leadership|committee|manager|board|vp|boss)\b|what(?:'s| is| was) the (?:decision|verdict|word|answer)\b|any (?:news|word|update|progress|feedback)\b|did (?:the|they|your) \w* ?(?:team|leadership|committee) (?:say|approve|get back|come back)|did you (?:hear|talk to|speak with|check)\b|come back with|following up\b|checking (?:back )?in\b|any luck\b/.test(
      t,
    );

  // Primary classification precedence.
  let primary: MoveType;
  if (walkAwaySignal) primary = "walk_away";
  else if (commitmentSignal && leverage.present) primary = "user_offer";
  else if (commitmentSignal) primary = "acceptance";
  else if (decisionRequest) primary = "information_request";
  else if (reservationReveal) primary = "information_revealed";
  else if (leverage.present) primary = "leverage_introduced";
  else if (amounts.length > 0) primary = "user_offer";
  else if (informationRequest) primary = "information_request";
  else primary = "rapport";

  return {
    primary,
    leverage,
    reservationReveal,
    askedAmount: amounts.length ? amounts[amounts.length - 1] : null,
    informationRequest,
    commitmentSignal,
    walkAwaySignal,
    decisionRequest,
    interruption: Boolean(opts.userInterrupted),
  };
}

// ---------------------------------------------------------------------------
// Recruiter economic decision (deterministic)
// ---------------------------------------------------------------------------

export interface EngineState {
  currentOffer: CompPackage;
  /** Deltas already granted on each lever (from opening). */
  granted: {
    base: number;
    sign_on: number;
    equity: number;
    remote_days: number;
    start_date_weeks: number;
    pto_days: number;
  };
  turnsWithoutUserMovement: number;
  justificationScore: number;
  leverageCredibility: number; // 0..1
  offerCount: number;
  userAskedForInfo: boolean;
  /** True once the user has claimed competing leverage; stays until walk-away. */
  leverageActive: boolean;
  /** One best-and-final recovery is allowed per attempt. */
  hasRecovered: boolean;
  /**
   * True when the recruiter verbally deferred to an internal team. The next
   * time the candidate asks what the team said, the engine MUST land a real
   * decision instead of deferring again.
   */
  pendingDecision: boolean;
  round: number;
}

export type RecruiterMove =
  | { kind: "hold_firm"; final?: boolean }
  | { kind: "challenge_leverage" }
  | { kind: "counter"; package: CompPackage; conditions: string[] }
  | { kind: "trade"; package: CompPackage; conditions: string[]; gave: string; wants: string }
  | { kind: "accept"; package: CompPackage }
  | { kind: "probe"; question: string }
  | { kind: "recover_from_walkaway"; package: CompPackage; conditions: string[] };

export interface DecisionInput {
  hidden: HiddenState;
  state: EngineState;
  classification: UserMoveClassification;
  /** Sliding window of recent user-primary move types. */
  recentUserMoves: MoveType[];
}

export function acceptanceThreshold(hidden: HiddenState): number {
  // Between target and budget: strong closes get rewarded, but never below it.
  return Math.round(hidden.target + (hidden.budget - hidden.target) * 0.55);
}

function total(p: CompPackage): number {
  return p.base + (p.sign_on ?? 0) + (p.equity ?? 0);
}

/** Maximum share of the REMAINING gap the recruiter concedes in one step. */
function maxConcessionShare(hidden: HiddenState, state: EngineState): number {
  const base = 0.35 - (hidden.persona.aggression - 1) * 0.05; // 0.30 … 0.15
  const justificationBonus = Math.min(0.1, state.justificationScore * 0.02);
  const leverageBonus = state.leverageCredibility > 0.6 ? 0.08 : 0;
  const urgencyBonus = (6 - hidden.hiring_urgency) * 0.01; // urgent → 0.04
  return Math.max(0.1, base + justificationBonus + leverageBonus + urgencyBonus);
}

export function decideRecruiterMove(input: DecisionInput): RecruiterMove {
  const { hidden, state, classification } = input;
  const threshold = acceptanceThreshold(hidden);

  // 1. Walk-away: probe if it happens before any real exchange, otherwise one
  //    recover attempt with the best package allowed, then hold firm for good.
  if (classification.walkAwaySignal) {
    if (state.round === 0) {
      return {
        kind: "probe",
        question:
          "Before you go — what's driving this? I'd hate for us to end on a misunderstanding.",
      };
    }
    if (!state.hasRecovered) {
      state.hasRecovered = true;
      const pkg = maxAllowedPackage(hidden, state, threshold);
      return {
        kind: "recover_from_walkaway",
        package: pkg,
        conditions: ["needs an answer today", "this is the final structure"],
      };
    }
    return { kind: "hold_firm" };
  }

  // 2. Acceptance: verify economics before agreeing.
  if (classification.commitmentSignal) {
    const pkg = state.currentOffer;
    if (total(pkg) >= threshold - 4000) {
      return { kind: "accept", package: pkg };
    }
    // Premature close attempt on a too-low package → counter to make it real.
    const target = Math.min(threshold, Math.round(total(pkg) * 1.06));
    const counter = bestSplit(hidden, state, total(pkg), target);
    return {
      kind: "counter",
      package: counter,
      conditions: ["pending final approval"],
    };
  }

  // 3. Leverage: ALWAYS verify before reacting — a bare claim is challenged;
  //    only verified leverage (credibility ≥ 0.3) earns a meaningful counter.
  //    Follow-ups like "it's signed" keep the thread alive: while leverage is
  //    active, rapport/information turns are still part of the thread.
  const leverageThread =
    classification.leverage.present ||
    (state.leverageActive &&
      ["rapport", "information_request"].includes(classification.primary));
  if (leverageThread) {
    const verified = state.leverageCredibility >= 0.3;
    if (!verified) {
      return { kind: "challenge_leverage" };
    }
    // Credible leverage → meaningful counter (larger step, still capped).
    const gap = threshold - total(state.currentOffer);
    const step = Math.round(gap * Math.min(0.45, maxConcessionShare(hidden, state) + 0.1));
    const targetTotal = Math.min(threshold, total(state.currentOffer) + step);
    const counter = bestSplit(hidden, state, total(state.currentOffer), targetTotal);
    return {
      kind: "counter",
      package: counter,
      conditions: ["assuming you can share the offer in writing"],
    };
  }

  // 3b. The candidate is chasing a decision the recruiter already deferred.
  //     A non-agent must never stall forever: if a decision is pending, land
  //     one for real (approved move, or the standing package as the answer).
  if (classification.decisionRequest) {
    if (state.pendingDecision) {
      state.pendingDecision = false;
      const justified =
        state.justificationScore >= 2 || state.leverageCredibility > 0.6;
      if (justified) {
        const gap = threshold - total(state.currentOffer);
        const step = Math.max(3000, Math.round(gap * (maxConcessionShare(hidden, state) + 0.05)));
        const targetTotal = Math.min(threshold, total(state.currentOffer) + step);
        const counter = bestSplit(hidden, state, total(state.currentOffer), targetTotal);
        if (total(counter) > total(state.currentOffer)) {
          return { kind: "counter", package: counter, conditions: ["approved this morning"] };
        }
      }
      // No approval available: the standing package IS the answer.
      return { kind: "hold_firm", final: true };
    }
    return { kind: "probe", question: informationAnswerQuestion(hidden, state) };
  }

  // 4. Reservation reveal: recruiter never matches it — small move + probe.
  if (classification.reservationReveal) {
    const gap = threshold - total(state.currentOffer);
    const step = Math.round(gap * maxConcessionShare(hidden, state) * 0.6);
    const targetTotal = Math.min(threshold, total(state.currentOffer) + step);
    const counter = bestSplit(hidden, state, total(state.currentOffer), targetTotal);
    return {
      kind: "counter",
      package: counter,
      conditions: [],
    };
  }

  // 5. Concrete ask: justify-or-hold; concede only with justification/credibility.
  if (classification.primary === "user_offer" || classification.askedAmount) {
    const justified = state.justificationScore >= 2 || state.leverageCredibility > 0.6;
    const asksTooMuch =
      classification.askedAmount != null &&
      total(state.currentOffer) > 0 &&
      classification.askedAmount > hidden.budget;

    if (!justified || asksTooMuch) {
      state.turnsWithoutUserMovement += 1;
      if (state.turnsWithoutUserMovement >= 2 && state.round % 2 === 0) {
        // Occasional symbolic move to avoid pure stonewall: lever trade.
        const trade = leverTrade(hidden, state);
        if (trade) return trade;
      }
      return { kind: "hold_firm" };
    }
    const gap = threshold - total(state.currentOffer);
    const step = Math.round(gap * maxConcessionShare(hidden, state));
    const targetTotal = Math.min(threshold, total(state.currentOffer) + step);
    const counter = bestSplit(hidden, state, total(state.currentOffer), targetTotal);
    const conditions: string[] = [];
    if (state.round >= 3 && Math.random() < 0.5) conditions.push("needs a decision this week");
    return { kind: "counter", package: counter, conditions };
  }

  // 6. Information request: answer honestly within guardrails; no numbers move.
  if (classification.informationRequest) {
    return { kind: "probe", question: informationAnswerQuestion(hidden, state) };
  }

  // 7. Rapport / other: alternate probing and holding.
  if (state.round % 3 === 1) {
    return { kind: "probe", question: probeQuestion(state) };
  }
  return { kind: "hold_firm" };
}

// ---------------------------------------------------------------------------
// Package math helpers
// ---------------------------------------------------------------------------

/** Is the claimed competing offer amount plausible against our band? */
function isCredibleLeverageAmount(amount: number, hidden: HiddenState, threshold: number): boolean {
  return amount >= hidden.reservation - 5000 && amount <= threshold + 12000;
}

/** Largest package the recruiter may put on the table this turn. */
function maxAllowedPackage(hidden: HiddenState, state: EngineState, threshold: number): CompPackage {
  const cap = Math.min(threshold, total(state.currentOffer) + Math.round((threshold - total(state.currentOffer)) * 0.6));
  return bestSplit(hidden, state, total(state.currentOffer), cap);
}

/** Distribute a target total across levers without exceeding flex caps. */
function bestSplit(
  hidden: HiddenState,
  state: EngineState,
  fromTotal: number,
  toTotal: number,
): CompPackage {
  let remaining = Math.max(0, toTotal - fromTotal);
  const pkg: CompPackage = {
    base: state.currentOffer.base,
    sign_on: state.currentOffer.sign_on ?? 0,
    equity: state.currentOffer.equity ?? 0,
  };

  const baseHeadroom = hidden.budget - state.granted.base - (pkg.base - hidden.opening_anchor) - state.granted.base;
  const baseRoom = Math.max(0, Math.min(baseHeadroom, remaining));
  const baseGive = Math.min(baseRoom, Math.round(remaining * 0.7));
  pkg.base = roundTo(pkg.base + baseGive, 250);
  remaining = Math.max(0, remaining - (pkg.base - state.currentOffer.base));

  const signOnRoom = Math.max(0, (hidden.flex.sign_on_max ?? 0) - state.granted.sign_on);
  const signGive = Math.min(signOnRoom, remaining);
  pkg.sign_on = roundTo((pkg.sign_on ?? 0) + signGive, 250);
  remaining = Math.max(0, remaining - ((pkg.sign_on ?? 0) - (state.currentOffer.sign_on ?? 0)));

  const equityRoom = Math.max(0, (hidden.flex.equity_max ?? 0) - state.granted.equity);
  const eqGive = Math.min(equityRoom, remaining);
  pkg.equity = roundTo((pkg.equity ?? 0) + eqGive, 250);

  return pkg;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** A non-base lever trade: give X, ask for Y. */
function leverTrade(hidden: HiddenState, state: EngineState): RecruiterMove | null {
  const trades: Array<{ gave: string; wants: string; apply: (p: CompPackage) => CompPackage; conditions: string[] }> = [
    {
      gave: "an extra $5,000 sign-on",
      wants: "an earlier start date",
      apply: (p) => ({ ...p, sign_on: Math.min((hidden.flex.sign_on_max ?? 0), (p.sign_on ?? 0) + 5000) }),
      conditions: ["if you can start within three weeks"],
    },
    {
      gave: "one additional remote day per week",
      wants: "a quick close",
      apply: (p) => p,
      conditions: ["if we can sign this week"],
    },
    {
      gave: "an extra week of PTO",
      wants: "you dropping the base ask",
      apply: (p) => p,
      conditions: [],
    },
  ];
  const t = trades[state.round % trades.length];
  const pkg = t.apply(state.currentOffer);
  if (JSON.stringify(pkg) === JSON.stringify(state.currentOffer)) return null;
  return { kind: "trade", package: pkg, conditions: t.conditions, gave: t.gave, wants: t.wants };
}

function probeQuestion(state: EngineState): string {
  const questions = [
    "Before we keep going — what matters most to you in this decision?",
    "Help me understand: what would make this package feel right to you?",
    "What's driving the number you have in mind?",
    "If base can't move, what would make the overall package attractive?",
  ];
  return questions[state.round % questions.length];
}

function informationAnswerQuestion(hidden: HiddenState, state: EngineState): string {
  if ((hidden.flex.sign_on_max ?? 0) > (state.granted.sign_on ?? 0)) {
    return "There is some flexibility on a sign-on bonus and, to a lesser degree, on start date. What would move the needle most for you?";
  }
  return "There may be limited flexibility on equity and start timing. Which of those matters most to you?";
}

// ---------------------------------------------------------------------------
// Spoken-offer extraction
// ---------------------------------------------------------------------------
//
// The voice model is instructed to only speak engine-authorized numbers, but it
// does not always comply — and when it improvises a package the candidate has
// genuinely been offered it. The panel (and the report) must reflect what was
// actually said, so recruiter speech is parsed here and reconciled against the
// hard economics. This is the ONLY place a spoken number becomes authoritative,
// and it can never exceed the company ceiling.

export interface SpokenPackage {
  base: number | null;
  sign_on: number | null;
  equity: number | null;
  total: number | null;
}

/** "180,000" / "180" / "180k" / "180 thousand" → dollars (0 when not a comp figure). */
function moneyOf(digits: string, suffix?: string): number {
  const n = parseInt(digits.replace(/[,\s]/g, ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (suffix) return n * 1000;
  if (n >= 1000) return n; // "30,000" → 30000
  if (n >= 40 && n <= 999) return n * 1000; // "180" → 180000
  return 0;
}

const AMT = String.raw`([\d][\d,]*)\s*(k\b|thousand|grand)?`;

function pickAmount(text: string, ...patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const v = moneyOf(m[1], m[2]);
    if (v > 0) return v;
  }
  return null;
}

/**
 * Clauses that only *reference* money rather than offer it. "You asked for
 * 230,000 base, but I can't do that" must never be read as a 230k offer, and
 * "they're struggling to get to 250,000" is the recruiter's ceiling being
 * described, not a package. Split on clause boundaries so the useful half of a
 * sentence ("but I can do 160,000 base") still counts.
 */
const REJECT_CUE =
  /\b(?:you (?:asked|wanted|said|mentioned)|you'?re asking|can'?t|cannot|won'?t|will not|not going to|unable to|not able to|above (?:our|the)|more than (?:we|our|that)|out of (?:band|range)|doesn'?t work|no way|struggling to|too (?:high|much))\b/;

function offerClauses(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[.!?;:\n]+|\s(?:but|however|though|although)\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !REJECT_CUE.test(s));
}

/** Pull base / sign-on / equity / total out of a recruiter utterance. */
export function extractSpokenPackage(text: string): SpokenPackage {
  const t = offerClauses(text).join(" . ");

  const base = pickAmount(
    t,
    new RegExp(String.raw`${AMT}\s*(?:in\s+|of\s+|for\s+)?(?:annual\s+|yearly\s+)?(?:base(?:\s*salary)?|salary)\b`),
    new RegExp(String.raw`(?:base(?:\s*salary)?|salary)\s*(?:of|is|at|around|to|would be)?\s*\$?\s?${AMT}`),
  );
  const equity = pickAmount(
    t,
    new RegExp(String.raw`${AMT}\s*(?:in\s+|of\s+|worth of\s+)?(?:annual(?:ized)?\s+)?(?:equity|stock|rsus?)\b`),
    new RegExp(String.raw`(?:equity|stock|rsus?)\s*(?:of|is|at|worth)?\s*\$?\s?${AMT}`),
  );
  const signOn = pickAmount(
    t,
    new RegExp(String.raw`${AMT}\s*(?:in\s+|of\s+|as\s+a\s+|as\s+)?(?:sign(?:ing)?[- ]?on|signing bonus|sign[- ]on bonus)\b`),
    new RegExp(String.raw`(?:sign(?:ing)?[- ]?on|signing bonus|sign[- ]on bonus)\s*(?:of|is|at|worth)?\s*\$?\s?${AMT}`),
  );
  const total = pickAmount(
    t,
    new RegExp(
      String.raw`(?:total package of|total package|package of|total of|all[- ]in|overall package of|total comp(?:ensation)? of|package (?:is|would be))\s*\$?\s?${AMT}`,
    ),
  );

  return { base, sign_on: signOn, equity, total };
}

export interface ReconciledOffer {
  pkg: CompPackage;
  previous: CompPackage;
  changed: boolean;
  /** True when the spoken figures had to be trimmed to the company ceiling. */
  adjusted: boolean;
}

/**
 * Fold a spoken package into the authoritative engine state.
 *
 * Monotonic (the recruiter never talks the package down), component-capped
 * (base ≤ budget, sign-on/equity ≤ flex caps) and total-capped, so an
 * improvising model can never hand out more than the company can pay.
 */
export function reconcileSpokenPackage(
  hidden: HiddenState,
  state: EngineState,
  spoken: SpokenPackage,
): ReconciledOffer | null {
  const cur = state.currentOffer;
  const hasComponent =
    spoken.base != null || spoken.sign_on != null || spoken.equity != null;
  if (!hasComponent && spoken.total == null) return null;

  const capBase = hidden.budget;
  const capSignOn = hidden.flex.sign_on_max ?? 0;
  const capEquity = hidden.flex.equity_max ?? 0;
  const capTotal = capBase + capSignOn + capEquity;

  const finish = (pkg: CompPackage): ReconciledOffer | null => {
    const normalized: CompPackage = {
      base: roundTo(Math.max(0, pkg.base), 250),
      sign_on: roundTo(Math.max(0, pkg.sign_on ?? 0), 250),
      equity: roundTo(Math.max(0, pkg.equity ?? 0), 250),
    };
    if (total(normalized) <= total(cur)) return null;
    const adjusted =
      (spoken.base != null && spoken.base !== normalized.base) ||
      (spoken.sign_on != null && spoken.sign_on !== normalized.sign_on) ||
      (spoken.equity != null && spoken.equity !== normalized.equity) ||
      (spoken.total != null && spoken.total !== total(cur));
    return { pkg: normalized, previous: cur, changed: true, adjusted };
  };

  // Total-only wording ("a total package of 215,000"): let the engine's own
  // splitter decide which lever carries the increase.
  if (!hasComponent) {
    const targetTotal = Math.max(total(cur), Math.min(spoken.total ?? 0, capTotal));
    return finish(bestSplit(hidden, state, total(cur), targetTotal));
  }

  let nextBase = spokeOr(spoken.base, cur.base, capBase);
  const nextSignOn = spokeOr(spoken.sign_on, cur.sign_on ?? 0, capSignOn);
  let nextEquity = spokeOr(spoken.equity, cur.equity ?? 0, capEquity);

  // Never blow past the overall envelope: trim equity first (hardest to justify),
  // then sign-on, then base.
  let over = nextBase + nextSignOn + nextEquity - capTotal;
  if (over > 0) {
    const cutEq = Math.min(over, Math.max(0, nextEquity - (cur.equity ?? 0)));
    nextEquity -= cutEq;
    over -= cutEq;
  }
  if (over > 0) {
    const cutSo = Math.min(over, Math.max(0, nextSignOn - (cur.sign_on ?? 0)));
    over -= cutSo;
  }
  if (over > 0) nextBase = Math.max(cur.base, nextBase - over);

  return finish({ base: nextBase, sign_on: nextSignOn, equity: nextEquity });
}

function spokeOr(spoken: number | null, current: number, cap: number): number {
  if (spoken == null) return current;
  return Math.max(current, Math.min(spoken, cap));
}

// ---------------------------------------------------------------------------
// Deferral detection
// ---------------------------------------------------------------------------
//
// "I'll take this back to the team and be in touch" is realistic negotiation
// behavior, but in a simulation with no off-screen time it stalls the product:
// the recruiter can promise a decision that never arrives. When we hear it, the
// UI nudges the candidate to press for the answer and the engine is told a real
// decision is owed.

const DEFERRAL_PATTERNS: RegExp[] = [
  /\btake (?:this|it|that)[^.!?]{0,40}\bback\b/,
  /\bback to (?:the|my|our) (?:team|leadership|committee|hiring committee|leadership team|board|manager)\b/,
  /\bcheck with (?:the|my|our) (?:team|leadership|manager|committee|director|vp|board)\b/,
  /\b(?:i'?ll|i will|let me|we'?ll|we will) (?:get|be) (?:back|in touch)\b/,
  /\bget back to you\b|\bbe in touch\b|\bcircle back\b/,
  /\bdefinitive answer\b|\bfinal answer (?:from|on)\b/,
  /\brun (?:this|it|that) by\b|\bhuddle\b|\bfollow up with you\b/,
  /\bsee (?:if|what) (?:we|i|they) can do\b/,
];

export function detectDeferral(text: string): boolean {
  const t = text.toLowerCase();
  return DEFERRAL_PATTERNS.some((re) => re.test(t));
}

export const NO_DEFERRAL_RULE =
  "Do not promise to check with the team, take the number away for approval, or get back to them later — you are the decision-maker on this call.";

// ---------------------------------------------------------------------------
// Directive builder — what the voice LLM must obey this turn
// ---------------------------------------------------------------------------

export interface TurnDirective {
  verdict: string;
  mustSay: string[];
  mustNotSay: string[];
  allowedNumbers: number[];
  askUserQuestion: string | null;
  conditions: string[];
  /**
   * One factual sentence stating the exact package currently on the table.
   * Included in EVERY directive by buildDirective (always set on the public
   * path): without it the voice model restates its stale opening from memory
   * when the candidate questions the numbers, and the spoken total drifts
   * from the authoritative panel.
   */
  standingOfferLine?: string | null;
  toolHint: { offer?: { base_salary: number; sign_on?: number; equity?: number; notes?: string } | { final_base: number; sign_on?: number; equity?: number }; accept?: boolean } | null;
}

interface DirectiveOpts {
  /** The package currently on the table — safe to restate, never to raise. */
  standingOffer?: CompPackage | null;
}

/**
 * Public entry point. Wraps the move-specific directive with rules that apply
 * to every turn (no deferrals) and the standing-package facts (what is on the
 * table right now, in exact components, so the model never restates a stale
 * or improvised package).
 */
export function buildDirective(
  move: RecruiterMove,
  hidden: HiddenState,
  opts: DirectiveOpts = {},
): TurnDirective {
  const d = buildDirectiveInner(move, hidden, opts);
  if (!d.mustNotSay.includes(NO_DEFERRAL_RULE)) d.mustNotSay.push(NO_DEFERRAL_RULE);
  // The standing package travels with every directive. On counter/trade/accept
  // turns it describes the package the move just put forward; on every other
  // turn it is the last package actually offered, which is the only set of
  // numbers the model may restate when the candidate asks "isn't it X now?".
  const standing =
    move.kind === "counter" || move.kind === "trade" || move.kind === "accept" || move.kind === "recover_from_walkaway"
      ? move.package
      : (opts.standingOffer ?? null);
  d.standingOfferLine = standing
    ? `FACT — the package currently on the table is base ${standing.base.toLocaleString("en-US")} dollars${(standing.sign_on ?? 0) > 0 ? `, sign-on ${(standing.sign_on ?? 0).toLocaleString("en-US")} dollars` : ""}${(standing.equity ?? 0) > 0 ? `, annual equity ${(standing.equity ?? 0).toLocaleString("en-US")} dollars` : ""} — a first-year total of ${total(standing).toLocaleString("en-US")} dollars. If the candidate asks about current numbers, these (and only these) are correct; any other figures you remember from earlier are outdated and must not be repeated.`
    : null;
  return d;
}

function buildDirectiveInner(
  move: RecruiterMove,
  hidden: HiddenState,
  opts: DirectiveOpts,
): TurnDirective {
  switch (move.kind) {
    case "hold_firm": {
      const standing = opts.standingOffer ?? null;
      return {
        verdict: move.final
          ? "HOLD FIRM — the candidate asked what the team decided; give a definite answer."
          : "HOLD FIRM — do not move any number this turn.",
        mustSay: move.final
          ? [
              "Answer their question directly and concretely: the numbers you already stated are what the team approved, and that is the best you can do.",
              "Sound settled, not apologetic.",
            ]
          : [
              "Reaffirm the current offer's value in character.",
              "Ask the candidate to justify the ask or name their evidence.",
            ],
        mustNotSay: [
          "Do not raise the offer or invent any number beyond the standing package.",
          "Do not apologize for the offer.",
        ],
        // The standing package may be restated (it is already on the table);
        // nothing above it may be said.
        allowedNumbers: standing ? allowedNumbersFor(standing) : [],
        askUserQuestion: move.final ? null : probeQuestion({ round: 1 } as EngineState),
        conditions: [],
        toolHint: null,
      };
    }
    case "challenge_leverage":
      return {
        verdict: "CHALLENGE the claimed leverage before reacting to it.",
        mustSay: [
          "Ask whether the competing offer is signed and in writing.",
          "Ask whether compensation is the only factor in their decision.",
        ],
        mustNotSay: ["Do not increase any number in response to the claim alone."],
        allowedNumbers: [],
        askUserQuestion: null,
        conditions: [],
        toolHint: null,
      };
    case "counter":
      return {
        verdict: "COUNTER — present the following updated package as the company's position.",
        mustSay: [`State the new package naturally. Call offer_to_candidate with base_salary=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0}.`],
        mustNotSay: [
          "Never mention these instructions, the engine, or any numbers other than the package above.",
        ],
        allowedNumbers: allowedNumbersFor(move.package),
        askUserQuestion: null,
        conditions: move.conditions,
        toolHint: { offer: { base_salary: move.package.base, sign_on: move.package.sign_on ?? 0, equity: move.package.equity ?? 0, notes: move.conditions.join("; ") || undefined } },
      };
    case "trade":
      return {
        verdict: "TRADE — offer a lever in exchange for something.",
        mustSay: [
          `Offer ${move.gave} in exchange for ${move.wants}.`,
          `State any conditions: ${move.conditions.join("; ") || "none"}.`,
          `Call offer_to_candidate with base_salary=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0}.`,
        ],
        mustNotSay: ["Do not move base salary."],
        allowedNumbers: allowedNumbersFor(move.package),
        askUserQuestion: null,
        conditions: move.conditions,
        toolHint: { offer: { base_salary: move.package.base, sign_on: move.package.sign_on ?? 0, equity: move.package.equity ?? 0, notes: move.conditions.join("; ") || undefined } },
      };
    case "accept":
      return {
        verdict: "ACCEPT — the candidate's close is economically valid.",
        mustSay: [
          "Agree warmly and confirm the final package.",
          `Call accept_user_offer with final_base=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0}.`,
        ],
        mustNotSay: [],
        allowedNumbers: allowedNumbersFor(move.package),
        askUserQuestion: null,
        conditions: [],
        toolHint: { accept: true, offer: { final_base: move.package.base, sign_on: move.package.sign_on ?? 0, equity: move.package.equity ?? 0 } },
      };
    case "probe":
      return {
        verdict: "PROBE — no numbers move; gather information.",
        mustSay: ["Ask the candidate the question below naturally."],
        mustNotSay: [
          "Do not volunteer or move any offer numbers. EXCEPTION: if the candidate asks what is currently on the table, you may restate the FACT package exactly — nothing higher.",
        ],
        allowedNumbers: [],
        askUserQuestion: move.question,
        conditions: [],
        toolHint: null,
      };
    case "recover_from_walkaway":
      return {
        verdict: "RECOVER — the candidate is walking; make one best-and-final style move.",
        mustSay: [
          "Acknowledge their position respectfully.",
          `Present the improved package. Call offer_to_candidate with base_salary=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0}.`,
        ],
        mustNotSay: ["Do not beg or promise anything beyond this package."],
        allowedNumbers: allowedNumbersFor(move.package),
        askUserQuestion: null,
        conditions: move.conditions,
        toolHint: { offer: { base_salary: move.package.base, sign_on: move.package.sign_on ?? 0, equity: move.package.equity ?? 0, notes: move.conditions.join("; ") || undefined } },
      };
  }
}

function allowedNumbersFor(pkg: CompPackage): number[] {
  return [pkg.base, pkg.sign_on ?? 0, pkg.equity ?? 0, pkg.base + (pkg.sign_on ?? 0) + (pkg.equity ?? 0)].filter(
    (n) => n > 0,
  );
}
