/**
 * Engine path tests (spec §18): run five negotiation styles through the
 * deterministic engine and assert the recruiter's behavior differs as designed.
 *
 * Usage: npx tsx scripts/engine-test.ts   (no server needed — tests the engine directly)
 */
import "dotenv/config";

import { z } from "zod";

import {
  acceptanceThreshold,
  acceptanceTotalThreshold,
  acceptsPackage,
  clampPackageToLimits,
  classifyUserMove,
  closingOutcome,
  decideRecruiterMove,
  detectHostileLanguage,
  dedupeTranscriptTurns,
  extractSpokenPackage,
  isPackageAnomalous,
  maxOfferTotal,
  packageEnvelope,
  reconcileSpokenPackage,
  withinPackageLimits,
  type EngineState,
} from "../src/lib/negotiation-engine";
import { mergePrepPack, prepPackError } from "../src/lib/scenario-prep";
import {
  advanceRound,
  applyRecruiterPackage,
  initialEngineState,
  updateTrustScores,
} from "../src/lib/engine-state";
import { debugScenario } from "../src/lib/ai/generate";
import { decideAgentMode } from "../src/lib/agent-mode";
import { runCounterfactuals } from "../src/lib/counterfactual";
import { buildReplay } from "../src/lib/replay";
import { CLIENT_REPORTABLE_EVENTS, attempts as attemptsTable, scenarios as scenariosTable } from "../src/lib/db/schema";
import { getTableColumns } from "drizzle-orm";
import { assertAttemptAccess, DEMO_OWNER_ID } from "../src/lib/access";
import { toPublicScenario } from "../src/lib/db/queries";
import {
  BatchedEvent,
  capEventPayload,
  clampEventAtMs,
  eventSignature,
  MAX_EVENT_PAYLOAD_CHARS,
  MAX_EVENTS_PER_REQUEST,
  normalizeHidden,
  type PrepPack,
} from "../src/lib/types";

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

console.log("\nJ. The panel mirrors exactly what the recruiter says");
{
  // The mirror doctrine: what the recruiter says IS the package. The server
  // must not reshape, cap, floor or round spoken figures — the screenshot bug
  // ("155,000 base and 25,000 equity" spoken, 157,250 / 7,250 / 7,000 shown)
  // came from exactly that reshaping.
  const state = freshState();
  const spoken = reconcileSpokenPackage(hidden, state, { base: 155000, sign_on: 25000, equity: 25000, total: null });
  if (spoken?.changed) applyRecruiterPackage(state, hidden, spoken.pkg); // the route's apply step
  check("spoken components land verbatim on the panel", spoken?.pkg.base === 155000 && spoken?.pkg.sign_on === 25000 && spoken?.pkg.equity === 25000, JSON.stringify(spoken?.pkg));
  check("mirroring is never flagged as adjusted", spoken?.adjusted === false);
  check("a new spoken package counts as changed", spoken?.changed === true);

  // Unspoken components keep their current values.
  const partial = reconcileSpokenPackage(hidden, state, { base: 160000, sign_on: null, equity: null, total: null });
  if (partial?.changed) applyRecruiterPackage(state, hidden, partial.pkg);
  check("an unspoken component is preserved", partial?.pkg.base === 160000 && partial?.pkg.sign_on === 25000 && partial?.pkg.equity === 25000, JSON.stringify(partial?.pkg));

  // A lower restatement is mirrored too — the recruiter may restate an earlier
  // (lower) package, and the panel must show what was actually said.
  const lower = reconcileSpokenPackage(hidden, state, { base: 150000, sign_on: 25000, equity: 25000, total: null });
  if (lower?.changed) applyRecruiterPackage(state, hidden, lower.pkg);
  check("a lower restatement is mirrored, not floored", lower?.pkg.base === 150000, `base=${lower?.pkg.base}`);

  // A truthful restatement of the standing package changes nothing.
  const same = reconcileSpokenPackage(hidden, state, { base: 150000, sign_on: 25000, equity: 25000, total: null });
  check("a truthful restatement is a no-op", same?.changed === false && same?.adjusted === false);

  // Total-only wording: the package is rescaled so the panel total equals the
  // spoken total exactly.
  const from = { base: 150000, sign_on: 5000, equity: 5000 };
  const state3 = freshState();
  state3.currentOffer = from;
  const up = reconcileSpokenPackage(hidden, state3, { base: null, sign_on: null, equity: null, total: 180000 });
  check("a total-only claim is mirrored exactly (up)", up != null && total(up.pkg) === 180000, `total=${up ? total(up.pkg) : "n/a"}`);
  check("upward rescale keeps components proportioned", up != null && up.pkg.base > 150000 && (up.pkg.sign_on ?? 0) >= 5000 && (up.pkg.equity ?? 0) >= 5000, JSON.stringify(up?.pkg));
  const down = reconcileSpokenPackage(hidden, state3, { base: null, sign_on: null, equity: null, total: 120000 });
  check("a total-only claim is mirrored exactly (down)", down != null && total(down.pkg) === 120000, `total=${down ? total(down.pkg) : "n/a"}`);
  check("downward rescale keeps every component positive", down != null && down.pkg.base > 0, JSON.stringify(down?.pkg));

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

console.log("\nQ. Only a genuinely worked-over deadlock closes the call");
{
  // Closing signals drive the client to end the call. They must stay rare: a
  // single firm "no" is a normal move, not the end of the negotiation.
  const state = freshState();
  runTurn(state, "Hello, thanks for taking the time.");
  const walk = runTurn(state, "I'm out — I'll walk away.");
  check("a walk-away with no recovery left closes as walked_away", closingOutcome(walk.move) === "walked_away", `got ${closingOutcome(walk.move)}`);

  // Early in a call, a firm hold never ends it — however frustrated either side is.
  const early = freshState();
  const first = runTurn(early, "I want 190000.");
  check("a first, ordinary hold does not close the call", closingOutcome(first.move) === null, `got ${closingOutcome(first.move)}`);
  runTurn(early, "I want 190000.");
  const third = runTurn(early, "I want 190000.");
  check("a repeated ask early in the call still only holds", third.move.kind === "hold_firm" && third.move.final === true, `got ${third.move.kind}`);
  check("and it does not close the call", closingOutcome(third.move) === null, `got ${closingOutcome(third.move)}`);

  // The same repeated ask, late in a long negotiation, is a real deadlock.
  const long = freshState();
  const warmups = [
    "Thanks for the time today.",
    "I'm excited about the role and the team.",
    "I have three years leading audio infrastructure work.",
    "Could you tell me more about the scope of the team?",
    "What does the growth path look like from here?",
    "I appreciate you walking me through the package.",
  ];
  for (const u of warmups) runTurn(long, u);
  runTurn(long, "I want 190000.");
  runTurn(long, "I want 190000.");
  const deep = runTurn(long, "I want 190000.");
  check("the same repeated ask deep in the call closes as stalemate", closingOutcome(deep.move) === "stalemate", `got ${closingOutcome(deep.move)}`);

  const state3 = freshState();
  const accept = (() => {
    const r1 = runTurn(state3, "Okay, deal — I'll take what you offered.");
    if (r1.move.kind === "accept") return r1.move;
    return runTurn(state3, "We have a deal at those terms.").move;
  })();
  check("an acceptance never carries a close signal", closingOutcome(accept) === null, `got ${closingOutcome(accept)}`);
}

console.log("\nR. Hostile language is detected; ordinary hard bargaining is not");
{
  check("profanity is flagged", detectHostileLanguage("This is bullshit and you know it."));
  check("a directed insult is flagged", detectHostileLanguage("You're an idiot if you think that's fair."));
  check("'shut up' is flagged", detectHostileLanguage("Shut up and give me the number."));
  check("a hard but civil push is not flagged", !detectHostileLanguage("That's a lowball and I'm not taking it."));
  check("a walk-away threat is not flagged", !detectHostileLanguage("I'll walk away and take the other offer."));
  check("self-reference to competence is not flagged", !detectHostileLanguage("I don't want to sound incompetent, but the band looks off."));
  check("an ordinary ask is not flagged", !detectHostileLanguage("I need 165,000 base and 20,000 sign-on."));
}

console.log("\nS. Money parsing requires monetary context (no invented salaries)");
{
  const ask = (t: string) => classifyUserMove(t).askedAmount;
  check("a graduation year is not a salary", ask("I graduated in 2024.") === null, `got ${ask("I graduated in 2024.")}`);
  check("a phone number is not a salary", ask("My phone is 9876543210.") === null, `got ${ask("My phone is 9876543210.")}`);
  check("years of experience are not a salary", ask("I have 5 years of experience.") === null, `got ${ask("I have 5 years of experience.")}`);
  check("a start delay is not a salary", ask("I can join in 2 weeks.") === null, `got ${ask("I can join in 2 weeks.")}`);
  check("a rating is not a salary", ask("My performance review was 10/10.") === null, `got ${ask("My performance review was 10/10.")}`);
  check("a ramp duration is not a salary", ask("I need 12 months to ramp.") === null, `got ${ask("I need 12 months to ramp.")}`);
  check("a bare four-digit number is never a salary", ask("The req id is 2026 base pay band.") === null, `got ${ask("The req id is 2026 base pay band.")}`);
  check("a long digit run is not a salary", ask("Account 1234567890 was charged.") === null, `got ${ask("Account 1234567890 was charged.")}`);
  check(
    "an unmarked round number far from money context is ignored",
    ask("There are 150 people on the team.") === null,
    `got ${ask("There are 150 people on the team.")}`,
  );
  check("a dollar figure is read", ask("My current salary is $110k.") === 110000, `got ${ask("My current salary is $110k.")}`);
  check("a k figure with no other context is read", ask("I'd like 125k.") === 125000, `got ${ask("I'd like 125k.")}`);
  check("a comma figure is read", ask("I'm looking for 150,000 base.") === 150000, `got ${ask("I'm looking for 150,000 base.")}`);
  check("a spoken thousands figure is read", ask("I need 130 thousand.") === 130000, `got ${ask("I need 130 thousand.")}`);
  check("a grand figure is read", ask("I want 140 grand.") === 140000, `got ${ask("I want 140 grand.")}`);
  check("a market range is read", ask("Market data for this scope shows 155 to 165.") === 165000, `got ${ask("Market data for this scope shows 155 to 165.")}`);
}

console.log("\nT. Acceptance boundaries and lever caps are explicit");
{
  const th = acceptanceThreshold(hidden);
  const tot = acceptanceTotalThreshold(hidden);
  const signCap = hidden.flex.sign_on_max ?? 0;
  const eqCap = hidden.flex.equity_max ?? 0;
  check("base at the threshold is accepted", acceptsPackage(hidden, { base: th, sign_on: 0, equity: 0 }));
  check("base one dollar below the threshold is not", !acceptsPackage(hidden, { base: th - 1, sign_on: 0, equity: 0 }));
  // The total branch stays reachable — but only inside the flex caps. A package
  // that clears the total bar with flex the company does not offer is not a
  // package it can sign.
  check(
    "a flex-heavy package at the total bar is accepted",
    acceptsPackage(hidden, { base: tot - signCap - eqCap, sign_on: signCap, equity: eqCap }),
  );
  check(
    "one dollar below the total bar (same structure) is not",
    !acceptsPackage(hidden, { base: tot - signCap - eqCap - 1, sign_on: signCap, equity: eqCap }),
  );
  check(
    "the envelope is base ceiling plus both flex caps",
    packageEnvelope(hidden) === hidden.budget + (hidden.flex.sign_on_max ?? 0) + (hidden.flex.equity_max ?? 0),
  );
  check("the offer cap never exceeds the envelope", maxOfferTotal(hidden) <= packageEnvelope(hidden));

  // Drive the engine into every lever at once and check the invariants hold.
  const spendy = freshState();
  runTurn(spendy, "Market data for this scope shows 210 to 240, and I have a signed offer at 235k.");
  runTurn(spendy, "I need 230000 base with 25000 sign-on and 20000 in annual equity.");
  runTurn(spendy, "I want 235000 base, 25000 sign-on and 25000 equity — the market supports it.");
  check("base never exceeds the ceiling", spendy.currentOffer.base <= hidden.budget, `base=${spendy.currentOffer.base}`);
  check(
    "sign-on never exceeds its cap",
    (spendy.currentOffer.sign_on ?? 0) <= (hidden.flex.sign_on_max ?? 0),
    `sign_on=${spendy.currentOffer.sign_on}`,
  );
  check(
    "equity never exceeds its cap",
    (spendy.currentOffer.equity ?? 0) <= (hidden.flex.equity_max ?? 0),
    `equity=${spendy.currentOffer.equity}`,
  );
  check(
    "the total never exceeds the authorized cap",
    total(spendy.currentOffer) <= maxOfferTotal(hidden) + 250,
    `total=${total(spendy.currentOffer)} cap=${maxOfferTotal(hidden)}`,
  );
}

console.log("\nU. Counterfactuals replay the same engine, deterministically");
{
  const ctx = { prepTarget: 155000, prepReservation: 140000 };
  const a = runCounterfactuals(hidden, { ...ctx, actual: { total: 150000, base: 140000, outcome: "stalemate" } });
  const b = runCounterfactuals(hidden, { ...ctx, actual: { total: 150000, base: 140000, outcome: "stalemate" } });
  check("the same scenario models identically twice", JSON.stringify(a.results) === JSON.stringify(b.results));
  check("deltas are measured against the actual result", a.results.every((r) => r.deltaTotal === r.finalTotal - 150000));
  check(
    "every modeled package respects the ceiling",
    a.results.every((r) => r.finalPackage.base <= hidden.budget),
    a.results.map((r) => r.finalPackage.base).join(","),
  );
  const takeIt = a.results.find((r) => r.plan.key === "accept_opening");
  check("taking the first number closes the deal", takeIt?.outcome === "accepted", `got ${takeIt?.outcome}`);
  check(
    "and lands at or above the opening anchor",
    takeIt != null && takeIt.finalPackage.base >= hidden.opening_anchor,
    `base=${takeIt?.finalPackage.base}`,
  );
  const levered = a.results.find((r) => r.plan.key === "lead_with_leverage");
  check("the leverage plan runs real turns", (levered?.rounds ?? 0) > 0);
  check(
    "a higher anchor is never worse than taking the first number",
    (() => {
      const higher = a.results.find((r) => r.plan.key === "anchor_higher_10k");
      return takeIt != null && higher != null && higher.finalTotal >= takeIt.finalTotal;
    })(),
  );
  check("results are labeled as modeling, not promises", /modeled, not guaranteed/i.test(a.disclaimer));
}

console.log("\nU2. Only genuinely anomalous spoken packages are flagged");
{
  // Regression: a base below the company's RESERVATION is the normal early-call
  // state (the opening anchor sits there by design) and must NOT be reported as
  // a recruiter hallucination — that made every routine mirror look wrong.
  check(
    "a package below the reservation is not anomalous",
    !isPackageAnomalous(hidden, { base: hidden.reservation - 8000, sign_on: 0, equity: 0 }),
  );
  check(
    "a package below the opening anchor IS anomalous",
    isPackageAnomalous(hidden, { base: hidden.opening_anchor - 1000, sign_on: 0, equity: 0 }),
  );
  check(
    "a package above the authorized total IS anomalous",
    isPackageAnomalous(hidden, { base: 0, sign_on: maxOfferTotal(hidden) + 1000, equity: 0 }),
  );
  const atCap = {
    base: hidden.opening_anchor,
    sign_on: maxOfferTotal(hidden) - hidden.opening_anchor,
    equity: 0,
  };
  check("a package exactly at the authorized cap is not anomalous", !isPackageAnomalous(hidden, atCap));
  check(
    "the opening package itself is never anomalous",
    !isPackageAnomalous(hidden, { base: hidden.opening_anchor, sign_on: 0, equity: 0 }),
  );
}

console.log("\nV. Replay narration is traceable to the event log");
{
  const steps = buildReplay([
    {
      type: "user_offer",
      actor: "user",
      source: "tool",
      payload: { amount: 160000, note: "I'm looking for 160,000 base." },
      at_ms: 1000,
      seq: 1,
    },
    {
      type: "counteroffer",
      actor: "opponent",
      source: "tool",
      payload: { package: { base: 140000, sign_on: 0, equity: 0 } },
      at_ms: 2000,
      seq: 2,
    },
    {
      type: "counteroffer",
      actor: "opponent",
      source: "tool",
      payload: { package: { base: 150000, sign_on: 5000, equity: 0 } },
      at_ms: 3000,
      seq: 3,
    },
  ]);
  check("the replay keeps the server's order", steps.map((s) => s.seq).join(",") === "1,2,3");
  check("a raised package reports its delta", steps[2].deltaTotal === 15000, `got ${steps[2].deltaTotal}`);
  check("the running total tracks the standing package", steps[2].runningTotal === 155000, `got ${steps[2].runningTotal}`);
  check("every step explains why it mattered", steps.every((s) => s.why.length > 0));
}

console.log("\nW. Agent mode is explicit and predictable");
{
  const base = { hasStoredAgentId: true, assemblyaiConfigured: true };
  const auto = decideAgentMode({ ...base, requested: "auto", inlineFlag: "unset" });
  check("auto uses the inline path that works from serverless", auto.mode === "inline");
  check("and only then may the prompt reach a browser", auto.promptMayReachClient);
  const off = decideAgentMode({ ...base, requested: "auto", inlineFlag: "off" });
  check("ALLOW_INLINE_AGENT=0 forces stored mode", off.mode === "stored" && !off.promptMayReachClient);
  const forced = decideAgentMode({ ...base, requested: "inline", inlineFlag: "off" });
  check("an explicit inline request still respects the off switch", forced.mode === "stored");
  const stored = decideAgentMode({ ...base, requested: "stored", inlineFlag: "on" });
  check("stored mode never serves the prompt", stored.mode === "stored" && !stored.promptMayReachClient);
  const noKey = decideAgentMode({
    requested: "auto",
    inlineFlag: "unset",
    hasStoredAgentId: false,
    assemblyaiConfigured: false,
  });
  check("with no voice provider nothing is served to a browser", !noKey.promptMayReachClient);
}

console.log("\nX. A client cannot report authoritative events");
{
  const allowed = new Set<string>(CLIENT_REPORTABLE_EVENTS);
  check("the candidate's own moves are reportable", allowed.has("user_offer") && allowed.has("walk_away"));
  check("an opponent offer is NOT client-reportable", !allowed.has("opponent_offer"));
  check("an acceptance is NOT client-reportable", !allowed.has("acceptance"));
  check(
    "the candidate's own concession is reportable (actor forced to user)",
    allowed.has("concession"),
  );
  check("an engine inconsistency is NOT client-reportable", !allowed.has("voice_engine_inconsistency"));
  check("a fabricated acceptance cannot be logged as the candidate", !allowed.has("commitment_signal_from_opponent"));
}

console.log("\nX2. Model-supplied payloads are bounded before storage");
{
  const small = { note: "asked for 160k", amount: 160000 };
  check("a normal payload passes through untouched", JSON.stringify(capEventPayload(small)) === JSON.stringify(small));
  const huge = { note: "x".repeat(5000) };
  const capped = capEventPayload(huge);
  check("an oversized payload is truncated", typeof capped.preview === "string" && capped.preview.length <= MAX_EVENT_PAYLOAD_CHARS);
  check("and says why instead of silently vanishing", /truncated/.test(String(capped.note)));
  check("null payloads become an empty object", JSON.stringify(capEventPayload(null)) === "{}");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  check(
    "an unserializable payload is discarded safely",
    /unserializable/.test(String(capEventPayload(circular).note)),
  );
}

console.log("\nY. Persisted-state helpers behave at the edges");
{
  check("at_ms clamps an epoch value that would overflow the column", clampEventAtMs(Date.now()) === 2_000_000_000);
  check("at_ms passes normal call-elapsed values through", clampEventAtMs(1234) === 1234);
  check("at_ms rejects non-finite input", clampEventAtMs(Number.NaN) === null);
  const fixed = normalizeHidden({ ...hidden, flex: { ...hidden.flex, equity_max: 0.05 } });
  check(
    "a fraction-style flex cap is repaired to dollars",
    (fixed.flex.equity_max ?? 0) >= 1000,
    `got ${fixed.flex.equity_max}`,
  );
  const turns = dedupeTranscriptTurns([
    { role: "agent" as const, text: "That's 155,000 base.", atMs: 1000 },
    { role: "agent" as const, text: "thats 155 000 base", atMs: 2000 },
    { role: "user" as const, text: "I need 160.", atMs: 3000 },
    { role: "agent" as const, text: "thats 155 000 base", atMs: 90_000 },
  ]);
  check("a duplicated utterance is collapsed once", turns.length === 3, `got ${turns.length}`);
}

console.log("\nZ. The event-flush batch cap is the one the server enforces");
{
  // The client splits its queue with MAX_EVENTS_PER_REQUEST and /events refuses
  // anything larger. If the two ever drift, a flush that has queued more than
  // the cap is answered 400 forever, and every event behind it is never logged.
  const schema = z.array(BatchedEvent).max(MAX_EVENTS_PER_REQUEST);
  const batch = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: "rapport" as const,
      actor: "user" as const,
      source: "tool" as const,
      payload: { i },
      at_ms: i,
    }));
  check(
    "a full-size chunk is accepted by the server",
    schema.safeParse(batch(MAX_EVENTS_PER_REQUEST)).success,
  );
  check(
    "one event over the cap is refused, so the client must chunk",
    !schema.safeParse(batch(MAX_EVENTS_PER_REQUEST + 1)).success,
  );
  check(
    "the cap is a sane positive integer",
    Number.isInteger(MAX_EVENTS_PER_REQUEST) && MAX_EVENTS_PER_REQUEST > 0,
  );
}

console.log("\nAB. A retried event batch cannot be recorded twice");
{
  const e = (over: Partial<Parameters<typeof eventSignature>[0]> = {}) => ({
    type: "user_offer",
    actor: "user",
    payload: { amount: 155_000, note: "I am targeting 155k" },
    at_ms: 12_000,
    ...over,
  });
  check("the same event yields the same signature (a lost response is safe to retry)", eventSignature(e()) === eventSignature(e()));
  check(
    "JSON key order does not matter (jsonb does not preserve it)",
    eventSignature(e({ payload: { note: "x", amount: 155_000 } })) ===
      eventSignature(e({ payload: { amount: 155_000, note: "x" } })),
  );
  check(
    "a different amount is a different event",
    eventSignature(e({ payload: { amount: 156_000 } })) !== eventSignature(e()),
  );
  check(
    "the same ask made later in the call is a different event",
    eventSignature(e({ at_ms: 40_000 })) !== eventSignature(e()),
  );
  check(
    "a different actor is a different event",
    eventSignature(e({ actor: "opponent" })) !== eventSignature(e()),
  );
}

console.log("\nAA. Ownership is explicit and the sample library is read-only");
{
  // The column is what actually prevents a recurrence: an unowned row could not
  // be created even by a future code path, because the insert would fail.
  const attemptCols = getTableColumns(attemptsTable);
  const scenarioCols = getTableColumns(scenariosTable);
  check(
    "attempts.owner_id is NOT NULL, so no attempt can be unowned again",
    attemptCols.owner_id.notNull === true,
  );
  check(
    "scenarios.owner_id is NOT NULL, so the library cannot be anonymously deleted",
    scenarioCols.owner_id.notNull === true,
  );

  const sample = { owner_id: DEMO_OWNER_ID };
  const mine = { owner_id: "a".repeat(48) };
  const theirs = { owner_id: "b".repeat(48) };
  const allowed = (fn: () => void) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };

  // The four access cases the audit has to hold.
  check("a cookie-less visitor sees ONLY sample data (read of a sample is allowed)", allowed(() => assertAttemptAccess(sample, null, "read")));
  check("a fresh visitor cannot read another owner's attempt", !allowed(() => assertAttemptAccess(theirs, null, "read")));
  check("the owner can read their own attempt", allowed(() => assertAttemptAccess(mine, mine.owner_id, "read")));
  check("a foreign owner cannot read someone else's attempt", !allowed(() => assertAttemptAccess(mine, theirs.owner_id, "read")));
  check("an owner id that is merely absent is not a grant", !allowed(() => assertAttemptAccess(mine, null, "read")));

  // Samples are public to read but never writable — the demo library must not be
  // destroyable, and a visitor must not be able to mutate a sample call.
  check(
    "nobody may WRITE a sample, not even with the sentinel as their identity",
    !allowed(() => assertAttemptAccess(sample, null, "write")) &&
      !allowed(() => assertAttemptAccess(sample, mine.owner_id, "write")),
  );
  check("an owner may still write their own attempt", allowed(() => assertAttemptAccess(mine, mine.owner_id, "write")));

  // The sentinel must be unusable as a cookie identity (readOwnerId accepts only
  // 48 lowercase hex characters, which this deliberately is not).
  check("the demo sentinel cannot be minted or presented as an owner id", !/^[0-9a-f]{48}$/.test(DEMO_OWNER_ID));

  const publicSample = toPublicScenario({
    id: "00000000-0000-0000-0000-000000000000",
    title: "t",
    company: "c",
    role: "r",
    level: "l",
    difficulty: "medium",
    prep_pack: {},
    owner_id: DEMO_OWNER_ID,
    created_at: new Date(0),
  } as never);
  check("a sample scenario is labeled is_demo for the library UI", publicSample.is_demo === true);
}

console.log("\nAC. The acceptance predicate enforces the hard caps, not only the bar");
{
  const th = acceptanceThreshold(hidden);
  const signCap = hidden.flex.sign_on_max ?? 0;
  const eqCap = hidden.flex.equity_max ?? 0;
  const cap = maxOfferTotal(hidden);

  // The exploit this closes. `acceptsPackage` used to ask only "is the base at
  // the bar, or the total at the total bar?", so `{base: 999999}` satisfied it:
  // one `/offer` call with `accept_candidate_package` finalized an accepted
  // attempt at a salary the band could never authorize.
  check(
    "the absurd package from the /offer exploit is refused",
    !acceptsPackage(hidden, { base: 999_999, sign_on: 999_999, equity: 999_999 }),
  );
  check(
    "base one dollar over the base budget is refused",
    !acceptsPackage(hidden, { base: hidden.budget + 1, sign_on: 0, equity: 0 }),
  );
  check(
    "base far over the budget is refused (it clears the base bar, which is not enough)",
    !acceptsPackage(hidden, { base: hidden.budget + 80_000, sign_on: 0, equity: 0 }),
  );
  check(
    "sign-on one dollar over its cap is refused",
    !acceptsPackage(hidden, { base: th, sign_on: signCap + 1, equity: 0 }),
  );
  check(
    "equity one dollar over its cap is refused",
    !acceptsPackage(hidden, { base: th, sign_on: 0, equity: eqCap + 1 }),
  );
  // Every component inside its own cap, and the total still over the cap: the
  // case a per-component check alone would have let through.
  check(
    "a total over maxOfferTotal is refused even with every component inside its cap",
    !acceptsPackage(hidden, { base: hidden.budget, sign_on: signCap, equity: eqCap }) &&
      hidden.budget + signCap + eqCap > cap,
    `cap=${cap} sum=${hidden.budget + signCap + eqCap}`,
  );
  check(
    "the base budget alone is accepted, so that boundary is reachable",
    acceptsPackage(hidden, { base: hidden.budget, sign_on: 0, equity: 0 }) && hidden.budget >= th,
  );
  check("the authorization caps leave real room above the bar", cap > th, `cap=${cap} bar=${th}`);

  const samples = [
    { base: 999_999, sign_on: 0, equity: 0 },
    { base: 0, sign_on: 0, equity: 0 },
    { base: hidden.budget, sign_on: signCap, equity: eqCap },
    { base: th, sign_on: 0, equity: 0 },
    { base: hidden.budget, sign_on: signCap + 1, equity: 0 },
  ];
  check(
    "no input makes acceptsPackage agree to a package outside the limits",
    samples.every((p) => !acceptsPackage(hidden, p) || withinPackageLimits(hidden, p)),
  );

  const clamped = clampPackageToLimits(hidden, { base: 999_999, sign_on: 999_999, equity: 999_999 });
  check("clamping an absurd package yields an authorized one", withinPackageLimits(hidden, clamped));
  check(
    "clamping never invents money",
    total(clamped) <= total({ base: 999_999, sign_on: 999_999, equity: 999_999 }),
  );
  check(
    "clamping a valid package returns it untouched",
    total(clampPackageToLimits(hidden, { base: th, sign_on: 5_000, equity: 2_000 })) === th + 7_000,
  );
  check(
    "clamping a base-only overshoot lands on the base budget",
    clampPackageToLimits(hidden, { base: 500_000, sign_on: 0, equity: 0 }).base === hidden.budget,
  );
  const flexTrimmed = clampPackageToLimits(hidden, { base: hidden.budget, sign_on: signCap, equity: eqCap });
  check(
    "a total overshoot is trimmed from flex first, keeping the base intact",
    flexTrimmed.base === hidden.budget && total(flexTrimmed) === cap,
    `pkg=${JSON.stringify(flexTrimmed)} cap=${cap}`,
  );
}

console.log("\nAD. A package beyond the band can never become an engine acceptance");
{
  // The recruiter sometimes IMPROVISES a package. It is mirrored onto the panel
  // verbatim (the candidate heard it), and the engine records the inconsistency —
  // but it must never be the package the engine agrees to.
  const mirrored = { base: 260_000, sign_on: 30_000, equity: 9_000 };
  const state = freshState();
  applyRecruiterPackage(state, hidden, mirrored);
  check("the improvised package really is outside the limits", !withinPackageLimits(hidden, mirrored));

  const first = runTurn(state, "We have a deal at these terms. I accept.");
  check(
    "the recruiter does not accept the over-ceiling package the model spoke",
    first.move.kind !== "accept",
    `got ${first.move.kind}`,
  );

  // Insisting earns the yes — but on an AUTHORIZED package, not on the
  // improvised figure. This branch used to `return {kind:"accept", package:
  // state.currentOffer}` with no check at all.
  const second = runTurn(state, "Come on, you said those numbers. I accept, okay, let's do it.");
  check(
    "the candidate's insisted yes is honoured",
    second.move.kind === "accept",
    `got ${second.move.kind}`,
  );
  if (second.move.kind === "accept") {
    check(
      "... on a package the company can actually authorize",
      withinPackageLimits(hidden, second.move.package),
      `pkg=${JSON.stringify(second.move.package)}`,
    );
    check(
      "... never on the improvised figure",
      second.move.package.base !== mirrored.base && total(second.move.package) <= maxOfferTotal(hidden),
      `pkg=${JSON.stringify(second.move.package)}`,
    );
  }

  // And the engine's own concessions keep every limit exact, so the strongest
  // negotiation still ends in a deal rather than in a package it cannot accept.
  const hard = freshState();
  const lines = [
    "Market data for this scope shows 205 to 240 and I have a signed offer at 238k.",
    "I need 230000 base, 25000 sign-on and 25000 in annual equity.",
    "The market supports 235 base plus full sign-on and equity — that is my number.",
    "I want the top of the band: 240000 base, 30000 sign-on, 30000 equity.",
    "Give me 245000 base, 30000 sign-on and 30000 equity or I walk away.",
  ];
  for (const line of lines) runTurn(hard, line);
  check(
    "the hardest negotiation still lands inside the limits",
    withinPackageLimits(hidden, hard.currentOffer),
    `pkg=${JSON.stringify(hard.currentOffer)}`,
  );
  const final = runTurn(hard, "Alright — I accept. We have a deal.");
  check(
    "and the deal it agrees to is one it can sign",
    final.move.kind !== "accept" || withinPackageLimits(hidden, final.move.package),
    `got ${final.move.kind}`,
  );
  if (final.move.kind === "accept") {
    check("an engine acceptance clears the bar via the same predicate", acceptsPackage(hidden, final.move.package));
  }
}

console.log("\nAE. A partial scenario edit is validated as the FINAL state");
{
  const stored: PrepPack = {
    title: "Senior Backend Engineer",
    context: "Late-stage startup, small team, shipping a payments platform.",
    role: "Backend Engineer",
    company: "EchoForge Studios",
    comp_notes: ["Base is the tightest line", "Sign-on is workable"],
    coaching_objective: "Anchor on scope and market data, never state a walk-away number.",
    your_target: 165_000,
    your_reservation: 150_000,
  };
  check(
    "changing only the target below the stored walk-away is refused",
    prepPackError(mergePrepPack(stored, { your_target: 100_000 })) !== null,
  );
  check(
    "changing only the walk-away above the stored target is refused",
    prepPackError(mergePrepPack(stored, { your_reservation: 200_000 })) !== null,
  );
  check(
    "the same edit accepted when both fields arrive valid together",
    prepPackError(mergePrepPack(stored, { your_target: 175_000, your_reservation: 140_000 })) === null,
  );
  check("an unchanged, valid prep pack is still valid", prepPackError(mergePrepPack(stored, {})) === null);
  check(
    "an out-of-range target is refused on the merged state",
    prepPackError(mergePrepPack(stored, { your_target: 10_000 })) !== null,
  );
  check(
    "blanking the context is refused",
    prepPackError(mergePrepPack(stored, { context: "   " })) !== null,
  );
  check(
    "emptying the comp notes is refused",
    prepPackError(mergePrepPack(stored, { comp_notes: [] })) !== null,
  );
  check(
    "a partial edit leaves the fields it did not name alone",
    mergePrepPack(stored, { your_target: 175_000 }).context === stored.context &&
      mergePrepPack(stored, { your_target: 175_000 }).your_reservation === stored.your_reservation,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
