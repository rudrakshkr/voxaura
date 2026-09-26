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
  /** Concrete numeric asks (last number spoken that plausibly is an ask). */
  askedAmount: number | null;
  /** Which component a labelled ask names ("160k base" → base). */
  askedComponent: "base" | "sign_on" | "equity" | null;
  /** The labelled base ask when the candidate named base/salary explicitly. */
  askedBase: number | null;
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

  // Leverage detection has to cover how candidates actually say it. The old
  // pattern only recognised "another offer"/"competing offer", so "I have a
  // signed offer at 178k" — the strongest possible claim — was read as a plain
  // ask and answered as one.
  const leveragePresent =
    /another offer|other offer|competing offer|counter.?offer from|other company|another company|elsewhere|other opportunity|other process|competing process|signed offer|written offer|offer in writing|offer in hand|firm offer|offer from (?:another|a different|a company)|offer at \$?\d|in stage|final rounds? (?:with|at)/.test(
      t,
    );
  const leverage = {
    present: leveragePresent,
    amount: amounts.length ? amounts[amounts.length - 1] : null,
    vague: leveragePresent && amounts.length === 0,
  };

  // Component-labelled asks. "I need 165 base" and "20k sign-on" are not the
  // same demand as "I need 165 total", and treating a sign-on figure as a total
  // ask made the recruiter respond to the wrong number.
  const labelled = labelledComponentAmounts(t);
  const askedBase = labelled.base;
  const askedComponent: "base" | "sign_on" | "equity" | null =
    askedBase != null ? "base" : labelled.sign_on != null ? "sign_on" : labelled.equity != null ? "equity" : null;

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

  // How people actually say yes. The narrower list used to miss "I'll take what
  // you offered" and "okay, deal" — a candidate trying to close was answered
  // with another probing question instead of a decision.
  const commitmentSignal =
    /we have a deal|we'?ve got a deal|sounds? like a deal|i'?m happy with|let'?s do it|let'?s (?:sign|close|finalize|wrap)|i accept|i'?ll accept|i can commit|i'?m ready to sign|works for me|deal\.?$|happy to accept|would be happy to|gladly accept|sign today|sign me up|accept (?:that|this|the) offer|i'?ll (?:just )?take\b|take what you (?:offered|are offering|proposed)|happy with (?:that|this|the offer)|i'?m in\b|okay,? deal\b|yes,? let'?s\.?$/.test(t);

  const walkAwaySignal =
    /walk away|walking away|not a fit|not the right fit|go(?:ing)? with (?:the )?other|accept the other|decline|turn(?:ing)? (?:you |this )?down|not going to (?:be able to|work)|can'?t accept|cannot accept|not interested|pass on (?:this|the) (?:role|offer)|withdraw|\bor i'?m (?:out|gone)\b|\bi'?m out\b|\bi'?ll pass\b|\btake my (?:name|self) out\b|\bend (?:the|this) call\b/.test(t);

  // "What did the team say?" — the candidate is chasing a decision the
  // recruiter already promised. Must be answered, never deferred again.
  const decisionRequest =
    /what did (?:the|they|your|his|her) (?:team|leadership|committee|manager|board|vp|boss)\b|what(?:'s| is| was) the (?:decision|verdict|word|answer)\b|any (?:news|word|updates?|progress|feedback)\b|did (?:the|they|your) \w* ?(?:team|leadership|committee) (?:say|approve|get back|come back)|did you (?:hear|talk to|speak with|check)\b|come back with|following up\b|checking (?:back )?in\b|any luck\b|what'?s the latest\b|heard anything\b/.test(
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
    askedComponent,
    askedBase,
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
  /** How many times the recruiter has already challenged unverified leverage. */
  leverageChallenges: number;
  /** Last concrete amount the candidate asked for, and how often it repeated. */
  lastAskAmount: number | null;
  repeatAskCount: number;
  /** Last competing-offer figure the candidate actually named. */
  lastLeverageAmount: number | null;
  /** Consecutive commitment signals below the bar (see the accept branch). */
  acceptAttempts: number;
  /** Evidence arguments already spent — repeating one earns nothing new. */
  evidenceTags: string[];
  /** True when the candidate's current turn introduced genuinely new evidence. */
  newEvidenceThisTurn: boolean;
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

export function total(p: CompPackage): number {
  return p.base + (p.sign_on ?? 0) + (p.equity ?? 0);
}

/**
 * Base-salary level at which the recruiter will accept the deal.
 *
 * `target` and `budget` are BASE-salary figures, so this bar is a base figure
 * too. It used to be compared against the first-year TOTAL, which quietly made
 * the recruiter either over- or under-generous depending on how much sign-on
 * and equity happened to be on the table.
 */
export function acceptanceThreshold(hidden: HiddenState): number {
  return roundTo(hidden.target + (hidden.budget - hidden.target) * 0.55, 250);
}

/**
 * Total first-year value at which the recruiter will accept a flex-heavy
 * package: flex levers are worth less to the company than base, so a candidate
 * who takes sign-on/equity instead of base has to clear a higher total bar.
 */
export function acceptanceTotalThreshold(hidden: HiddenState): number {
  const flexFloor = Math.round(
    ((hidden.flex.sign_on_max ?? 0) + (hidden.flex.equity_max ?? 0)) * 0.5,
  );
  return acceptanceThreshold(hidden) + flexFloor;
}

/** Absolute envelope: never more than base ceiling + flex caps, ever. */
export function packageEnvelope(hidden: HiddenState): number {
  return hidden.budget + (hidden.flex.sign_on_max ?? 0) + (hidden.flex.equity_max ?? 0);
}

/**
 * The largest total the recruiter will ever put on the table (acceptance bar,
 * never above the hard envelope). Every concession, recovery and spoken-figure
 * reconciliation is capped by this one number, so the panel, the directive and
 * the final report can never disagree about what the company can pay.
 */
export function maxOfferTotal(hidden: HiddenState): number {
  return Math.min(packageEnvelope(hidden), acceptanceTotalThreshold(hidden));
}

/** Would the recruiter sign off on this package as it stands? */
export function acceptsPackage(hidden: HiddenState, pkg: CompPackage): boolean {
  return (
    pkg.base >= acceptanceThreshold(hidden) || total(pkg) >= acceptanceTotalThreshold(hidden)
  );
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
  const curTotal = total(state.currentOffer);
  const envelope = packageEnvelope(hidden);
  const offerCap = maxOfferTotal(hidden);

  // 0. Repeated identical asks are pressure, not progress. A recruiter who
  //    re-opens the numbers every time the same sentence comes back is being
  //    worn down, not persuaded — so repeats are counted, and a third identical
  //    ask is answered with a final no instead of another concession.
  if (classification.askedAmount != null) {
    if (state.lastAskAmount === classification.askedAmount) state.repeatAskCount += 1;
    else {
      state.lastAskAmount = classification.askedAmount;
      state.repeatAskCount = 0;
    }
  }

  const justified =
    state.newEvidenceThisTurn || state.leverageCredibility >= 0.6 || state.justificationScore >= 2;

  // Anything other than a yes resets the "they really want to close" counter.
  if (!classification.commitmentSignal) state.acceptAttempts = 0;

  // 1. Walk-away: an empty bluff is not leverage. A recovery move has to be
  //    earned — the candidate must already have engaged (a package has actually
  //    moved) or brought real evidence / credible leverage.
  if (classification.walkAwaySignal) {
    const engaged =
      state.offerCount >= 2 || state.justificationScore >= 2 || state.leverageCredibility >= 0.3;
    if (!state.hasRecovered && engaged) {
      const cap = Math.min(offerCap, curTotal + Math.round((offerCap - curTotal) * 0.5));
      const pkg = bestSplit(hidden, state, curTotal, cap);
      if (total(pkg) - curTotal >= MIN_MOVE) {
        state.hasRecovered = true;
        return {
          kind: "recover_from_walkaway",
          package: pkg,
          conditions: ["needs an answer today", "this is the final structure"],
        };
      }
    }
    if (state.round === 0 && !state.hasRecovered) {
      return {
        kind: "probe",
        question:
          "Before you go — what's driving this? I'd hate for us to end on a misunderstanding.",
      };
    }
    return { kind: "hold_firm", final: true };
  }

  // 2. Acceptance: verify economics before agreeing.
  if (classification.commitmentSignal) {
    if (acceptsPackage(hidden, state.currentOffer)) {
      return { kind: "accept", package: state.currentOffer };
    }
    state.acceptAttempts += 1;
    // A candidate who insists gets the yes. Bumping the number every time
    // somebody says yes is not a negotiation, and refusing a genuine yes is
    // worse than taking a modest deal — the score tells the candidate what they
    // left behind.
    if (state.acceptAttempts >= 2) return { kind: "accept", package: state.currentOffer };
    // Premature close on a package below the bar → one real counter.
    const target = Math.min(offerCap, curTotal + Math.max(MIN_MOVE, Math.round(curTotal * 0.03)));
    return counterOrHold(hidden, state, target, []);
  }

  // 3. Leverage: ALWAYS verify before reacting. Verification needs a stated,
  //    plausible competing number AND corroborating detail — a bare claim, or
  //    an absurd one, earns nothing but a question. Follow-ups like "it's
  //    signed" keep the thread alive: while leverage is active, rapport and
  //    information turns are still part of the thread.
  const leverageThread =
    classification.leverage.present ||
    (state.leverageActive &&
      ["rapport", "information_request"].includes(classification.primary));
  if (leverageThread) {
    // A verified claim does not have to be re-stated every turn: remember the
    // figure the candidate actually named earlier in the call.
    const claim = classification.leverage.amount ?? state.lastLeverageAmount;
    if (classification.leverage.amount != null) state.lastLeverageAmount = classification.leverage.amount;
    const hasDetail = state.leverageCredibility >= 0.3;
    if (!hasDetail || claim == null) {
      state.leverageChallenges += 1;
      // Two challenges is a conversation; a third identical one would be a loop.
      if (state.leverageChallenges >= 3) return { kind: "hold_firm", final: true };
      return { kind: "challenge_leverage" };
    }
    const gap = Math.max(0, offerCap - curTotal);
    const share = isCredibleLeverageAmount(claim, hidden)
      ? state.leverageCredibility >= 0.6
        ? Math.min(0.45, maxConcessionShare(hidden, state) + 0.1)
        : maxConcessionShare(hidden, state)
      : maxConcessionShare(hidden, state) * 0.75;
    const targetTotal = Math.min(offerCap, curTotal + Math.round(gap * share));
    return counterOrHold(
      hidden,
      state,
      targetTotal,
      isCredibleLeverageAmount(claim, hidden)
        ? ["assuming you can share the offer in writing"]
        : ["this is our best — it can't match that number"],
    );
  }

  // 3b. The candidate is chasing a decision the recruiter already deferred.
  //     A non-agent must never stall forever: if a decision is pending, land
  //     one for real (approved move, or the standing package as the answer).
  if (classification.decisionRequest) {
    if (state.pendingDecision) {
      state.pendingDecision = false;
      const justifiedPending = state.justificationScore >= 2 || state.leverageCredibility > 0.6;
      if (justifiedPending) {
        const gap = Math.max(0, offerCap - curTotal);
        const step = Math.max(3000, Math.round(gap * (maxConcessionShare(hidden, state) + 0.05)));
        const moved = counterOrHold(
          hidden,
          state,
          Math.min(offerCap, curTotal + step),
          ["that came back approved this morning"],
        );
        if (moved.kind === "counter") return moved;
      }
      // No approval available: the standing package IS the answer.
      return { kind: "hold_firm", final: true };
    }
    return { kind: "probe", question: informationAnswerQuestion(hidden, state) };
  }

  // 4. Reservation reveal: never match it — a small move plus a probe.
  if (classification.reservationReveal) {
    const gap = Math.max(0, offerCap - curTotal);
    const step = Math.round(gap * maxConcessionShare(hidden, state) * 0.6);
    return counterOrHold(hidden, state, Math.min(offerCap, curTotal + step), []);
  }

  // 5. Concrete ask: justify-or-hold; one move per new argument.
  if (classification.primary === "user_offer" || classification.askedAmount) {
    const askValue = classification.askedBase ?? classification.askedAmount;
    const askVs =
      classification.askedBase != null ? state.currentOffer.base : curTotal;
    // Asking for less than what is already on the table is not a move — and
    // raising the offer in response to it would hand over money nobody asked
    // for. This was a straight exploit: ask for 100k, get a raise.
    if (askValue != null && askValue <= askVs) {
      state.turnsWithoutUserMovement += 1;
      return { kind: "hold_firm" };
    }

    if (askValue != null && askValue > envelope * 1.05) {
      // Far outside anything this band could justify: name the gap once, hold.
      state.turnsWithoutUserMovement += 1;
      return justified
        ? counterOrHold(hidden, state, offerCap, ["that is the top of our band"])
        : { kind: "hold_firm" };
    }

    // The same number, a third time, with nothing new behind it.
    if (state.repeatAskCount >= 2) return { kind: "hold_firm", final: true };

    if (!justified) {
      state.turnsWithoutUserMovement += 1;
      if (state.turnsWithoutUserMovement >= 2 && state.round % 2 === 0) {
        // Occasional symbolic move to avoid a pure stonewall: lever trade.
        const trade = leverTrade(hidden, state);
        if (trade) return trade;
      }
      return { kind: "hold_firm" };
    }

    const gap = Math.max(0, offerCap - curTotal);
    const step = Math.round(gap * maxConcessionShare(hidden, state));
    // A labelled base ask counts against the whole first-year package it would
    // sit inside — otherwise "I need 150k base" reads as a 150k total.
    const askAsTotal =
      classification.askedBase != null
        ? classification.askedBase +
          (state.currentOffer.sign_on ?? 0) +
          (state.currentOffer.equity ?? 0)
        : classification.askedAmount;
    let targetTotal = Math.min(offerCap, curTotal + step);
    // Never give more than the candidate actually asked for, and never move so
    // little that the turn reads as a shrug.
    if (askAsTotal != null) targetTotal = Math.min(targetTotal, Math.max(curTotal + MIN_MOVE, askAsTotal));
    const conditions = state.round >= 3 && state.round % 2 === 1 ? ["needs a decision this week"] : [];
    return counterOrHold(hidden, state, targetTotal, conditions);
  }

  // 6. Information request: answer honestly within guardrails; no numbers move.
  if (classification.informationRequest) {
    return { kind: "probe", question: informationAnswerQuestion(hidden, state) };
  }

  // 7. Rapport / other: quiet turns. Evidence still earns a modest move even
  //    when no number was named — a candidate should not have to state a figure
  //    to be rewarded for building a real case. Anything else alternates between
  //    probing and holding so the recruiter never goes silent or nags.
  if (state.round % 3 === 1) {
    return { kind: "probe", question: probeQuestion(state.round) };
  }
  if (justified && state.round % 3 === 0) {
    const gap = Math.max(0, offerCap - curTotal);
    return counterOrHold(
      hidden,
      state,
      Math.min(offerCap, curTotal + Math.round(gap * maxConcessionShare(hidden, state) * 0.6)),
      [],
    );
  }
  return { kind: "hold_firm" };
}

/** Smallest package change that counts as movement (matches the $250 rounding). */
const MIN_MOVE = 500;

/**
 * Build a counter from a target total, or a definitive hold when the package
 * cannot move at all. Returning `hold_firm` instead of a no-op counter matters:
 * a "counter" that changes nothing produced a turn where the recruiter restated
 * the same numbers, which is exactly the repetition this engine must avoid.
 */
function counterOrHold(
  hidden: HiddenState,
  state: EngineState,
  targetTotal: number,
  conditions: string[],
): RecruiterMove {
  const from = total(state.currentOffer);
  const pkg = bestSplit(hidden, state, from, Math.max(from, targetTotal));
  if (total(pkg) - from < MIN_MOVE) return { kind: "hold_firm", final: true };
  state.turnsWithoutUserMovement = 0;
  return { kind: "counter", package: pkg, conditions };
}

// ---------------------------------------------------------------------------
// Package math helpers
// ---------------------------------------------------------------------------

/**
 * Is the claimed competing offer plausible against our band? A figure below the
 * candidate's own walk-away floor or absurdly above what the role can pay is a
 * bluff, not leverage.
 */
function isCredibleLeverageAmount(amount: number, hidden: HiddenState): boolean {
  return amount >= hidden.reservation - 5000 && amount <= maxOfferTotal(hidden) + 20000;
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

  // Room left under the base ceiling: the budget minus every dollar of base
  // already granted above the opening anchor. `granted.base` IS that distance,
  // so subtracting both (as this once did) silently halved the real headroom.
  const baseHeadroom = hidden.budget - (pkg.base - hidden.opening_anchor);
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

/**
 * A lever trade: move a non-base lever, and say a real number while doing it.
 * The old version promised "an extra $5,000 sign-on" even when the flex cap
 * clamped the actual give to less — the recruiter stating a figure that was not
 * on the table, which is the exact class of inconsistency this engine forbids.
 * Trades that moved nothing are gone: they produced no-op counter turns.
 */
function leverTrade(hidden: HiddenState, state: EngineState): RecruiterMove | null {
  const cur = state.currentOffer;
  const room = Math.max(0, (hidden.flex.sign_on_max ?? 0) - (cur.sign_on ?? 0));
  const give = Math.min(room, 5000);
  if (give < MIN_MOVE) return null;
  const pkg: CompPackage = { ...cur, sign_on: roundTo((cur.sign_on ?? 0) + give, 250) };
  const actual = (pkg.sign_on ?? 0) - (cur.sign_on ?? 0);
  if (actual < MIN_MOVE) return null;
  return {
    kind: "trade",
    package: pkg,
    conditions: ["if you can start within three weeks"],
    gave: `a one-time $${actual.toLocaleString("en-US")} sign-on`,
    wants: "an earlier start date",
  };
}

const PROBE_QUESTIONS = [
  "Before we keep going — what matters most to you in this decision?",
  "Help me understand: what would make this package feel right to you?",
  "What's driving the number you have in mind?",
  "If base can't move, what would make the overall package attractive?",
  "What would you need to see to feel good about signing this week?",
  "How does this compare with what else you're looking at?",
];

/** Deterministic rotation so the recruiter never repeats the same question. */
function probeQuestion(seed: number): string {
  const i = Math.abs(Math.floor(seed)) % PROBE_QUESTIONS.length;
  return PROBE_QUESTIONS[i];
}

function informationAnswerQuestion(hidden: HiddenState, state: EngineState): string {
  const levers: string[] = [];
  if ((hidden.flex.sign_on_max ?? 0) > (state.currentOffer.sign_on ?? 0)) levers.push("a sign-on bonus");
  if ((hidden.flex.equity_max ?? 0) > (state.currentOffer.equity ?? 0)) levers.push("equity");
  levers.push("start timing");
  const variants = [
    `There is some flexibility on ${levers.join(" and ")}. Which of those matters most to you?`,
    `Base is the tightest line for me; ${levers[0]} is more workable. What's your priority?`,
    `The structure has room around ${levers.join(" and ")}, not on every line. What would you want to see?`,
  ];
  return variants[Math.abs(state.round) % variants.length];
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

type CompComponent = "base" | "sign_on" | "equity";

/**
 * One source of truth for "which number belongs to which component". It reads
 * the recruiter's spoken offers AND the candidate's labelled asks, so the two
 * cannot drift ("20k sign-on" is never read as a 20k base ask).
 */
const COMPONENT_PATTERNS: Record<CompComponent, RegExp[]> = {
  base: [
    new RegExp(
      String.raw`${AMT}\s*(?:in\s+|of\s+|for\s+)?(?:annual\s+|yearly\s+)?(?:base(?:'?s)?(?:\s*salary)?|salary)\b`,
    ),
    new RegExp(
      String.raw`(?:base(?:\s*salary)?|salary)\s*(?:of|is|at|around|to|would be)?\s*\$?\s?${AMT}`,
    ),
  ],
  equity: [
    new RegExp(
      String.raw`${AMT}\s*(?:in\s+|of\s+|worth of\s+)?(?:annual(?:ized)?\s+)?(?:equity|stock|rsus?)\b`,
    ),
    new RegExp(String.raw`(?:equity|stock|rsus?)\s*(?:of|is|at|worth)?\s*\$?\s?${AMT}`),
  ],
  sign_on: [
    new RegExp(
      String.raw`${AMT}\s*(?:in\s+|of\s+|as\s+a\s+|as\s+)?(?:sign(?:ing)?[- ]?on|signing bonus|sign[- ]on bonus)\b`,
    ),
    new RegExp(
      String.raw`(?:sign(?:ing)?[- ]?on|signing bonus|sign[- ]on bonus)\s*(?:of|is|at|worth)?\s*\$?\s?${AMT}`,
    ),
  ],
};

const TOTAL_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`(?:total package of|total package|package of|total of|all[- ]in|overall package of|total comp(?:ensation)? of|package (?:is|would be))\s*\$?\s?${AMT}`,
  ),
];

/** Component-labelled amounts anywhere in a (lowercased) utterance. */
function labelledComponentAmounts(text: string): {
  base: number | null;
  sign_on: number | null;
  equity: number | null;
} {
  return {
    base: pickAmount(text, ...COMPONENT_PATTERNS.base),
    sign_on: pickAmount(text, ...COMPONENT_PATTERNS.sign_on),
    equity: pickAmount(text, ...COMPONENT_PATTERNS.equity),
  };
}

/** Pull base / sign-on / equity / total out of a recruiter utterance. */
export function extractSpokenPackage(text: string): SpokenPackage {
  const t = offerClauses(text).join(" . ");
  const { base, sign_on: signOn, equity } = labelledComponentAmounts(t);
  const total = pickAmount(t, ...TOTAL_PATTERNS);

  return { base, sign_on: signOn, equity, total };
}

export interface ReconciledOffer {
  /** The authoritative package after reconciliation. */
  pkg: CompPackage;
  previous: CompPackage;
  changed: boolean;
  /**
   * Always false in the current mirror doctrine — the panel shows exactly what
   * the recruiter said, so there is no server-side adjustment to report.
   * Retained for API compatibility with clients that still read it.
   */
  adjusted: boolean;
}

/**
 * Fold a spoken package — or the arguments of an `offer_to_candidate` tool call
 * — into the engine state by MIRRORING it: the panel shows exactly what the
 * recruiter said, the moment it said it, with no server-side reshaping.
 *
 * Reshaping is what broke the candidate's trust before: the recruiter said
 * "155,000 base and 25,000 in annual equity" while the panel displayed the
 * engine's clamped 157,250 / 7,250 / 7,000 — three numbers nobody ever spoke.
 * The recruiter is the single source of truth for what is on the table; the
 * economics engine still governs every number the recruiter is ALLOWED to say
 * via its directives and tool hints (and engine moves still cannot exceed the
 * budget). A hallucinated figure now becomes a scoring signal, not a panel
 * rewrite: the candidate sees the lie and the final report judges it.
 *
 * The one exception is total-only wording ("a total package of 185,000"): no
 * component was spoken, so the current package is rescaled proportionally to
 * that total and the spoken figure is then authoritative on the panel.
 */
export function reconcileSpokenPackage(
  hidden: HiddenState,
  state: EngineState,
  spoken: SpokenPackage,
): ReconciledOffer | null {
  const cur = state.currentOffer;
  const hasComponent = spoken.base != null || spoken.sign_on != null || spoken.equity != null;
  if (!hasComponent && spoken.total == null) return null;

  if (!hasComponent) {
    // Total-only wording: no component was spoken, so the package is rescaled
    // proportionally to mirror the spoken total exactly — the panel total then
    // equals the figure the recruiter said, whatever the engine's own caps are.
    const want = Math.max(0, spoken.total ?? 0);
    if (want === total(cur)) return { pkg: cur, previous: cur, changed: false, adjusted: false };
    const pkg = rescaleToTotal(cur, want);
    return { pkg, previous: cur, changed: true, adjusted: false };
  }

  // Component wording: every spoken component replaces the panel value; every
  // unspoken component keeps its current value.
  const pkg: CompPackage = {
    base: spoken.base ?? cur.base,
    sign_on: spoken.sign_on ?? (cur.sign_on ?? 0),
    equity: spoken.equity ?? (cur.equity ?? 0),
  };
  const changed = total(pkg) !== total(cur);
  return { pkg, previous: cur, changed, adjusted: false };
}

/**
 * Rescale a package to an exact spoken total: scale every component
 * proportionally, then absorb the rounding remainder in the largest component
 * so the panel total equals the spoken total to the dollar.
 */
function rescaleToTotal(cur: CompPackage, want: number): CompPackage {
  const from = total(cur);
  if (from <= 0 || want <= 0) return { base: 0, sign_on: 0, equity: 0 };
  const f = want / from;
  const scale = (v: number | null | undefined) => Math.max(0, Math.round((v ?? 0) * f));
  const pkg: CompPackage = {
    base: scale(cur.base),
    sign_on: scale(cur.sign_on),
    equity: scale(cur.equity),
  };
  const drift = want - total(pkg);
  if (drift !== 0) {
    const signOn = pkg.sign_on ?? 0;
    const equity = pkg.equity ?? 0;
    if (pkg.base >= Math.max(signOn, equity)) pkg.base = Math.max(0, pkg.base + drift);
    else if (signOn >= equity) pkg.sign_on = Math.max(0, signOn + drift);
    else pkg.equity = Math.max(0, equity + drift);
  }
  return pkg;
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
// Transcript hygiene
// ---------------------------------------------------------------------------

/**
 * Normalised form used to decide whether two turns are the same sentence.
 * Case, punctuation and apostrophes are noise; the words and the digits are the
 * signal ("That's 155,000 base." and "thats 155 000 base" are one sentence).
 */
export function transcriptSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,'\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface TranscriptLike {
  role: "user" | "agent";
  text: string;
  atMs?: number | null;
}

/**
 * Collapse consecutive duplicate turns.
 *
 * The voice service occasionally finalises the same utterance twice, which
 * showed up as the recruiter saying an identical sentence back to back — and
 * because the second copy was re-parsed as a fresh offer, the panel could
 * change because of a duplicate rather than because of anything anyone said.
 * Identical text from the same speaker moments apart is a duplicate.
 */
export function dedupeTranscriptTurns<T extends TranscriptLike>(
  turns: T[],
  windowMs = 30_000,
): T[] {
  const out: T[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === turn.role &&
      transcriptSignature(prev.text) === transcriptSignature(turn.text)
    ) {
      const nearEnough =
        prev.atMs == null || turn.atMs == null || Math.abs(turn.atMs - prev.atMs) <= windowMs;
      if (nearEnough) continue;
    }
    out.push(turn);
  }
  return out;
}

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
  /** Turn number after `advanceRound` — used to rotate probe questions. */
  round?: number;
}

/** Rules that bind every turn, whatever the move. */
export const NO_REBALANCE_RULE =
  "Never rebalance the package: base, sign-on and equity are separate components — do not move money from one into another, and never state a component at any value other than the FACT line's.";
export const NO_ARITHMETIC_RULE =
  "Never add, subtract, round or total figures yourself — the only totals you may speak are the ones given to you.";
export const NO_REPEAT_RULE =
  "Do not reuse a package sentence you have already spoken this call, and never restate figures from an earlier turn: the FACT line supersedes everything you said before.";

/**
 * The canonical way to state a package. Shipping the exact figures in the
 * directive (and the same figures in the tool hint) is what makes the spoken
 * offer, the panel and the report agree: the model is left no arithmetic to do
 * and no component to rebalance.
 */
function packageSentence(p: CompPackage): string {
  const parts = [`${p.base.toLocaleString("en-US")} base`];
  if ((p.sign_on ?? 0) > 0) parts.push(`${(p.sign_on ?? 0).toLocaleString("en-US")} sign-on`);
  if ((p.equity ?? 0) > 0) parts.push(`${(p.equity ?? 0).toLocaleString("en-US")} in annual equity`);
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]} — a first-year total of ${total(p).toLocaleString("en-US")}.`;
}

/**
 * Public entry point. Wraps the move-specific directive with the rules that
 * apply to every turn (no deferrals, no rebalancing, no arithmetic, no
 * restating old numbers) and the standing-package facts (what is on the table
 * right now, in exact components, so the model never resurrects a stale or
 * improvised package).
 */
export function buildDirective(
  move: RecruiterMove,
  hidden: HiddenState,
  opts: DirectiveOpts = {},
): TurnDirective {
  const d = buildDirectiveInner(move, hidden, opts);
  for (const rule of [NO_DEFERRAL_RULE, NO_REBALANCE_RULE, NO_ARITHMETIC_RULE, NO_REPEAT_RULE]) {
    if (!d.mustNotSay.includes(rule)) d.mustNotSay.push(rule);
  }
  // The standing package travels with every directive. On counter/trade/accept
  // turns it describes the package the move just put forward; on every other
  // turn it is the last package actually offered — the only numbers the model
  // may restate when the candidate asks "isn't it X now?".
  const standing =
    move.kind === "counter" || move.kind === "trade" || move.kind === "accept" || move.kind === "recover_from_walkaway"
      ? move.package
      : (opts.standingOffer ?? null);
  d.standingOfferLine = standing
    ? `FACT — the package currently on the table is base ${standing.base.toLocaleString("en-US")} dollars${(standing.sign_on ?? 0) > 0 ? `, sign-on ${(standing.sign_on ?? 0).toLocaleString("en-US")} dollars` : ""}${(standing.equity ?? 0) > 0 ? `, annual equity ${(standing.equity ?? 0).toLocaleString("en-US")} dollars` : ""} — a first-year total of ${total(standing).toLocaleString("en-US")} dollars. If the candidate asks about current numbers, these (and only these) are correct; any other figures you remember from earlier are outdated and must not be repeated or summed.`
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
          ? "HOLD FIRM (final) — there is no more room; answer definitively and do not re-open the numbers."
          : "HOLD FIRM — do not move any number this turn.",
        mustSay: move.final
          ? [
              "Answer directly: the numbers on the table are the best you can do and you have no further room — you are the decision-maker, so no other approval is needed.",
              "Sound settled, not apologetic.",
            ]
          : [
              "Reaffirm the current offer's value in your own words.",
              "Ask the candidate to justify the ask or name their evidence.",
            ],
        mustNotSay: [
          "Do not raise the offer or invent any number beyond the standing package.",
          "Do not apologize for the offer.",
        ],
        // The standing package may be restated (it is already on the table);
        // nothing above it may be said.
        allowedNumbers: standing ? allowedNumbersFor(standing) : [],
        askUserQuestion: move.final ? null : probeQuestion(opts.round ?? 1),
        conditions: [],
        toolHint: null,
      };
    }
    case "challenge_leverage": {
      // The standing numbers stay allowed: the recruiter can name what is on the
      // table while refusing to move it. Forbidding every figure here used to
      // contradict the FACT line shipped in the same directive.
      const standing = opts.standingOffer ?? null;
      return {
        verdict: "CHALLENGE the claimed leverage before reacting to it.",
        mustSay: [
          "Ask whether the competing offer is signed and in writing, and ask for the exact figure if they have not given you one.",
          "Ask whether compensation is the only factor in their decision.",
        ],
        mustNotSay: ["Do not increase any number in response to the claim alone."],
        allowedNumbers: standing ? allowedNumbersFor(standing) : [],
        askUserQuestion: null,
        conditions: [],
        toolHint: null,
      };
    }
    case "counter":
      return {
        verdict: "COUNTER — present the following updated package as the company's position.",
        mustSay: [
          `State the new package exactly like this, phrased naturally: "${packageSentence(move.package)}"`,
          `Call offer_to_candidate with base_salary=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0} — the same figures you just said, no others.`,
        ],
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
          `Offer ${move.gave} in exchange for ${move.wants}, using exactly these figures: "${packageSentence(move.package)}"`,
          `State any conditions: ${move.conditions.join("; ") || "none"}.`,
          `Call offer_to_candidate with base_salary=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0} — the same figures, no others.`,
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
          "Agree warmly and confirm the final package once, using exactly these figures.",
          `Say: "${packageSentence(move.package)}"`,
          `Call accept_user_offer with final_base=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0}.`,
        ],
        mustNotSay: [],
        allowedNumbers: allowedNumbersFor(move.package),
        askUserQuestion: null,
        conditions: [],
        toolHint: { accept: true, offer: { final_base: move.package.base, sign_on: move.package.sign_on ?? 0, equity: move.package.equity ?? 0 } },
      };
    case "probe": {
      // The standing package is allowed here on purpose: the rule below grants
      // an explicit exception for restating it, and shipping "ALLOWED NUMBERS:
      // none" alongside that exception made the directive contradict itself.
      const standing = opts.standingOffer ?? null;
      return {
        verdict: "PROBE — no numbers move; gather information.",
        mustSay: ["Ask the candidate the question below naturally."],
        mustNotSay: [
          "Do not volunteer a new package or move any number. If the candidate asks what is currently on the table, restate the FACT package exactly — nothing higher.",
        ],
        allowedNumbers: standing ? allowedNumbersFor(standing) : [],
        askUserQuestion: move.question,
        conditions: [],
        toolHint: null,
      };
    }
    case "recover_from_walkaway":
      return {
        verdict: "RECOVER — the candidate is walking; make one best-and-final style move.",
        mustSay: [
          "Acknowledge their position respectfully.",
          `Present the improved package using exactly these figures: "${packageSentence(move.package)}"`,
          `Call offer_to_candidate with base_salary=${move.package.base}, sign_on=${move.package.sign_on ?? 0}, equity=${move.package.equity ?? 0}.`,
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
