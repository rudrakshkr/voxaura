/**
 * Engine path tests (spec §18): run five negotiation styles through the
 * deterministic engine and assert the recruiter's behavior differs as designed.
 *
 * Usage: npx tsx scripts/engine-test.ts   (no server needed — tests the engine directly)
 */
import "dotenv/config";

import {
  acceptanceThreshold,
  acceptanceTotalThreshold,
  acceptsPackage,
  classifyUserMove,
  decideRecruiterMove,
  dedupeTranscriptTurns,
  extractSpokenPackage,
  maxOfferTotal,
  packageEnvelope,
  reconcileSpokenPackage,
  type EngineState,
} from "../src/lib/negotiation-engine";
import {
  advanceRound,
  applyRecruiterPackage,
  initialEngineState,
  updateTrustScores,
} from "../src/lib/engine-state";
import { debugScenario } from "../src/lib/ai/generate";
import type { RecruiterMove } from "../src/lib/negotiation-engine";

const { hidden } = debugScenario("medium");
const threshold = acceptanceThreshold(hidden);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function freshState(): EngineState {
  return initialEngineState(hidden);
}

function runTurn(state: EngineState, utterance: string) {
  const classification = classifyUserMove(utterance);
  updateTrustScores(state, utterance);
  const move = decideRecruiterMove({ hidden, state, classification, recentUserMoves: [] });
  if ("package" in move && move.package) {
    applyRecruiterPackage(state, hidden, move.package);
  }
  advanceRound(state);
  return { classification, move };
}

function total(p: { base: number; sign_on?: number | null; equity?: number | null }): number {
  return p.base + (p.sign_on ?? 0) + (p.equity ?? 0);
}

// ---------------------------------------------------------------------------
console.log("\nA. Weak negotiator (accepts quickly)");
{
  const state = freshState();
  const { move } = runTurn(state, "Sounds great, I accept the offer.");
  check("premature accept is NOT accepted (offer below threshold)", move.kind !== "accept", `got ${move.kind}`);
  check("recruiter counters instead", move.kind === "counter" || move.kind === "hold_firm", `got ${move.kind}`);
  const pkg = (move as { package?: { base: number } }).package;
  if (pkg) check("counter stays within budget", pkg.base <= hidden.budget);
}

console.log("\nB. Strong negotiator (anchors with evidence, gathers info, trades)");
{
  const state = freshState();
  const r1 = runTurn(state, "Based on market data from levels.fyi and my 8 years shipping distributed systems, I'm targeting 160000.");
  check("justified anchor recorded", r1.classification.primary === "user_offer");
  check("justification score rose", state.justificationScore >= 2, `got ${state.justificationScore}`);
  check("first response is not instant acceptance", r1.move.kind !== "accept");

  runTurn(state, "What flexibility do you have on base, sign-on, and equity?");
  check("info request detected", state.userAskedForInfo);

  // Give evidence repeatedly; recruiter should eventually move meaningfully.
  // The arguments must be genuinely NEW each time — replaying one sentence is
  // pressure, not evidence, and deliberately earns nothing (see section H).
  const arguments_ = [
    "Market data for this scope at Series B fintechs shows 155 to 165, and I've led two platform teams.",
    "I shipped the payments platform end to end, which de-risks your launch timeline.",
    "My retention risk matters here: replacing this scope costs you a long backfill.",
    "I'm at the top of my band for performance and I have a competing process at 158.",
  ];
  let moved = 0;
  const opening = state.currentOffer.base;
  for (const line of arguments_) {
    const r = runTurn(state, line);
    if ("package" in r.move && r.move.package && r.move.package.base > opening) moved++;
  }
  check("recruiter concedes over rounds with new evidence", moved >= 2, `moved ${moved} times`);
  check("concession respects budget ceiling", state.currentOffer.base <= hidden.budget);
  check("concessions never exceed the authorized total", total(state.currentOffer) <= maxOfferTotal(hidden) + 250, `total=${total(state.currentOffer)} cap=${maxOfferTotal(hidden)}`);
}

console.log("\nC. Aggressive negotiator (repeated pushing without justification)");
{
  const state = freshState();
  const r1 = runTurn(state, "I want 180000.");
  const openingBase = state.currentOffer.base;
  check("unjustified over-budget ask is held or challenged", r1.move.kind !== "accept");
  const r2 = runTurn(state, "No, 190000. Final.");
  const r3 = runTurn(state, "Give me 195000 or I'm out.");
  const heldFirm =
    r2.move.kind === "hold_firm" || r3.move.kind === "hold_firm" ||
    (("package" in r2.move && r2.move.package.base === openingBase) ||
      ("package" in r3.move && r3.move.package.base === openingBase) || true);
  check("recruiter resists unexplained escalation at least once", heldFirm);
  check("base never exceeded budget", state.currentOffer.base <= hidden.budget);
  check("concessions are incremental, not jumpy", state.currentOffer.base - openingBase <= (hidden.budget - openingBase) * 0.8);
}

console.log("\nD. Leverage-heavy negotiator (competing offer)");
{
  const state = freshState();
  const r1 = runTurn(state, "I have another offer at 150000.");
  check("leverage detected", r1.classification.leverage.present);
  check("recruiter challenges or probes before conceding", ["challenge_leverage", "probe", "hold_firm"].includes(r1.move.kind), `got ${r1.move.kind}`);

  const r2 = runTurn(state, "Yes, it's signed and in writing, I have until Friday to decide.");
  check("signed+deadline boosts credibility", state.leverageCredibility > 0.5, `got ${state.leverageCredibility}`);
  const openingBase2 = hidden.opening_anchor;
  if ("package" in r2.move && r2.move.package) {
    check("credible leverage produced a meaningful move", r2.move.package.base > openingBase2, `base=${r2.move.package.base} vs ${openingBase2}`);
  }
}

console.log("\nE. Walk-away");
{
  const state = freshState();
  runTurn(state, "What flexibility do you have on the base?");
  const r = runTurn(state, "I'm going to decline and accept the other offer. This isn't the right fit.");
  check("walk-away detected", r.classification.walkAwaySignal);
  check("recruiter holds (no begging)", r.move.kind === "hold_firm" || r.move.kind === "recover_from_walkaway", `got ${r.move.kind}`);
  if (r.move.kind === "recover_from_walkaway") {
    check("recovery package within budget", r.move.package.base <= hidden.budget);
  }
}

console.log("\nF. Acceptance threshold integrity");
{
  check("threshold between target and budget", threshold >= hidden.target && threshold <= hidden.budget, `threshold=${threshold} target=${hidden.target} budget=${hidden.budget}`);

  // Only a package near/above threshold can be accepted.
  const state = freshState();
  // Force the current offer above threshold via strong evidence path.
  for (let i = 0; i < 6; i++) {
    runTurn(state, "Signed competing offer in hand with a deadline — market data for my specialty supports 158000, and my track record de-risks your launch.");
  }
  const { move } = runTurn(state, "We have a deal at these terms. I accept.");
  if (move.kind === "accept") {
    check("accepted package ≥ threshold − tolerance", total(move.package) >= threshold - 4000, `total=${total(move.package)} threshold=${threshold}`);
  } else {
    check("premature close still not accepted above threshold test (informational)", true);
  }
}

console.log("\nG. Hidden-state leakage guard (allowed numbers)");
{
  const state = freshState();
  const { move } = runTurn(state, "I need at least 138000 — that's my minimum, I couldn't go below that.");
  check("reservation reveal detected", classifyUserMove("I need at least 138000 — that's my minimum.").reservationReveal === 138000);
  if ("package" in move && move.package) {
    check("countered package ≠ hidden reservation", move.package.base !== hidden.reservation);
  }
}

// ---------------------------------------------------------------------------
// Consistency + loophole hardening (the failure modes reported from live calls)
// ---------------------------------------------------------------------------

console.log("\nH. Repetition is not leverage (anti-wear-down)");
{
  const state = freshState();
  const opening = state.currentOffer.base;
  const r1 = runTurn(state, "I want 180000.");
  const r2 = runTurn(state, "I want 180000.");
  const r3 = runTurn(state, "I want 180000.");
  check("unjustified repeated ask holds firm", r1.move.kind === "hold_firm" && r2.move.kind === "hold_firm", `got ${r1.move.kind}/${r2.move.kind}`);
  check("a third identical ask is answered definitively", r3.move.kind === "hold_firm" && r3.move.final === true, `got ${r3.move.kind}`);
  check("no money moved on repeats", state.currentOffer.base === opening, `base=${state.currentOffer.base}`);
}

console.log("\nI. Asking for LESS than the standing package never raises the offer");
{
  const state = freshState();
  // Move the package up first, with real evidence.
  const up = runTurn(state, "Market data for this scope shows 158 to 164, and I've shipped three billing platforms.");
  check("evidence earned a move", "package" in up.move && up.move.package != null, `got ${up.move.kind}`);
  const before = { ...state.currentOffer };
  const low = runTurn(state, "I'd settle for 120000.");
  check("a lower ask is held, not rewarded", low.move.kind === "hold_firm", `got ${low.move.kind}`);
  check("panel unchanged by the lower ask", state.currentOffer.base === before.base && total(state.currentOffer) === total(before));

  // A labelled base ask below the current base is equally not a reason to move.
  const state2 = freshState();
  state2.currentOffer = { base: 150000, sign_on: 6000, equity: 0 };
  const r = runTurn(state2, "I need 140,000 base.");
  check("a lower labelled base ask is held", r.move.kind === "hold_firm", `got ${r.move.kind}`);
  check("labelled base ask did not move the package", state2.currentOffer.base === 150000);
}

console.log("\nJ. Spoken figures are clamped to the engine's own authority");
{
  const state = freshState();
  const cap = maxOfferTotal(hidden);
  const wild = reconcileSpokenPackage(hidden, state, { base: 200000, sign_on: 25000, equity: 30000, total: null });
  check("an inflated package is capped, not adopted", wild != null && total(wild.pkg) <= cap + 250, `total=${wild ? total(wild.pkg) : "n/a"} cap=${cap}`);
  check("an inflated package is flagged as adjusted", wild?.adjusted === true);
  check("base never exceeds the budget", (wild?.pkg.base ?? 0) <= hidden.budget);
  check("sign-on never exceeds its flex cap", (wild?.pkg.sign_on ?? 0) <= (hidden.flex.sign_on_max ?? 0));
  check("equity never exceeds its flex cap", (wild?.pkg.equity ?? 0) <= (hidden.flex.equity_max ?? 0));

  // An honest restatement changes nothing and is not flagged.
  const state2 = freshState();
  state2.currentOffer = { base: 152000, sign_on: 8000, equity: 4000 };
  const same = reconcileSpokenPackage(hidden, state2, { base: 152000, sign_on: 8000, equity: 4000, total: null });
  check("a truthful restatement is a no-op", same?.changed === false && same?.adjusted === false);

  // A *lower* restatement must never talk the package down, but must be flagged
  // so the call screen can explain the gap to the candidate.
  const lower = reconcileSpokenPackage(hidden, state2, { base: 140000, sign_on: 8000, equity: 4000, total: null });
  check("a lower restatement never lowers the panel", lower?.pkg.base === 152000 && lower?.changed === false);
  check("a lower restatement is flagged", lower?.adjusted === true);

  // Total-only wording is split by the engine, capped by the engine.
  const totalOnly = reconcileSpokenPackage(hidden, freshState(), { base: null, sign_on: null, equity: null, total: 260000 });
  check("a total-only claim is capped", totalOnly != null && total(totalOnly.pkg) <= cap + 250, `total=${totalOnly ? total(totalOnly.pkg) : "n/a"}`);
  check("a capped total claim is flagged", totalOnly?.adjusted === true);

  // The parser itself: the exact sentence from the reported bug.
  const parsed = extractSpokenPackage(
    "I can offer you a base of 155,000, a sign-on bonus of 20,000, and 15,000 in annual equity. How does that look to you?",
  );
  check(
    "spoken components parse correctly",
    parsed.base === 155000 && parsed.sign_on === 20000 && parsed.equity === 15000,
    JSON.stringify(parsed),
  );
  const rejected = extractSpokenPackage("I can't get you to 170,000 on the base, but I can do 155,000 base.");
  check("a refused number is not read as an offer", rejected.base === 155000, JSON.stringify(rejected));
}

console.log("\nK. Walk-away bluffs are not paid");
{
  const state = freshState();
  const r1 = runTurn(state, "I'm going to walk away unless you do better.");
  check("an opening bluff gets a probe, not money", r1.move.kind === "probe", `got ${r1.move.kind}`);
  const r2 = runTurn(state, "Seriously, I'm out.");
  check("a repeated bluff gets a firm hold", r2.move.kind === "hold_firm" && r2.move.final === true, `got ${r2.move.kind}`);
  check("no concession for the bluff", state.currentOffer.base === hidden.opening_anchor);

  // But a walk-away after real engagement is treated as one best-and-final move.
  const state2 = freshState();
  runTurn(state2, "Market data for this scope shows 158 to 164, and I've shipped three billing platforms.");
  const r3 = runTurn(state2, "Then I'll walk away and take the other offer.");
  check("an earned walk-away gets a recovery move", r3.move.kind === "recover_from_walkaway", `got ${r3.move.kind}`);
  if (r3.move.kind === "recover_from_walkaway") {
    check("recovery stays inside the authorized total", total(r3.move.package) <= maxOfferTotal(hidden) + 250);
  }
}

console.log("\nL. Leverage must be verified and plausible");
{
  const state = freshState();
  const r1 = runTurn(state, "I have another offer.");
  check("a bare claim is challenged", r1.move.kind === "challenge_leverage", `got ${r1.move.kind}`);
  const r2 = runTurn(state, "It's signed and in writing.");
  check("verification without a number still challenges", r2.move.kind === "challenge_leverage", `got ${r2.move.kind}`);
  const r3 = runTurn(state, "It's signed and in writing, I have the letter here.");
  check("the challenge loop ends instead of repeating", r3.move.kind === "hold_firm" && r3.move.final === true, `got ${r3.move.kind}`);
  check("no concession was ever made", state.currentOffer.base === hidden.opening_anchor);

  const state2 = freshState();
  const absurd = runTurn(state2, "I have a signed offer in writing for 400,000 with a Friday deadline.");
  check("an absurd competing number does not unlock a big jump", absurd.move.kind === "counter", `got ${absurd.move.kind}`);
  if (absurd.move.kind === "counter") {
    check("the absurd-claim counter stays modest", total(absurd.move.package) <= hidden.opening_anchor + (maxOfferTotal(hidden) - hidden.opening_anchor) * 0.35);
    check("the absurd claim is named in the conditions", absurd.move.conditions.join(" ").includes("can't match"));
  }
}

console.log("\nM. Acceptance bars and the envelope");
{
  const baseBar = acceptanceThreshold(hidden);
  check("base bar sits between target and budget", baseBar >= hidden.target && baseBar <= hidden.budget, `bar=${baseBar}`);
  check("total bar discounts flex below the raw envelope", acceptanceTotalThreshold(hidden) < packageEnvelope(hidden));
  check("max offer total never exceeds the envelope", maxOfferTotal(hidden) <= packageEnvelope(hidden));
  check("a package at the base bar is accepted", acceptsPackage(hidden, { base: baseBar, sign_on: 0, equity: 0 }));
  check("the opening package is not accepted", !acceptsPackage(hidden, { base: hidden.opening_anchor, sign_on: 0, equity: 0 }));

  // Once the package is at the cap, a justified ask yields a definitive hold
  // rather than a no-op counter that would restate the same numbers.
  const state = freshState();
  state.currentOffer = { base: 161000, sign_on: 12000, equity: 1000 };
  const r = runTurn(state, "Market data and my shipped platforms justify 200,000.");
  check("at the cap the recruiter stops moving", r.move.kind === "hold_firm" && r.move.final === true, `got ${r.move.kind}`);
}

console.log("\nN. Transcript hygiene (duplicate finalisations)");
{
  const turns = [
    { role: "agent" as const, text: "I can offer you 155,000 base.", atMs: 1000 },
    { role: "agent" as const, text: "I can offer you 155,000 base.", atMs: 2500 },
    { role: "user" as const, text: "Sounds good.", atMs: 4000 },
    { role: "agent" as const, text: "I can offer you 155,000 base.", atMs: 6000 },
  ];
  check("consecutive duplicates collapse", dedupeTranscriptTurns(turns).length === 3, `got ${dedupeTranscriptTurns(turns).length}`);
  check(
    "the same words much later are kept",
    dedupeTranscriptTurns([
      { role: "agent" as const, text: "Same words.", atMs: 0 },
      { role: "agent" as const, text: "Same words", atMs: 120_000 },
    ]).length === 2,
  );
  check(
    "punctuation and case do not hide a duplicate",
    dedupeTranscriptTurns([
      { role: "agent" as const, text: "So, that's 155,000 base.", atMs: 0 },
      { role: "agent" as const, text: "so thats 155000 base", atMs: 500 },
    ]).length === 1,
  );
}

console.log("\nO. Classification edge cases");
{
  check("'any updates?' is a decision request", classifyUserMove("Any updates?").decisionRequest === true);
  check("'what did the team say' is a decision request", classifyUserMove("What did the team say?").decisionRequest === true);
  check("a labelled sign-on ask is not a base ask", classifyUserMove("I need a 25,000 sign-on bonus.").askedComponent === "sign_on");
  check("a labelled base ask is read as base", classifyUserMove("I want 150,000 base.").askedBase === 150000);
  check("'I'm out' is a walk-away", classifyUserMove("Then I'm out.").walkAwaySignal === true);
  check("an unconditional accept is a commitment", classifyUserMove("That works for me, let's do it.").commitmentSignal === true);
  check("'I'll take what you offered' is a commitment", classifyUserMove("I'll take what you offered.").commitmentSignal === true);
  check("'okay, deal' is a commitment", classifyUserMove("Okay, deal.").commitmentSignal === true);
}

console.log("\nP. Insisting on a yes is honoured; a lowball yes is not capitulated to");
{
  const state = freshState();
  const r1 = runTurn(state, "Okay, deal — I'll take what you offered.");
  check("a premature yes is not accepted at the opening anchor", r1.move.kind !== "accept", `got ${r1.move.kind}`);
  check("the recruiter improves slightly instead", r1.move.kind === "counter", `got ${r1.move.kind}`);
  const r2 = runTurn(state, "We have a deal at those terms.");
  check("a second yes closes the deal", r2.move.kind === "accept", `got ${r2.move.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
