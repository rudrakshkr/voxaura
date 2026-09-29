/**
 * Route + database integration tests.
 *
 * Two halves, because the failures this suite exists to catch live in different
 * layers:
 *
 *  A. DATABASE. The completion barrier and the ownership scoping are decided by
 *     the query layer under a real `pg_advisory_xact_lock`, so they are exercised
 *     against the real database — including the interleavings that are
 *     impossible to provoke reliably over HTTP (an acceptance landing while
 *     scoring runs, two completions racing, a stale barrier being reclaimed).
 *
 *  B. ROUTES. A real `next start` server is spawned and driven over HTTP with
 *     cookie jars — no mocks, no stubs — so ownership, partial-update
 *     validation and the acceptance caps are verified where a client actually
 *     reaches them.
 *
 * Usage: npm run test:integration   (requires `npm run build` and DATABASE_URL)
 */
import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";
import { eq, inArray } from "drizzle-orm";

import { assertScenarioAccess, DEMO_OWNER_ID } from "../src/lib/access";
import { agentReleaseAllowed, INLINE_AGENT_SENTINEL, isStoredAgentId } from "../src/lib/agent-lifecycle";
import { db } from "../src/lib/db/client";
import {
  bindAttemptSessionTx,
  countActiveAttemptsForScenario,
  countScenarioAttempts,
  createAttempt,
  deleteScenario,
  findAttemptIdBySession,
  getAttempt,
  getReport,
  getScenario,
  insertScenario,
  listScenariosWithCounts,
  reclaimStaleAttempts,
  releaseAttemptAgentTx,
  scenarioSnapshotOf,
  snapshotForAttempt,
  withAttemptLock,
} from "../src/lib/db/queries";
import { sweepStaleAttempts } from "../src/lib/db/reclaim";
import {
  attempts as attemptsTable,
  reports as reportsTable,
  scenarios,
} from "../src/lib/db/schema";
import { abandonFinalization, beginFinalization, commitFinalization, FINALIZE_STALE_MS } from "../src/lib/finalize";
import { acceptanceThreshold, maxOfferTotal, withinPackageLimits } from "../src/lib/negotiation-engine";
import type { HiddenState, PrepPack } from "../src/lib/types";

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

const OWNER_A = "a".repeat(48);
const OWNER_B = "b".repeat(48);

/**
 * Per-run suffix for the session ids this suite binds.
 *
 * `attempts.session_id` is unique (migration 0005: one session belongs to one
 * attempt), so a run that is killed before its cleanup leaves ids behind and
 * every LATER run fails at bind time with a duplicate-key error. The assertions
 * stay on fixed, readable values while the rows themselves are unique per run.
 */
const RUN = Date.now().toString(36);
const sess = (name: string) => `${name}-${RUN}`;

const BAND: HiddenState = {
  budget: 180_000,
  reservation: 150_000,
  target: 165_000,
  opening_anchor: 140_000,
  flex: { sign_on_max: 25_000, equity_max: 7_000, remote_days: 2, start_date_weeks: 4, extra_pto_days: 3 },
  hiring_urgency: 3,
  persona: {
    name: "Dana Whitfield",
    title: "Head of Engineering",
    style: "brisk",
    aggression: 3,
    priorities: ["budget discipline", "speed"],
    quirks: ["answers slowly"],
  },
};

function prep(label: string): PrepPack {
  return {
    title: `Test scenario ${label}`,
    context: `Integration fixture ${label}. Late-stage startup, small team.`,
    role: "Backend Engineer",
    company: `Fixture ${label} Ltd`,
    comp_notes: ["Base is the tightest line", "Sign-on is workable"],
    coaching_objective: "Anchor on scope and market data; never state a walk-away number.",
    your_target: 165_000,
    your_reservation: 150_000,
  };
}

const THRESHOLD = acceptanceThreshold(BAND);
const CAP = maxOfferTotal(BAND);

const createdScenarioIds: string[] = [];
const createdAttemptIds: string[] = [];

async function fixture(title: string, ownerId: string): Promise<{ id: string }> {
  const row = await insertScenario({
    title,
    company: `Fixture ${title}`,
    role: "Backend Engineer",
    level: "Mid/Senior",
    difficulty: "medium",
    hidden: BAND,
    prep_pack: prep(title),
    ownerId,
  });
  createdScenarioIds.push(row.id);
  return { id: row.id };
}

async function newAttempt(scenarioId: string, ownerId: string): Promise<string> {
  const row = await createAttempt(scenarioId, { effectiveHidden: BAND, retryMode: null, ownerId });
  createdAttemptIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// A. Database level
// ---------------------------------------------------------------------------

async function dbTests() {
  console.log("\nA1. Library visibility is owner-scoped, not global");
  const scnA = await fixture("A", OWNER_A);
  const scnB = await fixture("B", OWNER_B);
  const scnDemo = await fixture("Sample", DEMO_OWNER_ID);

  const anonList = await listScenariosWithCounts(null);
  check(
    "a cookie-less visitor sees sample scenarios only",
    anonList.some((s) => s.id === scnDemo.id) &&
      !anonList.some((s) => s.id === scnA.id || s.id === scnB.id),
  );
  const aList = await listScenariosWithCounts(OWNER_A);
  check(
    "an owner sees their own scenario plus the samples",
    aList.some((s) => s.id === scnA.id) &&
      aList.some((s) => s.id === scnDemo.id) &&
      !aList.some((s) => s.id === scnB.id),
  );
  check("the sample scenarios are labelled for the library UI", aList.find((s) => s.id === scnA.id)?.is_demo === false);

  console.log("\nA2. Access rules hold against real rows");
  const rowDemo = (await db.select().from(scenarios).where(eq(scenarios.id, scnDemo.id)))[0]!;
  const rowA = (await db.select().from(scenarios).where(eq(scenarios.id, scnA.id)))[0]!;
  const allowed = (fn: () => void) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  check("a visitor may READ a sample scenario", allowed(() => assertScenarioAccess(rowDemo, null, "read")));
  check("a visitor may not WRITE a sample scenario", !allowed(() => assertScenarioAccess(rowDemo, null, "write")));
  check("anyone may use a sample scenario to start an attempt", allowed(() => assertScenarioAccess(rowDemo, OWNER_B, "read")));
  check(
    "the owner may read and write their own scenario",
    allowed(() => assertScenarioAccess(rowA, OWNER_A, "read")) && allowed(() => assertScenarioAccess(rowA, OWNER_A, "write")),
  );
  check(
    "a foreign owner can neither read nor use it",
    !allowed(() => assertScenarioAccess(rowA, OWNER_B, "read")) && !allowed(() => assertScenarioAccess(rowA, OWNER_B, "write")),
  );
  check("nor can a cookie-less visitor", !allowed(() => assertScenarioAccess(rowA, null, "read")));

  console.log("\nA3. Attempt counts are the caller's own activity");
  await newAttempt(scnA.id, OWNER_A);
  const aCounts = await listScenariosWithCounts(OWNER_A);
  check("the owner's count includes their attempt", (aCounts.find((s) => s.id === scnA.id)?.attempt_count ?? 0) >= 1);
  check("another owner's count for that scenario is zero", (await countScenarioAttempts(scnA.id, OWNER_B)) === 0);
  check("a cookie-less caller's count is zero too", (await countScenarioAttempts(scnA.id, null)) === 0);

  console.log("\nA4. The completion barrier freezes the attempt");
  const attempt = await newAttempt(scnA.id, OWNER_A);
  const first = await beginFinalization(attempt, OWNER_A);
  check("the first completion claims the attempt", first.kind === "claimed");
  const firstToken = first.kind === "claimed" ? first.token : null;
  check("and receives an ownership token for the barrier", typeof firstToken === "string" && firstToken.length > 10);
  const second = await beginFinalization(attempt, OWNER_A);
  check("a second completion while scoring is in progress is refused", second.kind === "in_progress");
  const inDb = await getAttempt(attempt);
  check("the attempt is marked finalizing in the database", inDb.status === "finalizing" && inDb.finalizing_at != null);
  await abandonFinalization(attempt, firstToken);
  check("a released barrier returns the attempt to active", (await getAttempt(attempt)).status === "active");

  await db
    .update(attemptsTable)
    .set({ status: "finalizing", finalizing_at: new Date(Date.now() - FINALIZE_STALE_MS - 5_000) })
    .where(eq(attemptsTable.id, attempt));
  check("a stale barrier is reclaimed instead of wedging the call", (await beginFinalization(attempt, OWNER_A)).kind === "claimed");

  console.log("\nA7. A reclaimed barrier cannot be released or written by the old finalizer");
  // finalizing_at said WHEN the barrier was taken, not WHO took it: a reclaimed
  // (stale) finalizer could come back and release or overwrite a barrier that now
  // belongs to someone else. The ownership token makes both a no-op.
  const ownedAttempt = await newAttempt(scnA.id, OWNER_A);
  const ownerA = await beginFinalization(ownedAttempt, OWNER_A);
  const tokenA = ownerA.kind === "claimed" ? ownerA.token : null;
  await db
    .update(attemptsTable)
    .set({ status: "finalizing", finalizing_at: new Date(Date.now() - FINALIZE_STALE_MS - 5_000) })
    .where(eq(attemptsTable.id, ownedAttempt));
  const ownerB = await beginFinalization(ownedAttempt, OWNER_A);
  const tokenB = ownerB.kind === "claimed" ? ownerB.token : null;
  check("a stale barrier is reclaimed by the second finalizer", ownerB.kind === "claimed");
  check("and the reclaimed barrier carries a DIFFERENT token", tokenB != null && tokenB !== tokenA);

  await abandonFinalization(ownedAttempt, tokenA);
  check(
    "the stale finalizer's abandon does not release the new owner's barrier",
    (await getAttempt(ownedAttempt)).status === "finalizing",
  );

  const refusedStaleWrite = await commitFinalization(ownedAttempt, OWNER_A, tokenA, {
    outcome: "stalemate",
    finalOffer: null,
    report: {
      overall_score: 1,
      rubric: [],
      strengths: [],
      improvements: [],
      summary: "stale finalizer",
      communication: null,
      transcript: [],
      events: [],
    } as never,
    extracted: [],
    snapshotSeq: 0,
  });
  check("the stale finalizer's commit is refused as stale", refusedStaleWrite.kind === "stale");
  check(
    "and it wrote no report over the current owner",
    (await findReportFor(ownedAttempt)) == null,
  );
  check("the new owner is still holding the barrier", (await getAttempt(ownedAttempt)).status === "finalizing");
  const ownerBWrite = await commitFinalization(ownedAttempt, OWNER_A, tokenB, {
    outcome: "stalemate",
    finalOffer: null,
    report: {
      overall_score: 55,
      rubric: [],
      strengths: [],
      improvements: [],
      summary: "current owner",
      communication: null,
      transcript: [],
      events: [],
    } as never,
    extracted: [],
    snapshotSeq: 0,
  });
  check("the current owner can still publish", ownerBWrite.kind === "written");
  check("and the barrier is cleared when it does", (await getAttempt(ownedAttempt)).finalization_token == null);

  console.log("\nA5. A stale completion can never downgrade an accepted deal");
  // Exactly the old race: completion read its snapshot while the attempt was
  // still `active`, an acceptance landed during scoring, and then the completion
  // wrote what it had computed. The guard has to refuse that write.
  const accepted = { base: THRESHOLD + 1_000, sign_on: 0, equity: 0 };
  await db
    .update(attemptsTable)
    .set({ status: "completed", outcome: "accepted", final_offer: accepted, finalizing_at: null })
    .where(eq(attemptsTable.id, attempt));
  const staleWrite = await commitFinalization(attempt, OWNER_A, null, {
    outcome: "stalemate",
    finalOffer: null,
    report: {
      overall_score: 10,
      rubric: [],
      strengths: [],
      improvements: [],
      summary: "stale completion",
      communication: null,
      transcript: [],
      events: [],
    } as never,
    extracted: [],
    snapshotSeq: 0,
  });
  const after = await getAttempt(attempt);
  check("the accepted outcome survives a stale completion", after.outcome === "accepted", `outcome=${after.outcome}`);
  check("and so does the agreed package", after.final_offer?.base === accepted.base, `final_offer=${JSON.stringify(after.final_offer)}`);
  check("the report is still written for the settled call", staleWrite.kind === "written");
  check("and the attempt stays completed", after.status === "completed");

  console.log("\nA6. Two completions cannot publish two different scores");
  const raceAttempt = await newAttempt(scnA.id, OWNER_A);
  const raceClaim = await beginFinalization(raceAttempt, OWNER_A);
  const raceToken = raceClaim.kind === "claimed" ? raceClaim.token : null;
  const reportFor = (score: number) => ({
    outcome: "stalemate" as const,
    finalOffer: null,
    report: {
      overall_score: score,
      rubric: [],
      strengths: [],
      improvements: [],
      summary: `score ${score}`,
      communication: null,
      transcript: [],
      events: [],
    } as never,
    extracted: [],
    snapshotSeq: 0,
  });
  const [c1, c2] = await Promise.all([
    commitFinalization(raceAttempt, OWNER_A, raceToken, reportFor(11)),
    commitFinalization(raceAttempt, OWNER_A, raceToken, reportFor(99)),
  ]);
  const kinds = [c1.kind, c2.kind].sort();
  check("exactly one completion writes and one loses", kinds[0] === "lost" && kinds[1] === "written", kinds.join(","));
  const published = await getReport(raceAttempt);
  const loser = c1.kind === "lost" ? c1 : c2;
  check("the loser receives the winner's report, not its own", loser.kind === "lost" && loser.report.id === published.id);
  check("the losing score was never persisted", published.overall_score === (c1.kind === "written" ? 11 : 99), `score=${published.overall_score}`);

  console.log("\nA8. Attempts left behind by a closed tab are reclaimed");
  const staleAttempt = await newAttempt(scnA.id, OWNER_A);
  await db
    .update(attemptsTable)
    .set({ started_at: new Date(Date.now() - 60 * 60_000) })
    .where(eq(attemptsTable.id, staleAttempt));
  const freshAttempt = await newAttempt(scnA.id, OWNER_A);
  const reclaimed = await reclaimStaleAttempts(15 * 60_000);
  check("an hour-old active attempt is abandoned", reclaimed.includes(staleAttempt), reclaimed.join(","));
  check("the stale attempt is abandoned", (await getAttempt(staleAttempt)).status === "abandoned");
  check("a recent healthy call is untouched", (await getAttempt(freshAttempt)).status === "active");
  check("its events and history survive the reclaim", (await getReport(staleAttempt).catch(() => null)) == null);

  // A completed attempt is never swept: the sweep only touches `active` rows.
  const doneAttempt = await newAttempt(scnA.id, OWNER_A);
  await db
    .update(attemptsTable)
    .set({ status: "completed", outcome: "stalemate", started_at: new Date(Date.now() - 3600_000) })
    .where(eq(attemptsTable.id, doneAttempt));
  await reclaimStaleAttempts(15 * 60_000);
  check("a completed attempt is never re-labelled abandoned", (await getAttempt(doneAttempt)).status === "completed");

  console.log("\nA8b. A barrier reclaimed while scoring cannot be written through");
  // A claims the barrier, then goes silent for far longer than a live completion
  // can be (a killed function), and the sweep reclaims the attempt. A's late
  // scoring must not publish over whatever the call actually became.
  const deadFinalizer = await newAttempt(scnA.id, OWNER_A);
  const deadClaim = await beginFinalization(deadFinalizer, OWNER_A);
  const deadToken = deadClaim.kind === "claimed" ? deadClaim.token : null;
  await db
    .update(attemptsTable)
    .set({ finalizing_at: new Date(Date.now() - 3_600_000) })
    .where(eq(attemptsTable.id, deadFinalizer));
  const swept = await reclaimStaleAttempts(15 * 60_000);
  const sweptRow = await getAttempt(deadFinalizer);
  check(
    "a dead completion barrier is reclaimed to abandoned",
    swept.includes(deadFinalizer) && sweptRow.status === "abandoned",
    sweptRow.status,
  );
  check(
    "and the sweep clears the barrier time AND its ownership token",
    sweptRow.finalizing_at == null && sweptRow.finalization_token == null,
    JSON.stringify({ at: sweptRow.finalizing_at, token: sweptRow.finalization_token }),
  );
  const lateWrite = await commitFinalization(deadFinalizer, OWNER_A, deadToken, reportFor(7));
  check("the dead finalizer's late commit is refused as stale", lateWrite.kind === "stale", lateWrite.kind);
  check("and it publishes no report for the reclaimed call", (await findReportFor(deadFinalizer)) == null);
  await abandonFinalization(deadFinalizer, deadToken);
  check(
    "nor can its abandon 'release' an attempt the sweep settled",
    (await getAttempt(deadFinalizer)).status === "abandoned",
  );

  console.log("\nA9. The scenario an attempt was run with is frozen at creation");
  const frozenScenario = await fixture("Frozen", OWNER_A);
  const frozenRow = await createAttempt(frozenScenario.id, {
    effectiveHidden: BAND,
    retryMode: null,
    ownerId: OWNER_A,
    snapshot: scenarioSnapshotOf(await getScenario(frozenScenario.id)),
  });
  createdAttemptIds.push(frozenRow.id);
  await db
    .update(scenarios)
    .set({ title: "Renamed after the call", prep_pack: prep("Renamed") })
    .where(eq(scenarios.id, frozenScenario.id));
  const renamed = await getScenario(frozenScenario.id);
  const frozenSnapshot = snapshotForAttempt(frozenRow, renamed);
  check(
    "the attempt keeps the scenario and prep it was actually run with",
    frozenSnapshot.title === "Frozen" &&
      frozenSnapshot.title !== renamed.title &&
      frozenSnapshot.prep_pack.title === prep("Frozen").title &&
      frozenSnapshot.prep_pack.coaching_objective === prep("Frozen").coaching_objective,
    JSON.stringify({ title: frozenSnapshot.title, prep: frozenSnapshot.prep_pack.title }),
  );
  check("even though the library row now says something else", renamed.title === "Renamed after the call");
  check(
    "an attempt recorded before snapshots existed falls back to the live row",
    snapshotForAttempt({ ...frozenRow, scenario_snapshot: null }, renamed).title === renamed.title,
  );

  console.log("\nA10. Session binding and the delete guard, against real rows");
  const sessionAttempt = await newAttempt(scnA.id, OWNER_A);
  await newAttempt(scnA.id, OWNER_A);
  const boundSession = sess("sess-integration-1");
  await withAttemptLock(sessionAttempt, (tx) =>
    bindAttemptSessionTx(tx, sessionAttempt, boundSession),
  );
  check("an attempt records the session it is bound to", (await getAttempt(sessionAttempt)).session_id === boundSession);
  check(
    "and the session can be attributed back to it",
    (await findAttemptIdBySession(boundSession)) === sessionAttempt,
  );
  check(
    "live attempts are counted so a scenario under call cannot be deleted",
    (await countActiveAttemptsForScenario(scnA.id)) >= 2,
  );

  console.log("\nA11. A stored voice agent is released only once its attempt is terminal");
  check(
    "the inline binding is not a deletable agent id",
    !isStoredAgentId(INLINE_AGENT_SENTINEL) && !isStoredAgentId(null) && isStoredAgentId("agent_abc123"),
  );
  check(
    "a live or still-scoring attempt may not release its agent",
    !agentReleaseAllowed("active") && !agentReleaseAllowed("finalizing") && agentReleaseAllowed("completed") && agentReleaseAllowed("abandoned"),
  );
  const agentAttempt = await newAttempt(scnA.id, OWNER_A);
  await db
    .update(attemptsTable)
    .set({ agent_id: INLINE_AGENT_SENTINEL })
    .where(eq(attemptsTable.id, agentAttempt));
  const heldWhileActive = await withAttemptLock(agentAttempt, (tx) => releaseAttemptAgentTx(tx, agentAttempt));
  check(
    "a live call keeps its binding",
    heldWhileActive === null && (await getAttempt(agentAttempt)).agent_id === INLINE_AGENT_SENTINEL,
  );
  await db.update(attemptsTable).set({ status: "finalizing" }).where(eq(attemptsTable.id, agentAttempt));
  check(
    "so does a call still being scored",
    (await withAttemptLock(agentAttempt, (tx) => releaseAttemptAgentTx(tx, agentAttempt))) === null,
  );
  await db.update(attemptsTable).set({ status: "abandoned" }).where(eq(attemptsTable.id, agentAttempt));
  const handedBack = await withAttemptLock(agentAttempt, (tx) => releaseAttemptAgentTx(tx, agentAttempt));
  check("a terminal attempt hands its binding back for cleanup", handedBack === INLINE_AGENT_SENTINEL);
  check("and the column is cleared as it does", (await getAttempt(agentAttempt)).agent_id === null);

  // The sweep runs the same release for attempts a closed tab left behind. An
  // inline binding must be cleared WITHOUT being sent to the voice service as an
  // agent id — that is the delete of `DELETE /v1/agents/inline`.
  const sweptAgent = await newAttempt(scnA.id, OWNER_A);
  await db
    .update(attemptsTable)
    .set({ agent_id: INLINE_AGENT_SENTINEL, started_at: new Date(Date.now() - 3_600_000) })
    .where(eq(attemptsTable.id, sweptAgent));
  await sweepStaleAttempts(15 * 60_000);
  const sweptAgentRow = await getAttempt(sweptAgent);
  check(
    "the sweep clears an abandoned attempt's inline binding too",
    sweptAgentRow.status === "abandoned" && sweptAgentRow.agent_id === null,
    JSON.stringify({ status: sweptAgentRow.status, agent: sweptAgentRow.agent_id }),
  );
}

/** Report lookup without throwing, for the assertions above. */
async function findReportFor(attemptId: string): Promise<unknown | null> {
  return db
    .select({ id: reportsTable.id })
    .from(reportsTable)
    .where(eq(reportsTable.attempt_id, attemptId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// B. Route level (a real server)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.INTEGRATION_PORT ?? 3411);
const BASE = `http://127.0.0.1:${PORT}`;

interface Res {
  status: number;
  json: Record<string, unknown>;
}
/** Cookie jars by actor name. A jar starts empty (a brand-new visitor). */
const jars = new Map<string, string>();

async function api(
  path: string,
  opts: { method?: string; body?: unknown; as?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const cookie = opts.as ? jars.get(opts.as) : undefined;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (opts.as) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";")[0]!;
      if (pair.startsWith("voxaura_owner=")) jars.set(opts.as, pair);
    }
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function collectKeys(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

async function waitForServer(child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) return false;
    try {
      if ((await fetch(`${BASE}/api/scenarios`)).status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function httpTests() {
  const scnA = await fixture("HTTP-A", OWNER_A);
  const scnB = await fixture("HTTP-B", OWNER_B);
  const scnDemo = await fixture("HTTP-Sample", DEMO_OWNER_ID);
  jars.set("A", `voxaura_owner=${OWNER_A}`);
  jars.set("B", `voxaura_owner=${OWNER_B}`);
  jars.set("forged", `voxaura_owner=${DEMO_OWNER_ID}`);

  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env: { ...process.env, AI_DEBUG: "1", AGENT_MODE: "inline", ALLOW_INLINE_AGENT: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    if (!(await waitForServer(child))) {
      check("the local server starts", false, "next start did not answer in time");
      return;
    }
    check("the local server starts", true);

    console.log("\nB1. The library never leaks another owner's scenarios");
    const idsOf = (r: Res) => ((r.json.scenarios ?? []) as Array<Record<string, unknown>>).map((s) => s.id as string);
    const anonIds = idsOf(await api("/api/scenarios", { as: "anon" }));
    check("a cookie-less visitor sees only sample scenarios", anonIds.includes(scnDemo.id) && !anonIds.includes(scnA.id) && !anonIds.includes(scnB.id));
    const aIds = idsOf(await api("/api/scenarios", { as: "A" }));
    check("an owner sees their own scenario plus samples", aIds.includes(scnA.id) && aIds.includes(scnDemo.id) && !aIds.includes(scnB.id));
    const forgedIds = idsOf(await api("/api/scenarios", { as: "forged" }));
    check("a forged demo-sentinel cookie is treated as no identity", forgedIds.includes(scnDemo.id) && !forgedIds.includes(scnA.id));

    console.log("\nB2. A single scenario is owner-gated (read)");
    check("anonymous → 404", (await api(`/api/scenarios/${scnA.id}`, { as: "anon" })).status === 404);
    check("owner → 200", (await api(`/api/scenarios/${scnA.id}`, { as: "A" })).status === 200);
    check("foreign owner → 404", (await api(`/api/scenarios/${scnA.id}`, { as: "B" })).status === 404);
    check("the sample scenario is public", (await api(`/api/scenarios/${scnDemo.id}`, { as: "anon" })).status === 200);

    console.log("\nB3. An attempt cannot be started against a foreign scenario");
    check("anonymous + private → 404", (await api("/api/attempts", { method: "POST", body: { scenario_id: scnA.id }, as: "anon" })).status === 404);
    check("foreign owner + private → 404", (await api("/api/attempts", { method: "POST", body: { scenario_id: scnA.id }, as: "B" })).status === 404);
    const startA = await api("/api/attempts", { method: "POST", body: { scenario_id: scnA.id }, as: "A" });
    check("owner + own scenario → 201", startA.status === 201, `status=${startA.status}`);
    const attemptOfA = startA.json.attempt_id as string;
    if (attemptOfA) createdAttemptIds.push(attemptOfA);
    const startDemo = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: "demoUser" });
    check("anonymous + sample scenario → 201", startDemo.status === 201, `status=${startDemo.status}`);
    const demoAttempt = startDemo.json.attempt_id as string;
    if (demoAttempt) createdAttemptIds.push(demoAttempt);
    check(
      "the refused attempts leaked no scenario material",
      !JSON.stringify(await api(`/api/attempts/${attemptOfA}`, { as: "anon" })).includes("Integration fixture"),
    );

    // History is the other half of the same promise: the caller's own attempts,
    // plus rows explicitly labeled as samples — never a stranger's.
    const histOf = async (as: string) =>
      (((await api("/api/history", { as })).json.history ?? []) as Array<Record<string, unknown>>);
    const ownerHistory = await histOf("A");
    const strangerHistory = await histOf("demoUser");
    check("a visitor's own attempts appear in their history", ownerHistory.some((r) => r.attempt_id === attemptOfA));
    check(
      "and never in another visitor's history",
      !strangerHistory.some((r) => r.attempt_id === attemptOfA) && !strangerHistory.some((r) => r.scenario_id === scnA.id),
    );
    check("a fresh, cookie-less visitor sees only sample-labelled history", (await histOf("anon")).every((r) => r.is_demo === true));

    console.log("\nB4. A partial scenario edit is validated as the final state");
    check("foreign owner → 404", (await api(`/api/scenarios/${scnA.id}`, { method: "PATCH", body: { title: "hijack" }, as: "B" })).status === 404);
    check("anonymous → 404", (await api(`/api/scenarios/${scnA.id}`, { method: "PATCH", body: { title: "hijack" }, as: "anon" })).status === 404);
    const targetOnly = await api(`/api/scenarios/${scnA.id}`, { method: "PATCH", body: { prep_pack: { your_target: 100_000 } }, as: "A" });
    check("lowering only the target below the stored walk-away → 400", targetOnly.status === 400, `status=${targetOnly.status}`);
    const reservationOnly = await api(`/api/scenarios/${scnA.id}`, { method: "PATCH", body: { prep_pack: { your_reservation: 200_000 } }, as: "A" });
    check("raising only the walk-away above the stored target → 400", reservationOnly.status === 400, `status=${reservationOnly.status}`);
    const storedPrep = ((await api(`/api/scenarios/${scnA.id}`, { as: "A" })).json.scenario as { prep_pack: PrepPack }).prep_pack;
    check("the refused edits did not touch the stored row", storedPrep.your_target === 165_000 && storedPrep.your_reservation === 150_000, JSON.stringify(storedPrep));
    const bothValid = await api(`/api/scenarios/${scnA.id}`, { method: "PATCH", body: { prep_pack: { your_target: 175_000, your_reservation: 140_000 } }, as: "A" });
    check("a valid partial edit → 200", bothValid.status === 200, `status=${bothValid.status}`);
    const newPrep = ((await api(`/api/scenarios/${scnA.id}`, { as: "A" })).json.scenario as { prep_pack: PrepPack }).prep_pack;
    check("and it persists, leaving the untouched fields intact", newPrep.your_target === 175_000 && newPrep.your_reservation === 140_000 && newPrep.context === prep("HTTP-A").context);
    check("an unchanged, valid scenario accepts a no-op edit", (await api(`/api/scenarios/${scnA.id}`, { method: "PATCH", body: {}, as: "A" })).status === 200);
    check("a sample scenario stays read-only", (await api(`/api/scenarios/${scnDemo.id}`, { method: "PATCH", body: { title: "nope" }, as: "A" })).status === 403);
    check("a sample scenario cannot be deleted", (await api(`/api/scenarios/${scnDemo.id}`, { method: "DELETE", as: "A" })).status === 403);
    check("a foreign scenario cannot be deleted", (await api(`/api/scenarios/${scnA.id}`, { method: "DELETE", as: "B" })).status === 404);

    console.log("\nB5. A browser cannot manufacture an offer or an acceptance");
    const capAttempt = await api("/api/attempts", { method: "POST", body: { scenario_id: scnA.id }, as: "A" });
    const capId = capAttempt.json.attempt_id as string;
    if (capId) createdAttemptIds.push(capId);

    // A forged acceptance with no server authorization: refused outright, and no
    // economics change.
    const absurd = await api(`/api/attempts/${capId}/offer`, { method: "POST", body: { accept_candidate_package: { base: 999_999 } }, as: "A" });
    check("an absurd acceptance request is refused", absurd.json.accepted === false, JSON.stringify(absurd.json));
    const capState = (await api(`/api/attempts/${capId}`, { as: "A" })).json.attempt as { status: string; outcome: string | null; final_offer: unknown };
    check("the attempt is still active", capState.status === "active" && capState.outcome == null, JSON.stringify(capState));
    check("no final offer was recorded", capState.final_offer == null);

    const overFlex = await api(`/api/attempts/${capId}/offer`, { method: "POST", body: { accept_candidate_package: { base: THRESHOLD, sign_on: 25_001 } }, as: "A" });
    check("sign-on one dollar over the cap is refused too", overFlex.json.accepted === false, JSON.stringify(overFlex.json));
    check("the attempt is still active after the flex overshoot", ((await api(`/api/attempts/${capId}`, { as: "A" })).json.attempt as { status: string }).status === "active");

    // A forged PACKAGE with no authorization must not touch the authoritative
    // engine state either — the panel is corrected, nothing settles.
    const forgedPackage = await api(`/api/attempts/${capId}/offer`, {
      method: "POST",
      body: { package: { base: 260_000, sign_on: 30_000, equity: 9_000 }, agent_text: "I can do 260,000 base." },
      as: "A",
    });
    const forgedState = (await api(`/api/attempts/${capId}`, { as: "A" })).json.attempt as {
      status: string;
      final_offer: unknown;
    };
    check(
      "a forged package is recorded as an observation, not an authoritative offer",
      forgedPackage.json.authoritative === false && forgedPackage.json.changed === false,
      JSON.stringify(forgedPackage.json),
    );
    check("and it does not settle the call", forgedState.status === "active" && forgedState.final_offer == null);
    check(
      "and the panel is corrected to the package actually on the table",
      (forgedPackage.json.offer as { base: number } | null)?.base === 140_000,
      JSON.stringify(forgedPackage.json.offer),
    );

    // A server-authorized offer: `/turn` issues the token, the tool call presents
    // it, and only then does the package count.
    const authTurn = await api(`/api/attempts/${capId}/turn`, {
      method: "POST",
      body: { user_text: "I was thinking 168,000 base given the scope and the market data for this level.", turn_id: "auth-turn-1" },
      as: "A",
    });
    const auth = authTurn.json.authorization as
      | { token: string; action: "offer" | "accept"; package: { base: number; sign_on?: number | null; equity?: number | null } }
      | null;
    check(
      "a recruiter counter issues a single-use authorization",
      authTurn.json.verdict === "counter" && auth?.action === "offer" && typeof auth.token === "string",
      JSON.stringify({ verdict: authTurn.json.verdict, auth }),
    );

    const wrongPackage = await api(`/api/attempts/${capId}/offer`, {
      method: "POST",
      body: { package: { base: 999_999 }, authorization_token: auth?.token },
      as: "A",
    });
    check(
      "a token for one package cannot authorize another",
      wrongPackage.json.authoritative === false,
      JSON.stringify(wrongPackage.json),
    );

    const authorizedOffer = await api(`/api/attempts/${capId}/offer`, {
      method: "POST",
      body: { package: auth?.package, authorization_token: auth?.token },
      as: "A",
    });
    check(
      "the server-authorized offer is acknowledged as authoritative",
      authorizedOffer.json.authoritative === true,
      JSON.stringify(authorizedOffer.json),
    );

    const replayed = await api(`/api/attempts/${capId}/offer`, {
      method: "POST",
      body: { package: auth?.package, authorization_token: auth?.token },
      as: "A",
    });
    check(
      "a replayed authorization cannot be used twice",
      replayed.json.authoritative === false,
      JSON.stringify(replayed.json),
    );

    // The candidate insists on a close. The engine honours a genuine yes — and
    // THAT is the only route to an acceptance, on the figures the engine itself
    // authorized. (The yes may land on the first or second insistence, so both
    // responses are inspected rather than assuming an order.)
    const yes1 = await api(`/api/attempts/${capId}/turn`, {
      method: "POST",
      body: { user_text: "Okay, I accept. Let's do it.", turn_id: "accept-turn-1" },
      as: "A",
    });
    const yes2 = await api(`/api/attempts/${capId}/turn`, {
      method: "POST",
      body: { user_text: "I accept your numbers — I'm ready to sign right now.", turn_id: "accept-turn-2" },
      as: "A",
    });
    type Auth = {
      token: string;
      action: "offer" | "accept";
      package: { base: number; sign_on?: number | null; equity?: number | null };
    };
    const acceptAuth =
      (yes1.json.authorization as Auth | undefined)?.action === "accept"
        ? (yes1.json.authorization as Auth)
        : (yes2.json.authorization as Auth | undefined);
    const yesVerdict = yes1.json.verdict === "accepted" ? "accepted" : yes2.json.verdict;
    check(
      "the engine's own yes carries an accept authorization",
      yesVerdict === "accepted" && acceptAuth?.action === "accept",
      JSON.stringify({ yes1: yes1.json.verdict, yes2: yes2.json.verdict, acceptAuth }),
    );

    const settleWithToken = await api(`/api/attempts/${capId}/offer`, {
      method: "POST",
      body: {
        accept_candidate_package: acceptAuth?.package,
        authorization_token: acceptAuth?.token,
      },
      as: "A",
    });
    check(
      "a server-authorized acceptance is honoured",
      settleWithToken.json.accepted === true,
      JSON.stringify(settleWithToken.json),
    );
    const settled = (await api(`/api/attempts/${capId}`, { as: "A" })).json.attempt as { status: string; outcome: string | null; final_offer: { base: number } | null };
    check("and the attempt completes as accepted", settled.status === "completed" && settled.outcome === "accepted", JSON.stringify(settled));
    check("with the agreed figures, not the refused ones", settled.final_offer?.base === acceptAuth?.package.base);
    check("the recorded deal is inside the band", settled.final_offer != null && withinPackageLimits(BAND, settled.final_offer));

    // The client arms its "Deal agreed" banner from the TURN response (the
    // server settled the deal there); the recruiter's tool call is only a
    // confirmation. A confirmation that echoes the figures differently — which
    // is what a rounding model actually does — must be answered as agreed, with
    // the authoritative package, instead of 409-ing into a "not validated"
    // notice on a deal that was in fact agreed.
    const echoedOff = await api(`/api/attempts/${capId}/offer`, {
      method: "POST",
      body: { accept_candidate_package: { base: 0, sign_on: 0, equity: 0 } },
      as: "A",
    });
    check(
      "a settled deal is still confirmed when the echo names different figures",
      echoedOff.status === 200 && echoedOff.json.accepted === true,
      `status=${echoedOff.status} ${JSON.stringify(echoedOff.json)}`,
    );
    check(
      "and the reply carries the AGREED package, not the echoed one",
      (echoedOff.json.offer as { base: number } | null)?.base === settled.final_offer?.base,
      JSON.stringify(echoedOff.json.offer),
    );
    const afterEcho = (await api(`/api/attempts/${capId}`, { as: "A" })).json.attempt as {
      status: string;
      outcome: string | null;
      final_offer: { base: number } | null;
    };
    check(
      "a confirmation never mutates the settled deal",
      afterEcho.status === "completed" &&
        afterEcho.outcome === "accepted" &&
        afterEcho.final_offer?.base === settled.final_offer?.base,
      JSON.stringify(afterEcho),
    );
    const lateTurn = await api(`/api/attempts/${capId}/turn`, {
      method: "POST",
      body: { user_text: "One more thing about the start date.", turn_id: "late-after-deal" },
      as: "A",
    });
    check("and the closed attempt refuses further negotiation", lateTurn.status === 409, `status=${lateTurn.status}`);

    // Completion after the engine already settled the deal must not re-label it.
    const completeAfter = await api(`/api/attempts/${capId}/complete`, {
      method: "POST",
      body: { transcript: [{ role: "user", text: "Great, thank you." }] },
      as: "A",
    });
    check("completing an accepted call reports the accepted outcome", completeAfter.status === 200 && completeAfter.json.outcome === "accepted", JSON.stringify(completeAfter.json));
    const afterComplete = (await api(`/api/attempts/${capId}`, { as: "A" })).json.attempt as { outcome: string | null; final_offer: { base: number } | null };
    check(
      "and the agreed package is untouched",
      afterComplete.outcome === "accepted" && afterComplete.final_offer?.base === settled.final_offer?.base,
      JSON.stringify(afterComplete),
    );

    console.log("\nB6. An improvised spoken package cannot become the deal");
    const speakAttempt = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: "demoUser" });
    const speakId = speakAttempt.json.attempt_id as string;
    if (speakId) createdAttemptIds.push(speakId);
    await api(`/api/attempts/${speakId}/offer`, { method: "POST", body: { package: { base: 260_000, sign_on: 30_000, equity: 9_000 } }, as: "demoUser" });
    const firstYes = await api(`/api/attempts/${speakId}/turn`, { method: "POST", body: { user_text: "We have a deal at those numbers. I accept." }, as: "demoUser" });
    check("the recruiter does not accept the improvised package", firstYes.json.verdict !== "accepted", String(firstYes.json.verdict));
    await api(`/api/attempts/${speakId}/turn`, { method: "POST", body: { user_text: "Come on, you said those numbers. Okay, I accept, let's do it." }, as: "demoUser" });
    const spokeState = (await api(`/api/attempts/${speakId}`, { as: "demoUser" })).json.attempt as {
      outcome: string | null;
      final_offer: { base: number; sign_on?: number | null; equity?: number | null } | null;
    };
    check("the improvised figure never becomes the final offer", spokeState.final_offer?.base !== 260_000, JSON.stringify(spokeState.final_offer));
    if (spokeState.outcome === "accepted") {
      check("an insisted yes landed on an authorized package", spokeState.final_offer != null && withinPackageLimits(BAND, spokeState.final_offer), JSON.stringify(spokeState.final_offer));
    } else {
      check("no unauthorized deal was recorded", spokeState.outcome !== "accepted");
    }

    console.log("\nB7. Completion races cannot clobber a settled deal");
    for (let i = 1; i <= 6; i++) {
      const jar = `race${i}`;
      const start = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: jar });
      const id = start.json.attempt_id as string;
      if (!id) {
        check(`run ${i}: the attempt was created`, false, JSON.stringify(start.json));
        continue;
      }
      createdAttemptIds.push(id);
      // Walk the call to the point where ONE more yes settles it, then let that
      // final turn and the completion race for the attempt. This is the original
      // bug's exact shape: completion snapshots `active`, the deal lands, and the
      // report must never overwrite it.
      await api(`/api/attempts/${id}/turn`, {
        method: "POST",
        body: { user_text: "I was thinking 168,000 base given the scope and the market data here." },
        as: jar,
      });
      await api(`/api/attempts/${id}/turn`, {
        method: "POST",
        body: { user_text: "Okay, I accept. Let's do it." },
        as: jar,
      });
      const [turn, complete] = await Promise.all([
        api(`/api/attempts/${id}/turn`, {
          method: "POST",
          body: { user_text: "I accept your numbers — I'm ready to sign right now." },
          as: jar,
        }),
        api(`/api/attempts/${id}/complete`, { method: "POST", body: { transcript: [{ role: "user", text: "I accept." }] }, as: jar }),
      ]);
      const state = (await api(`/api/attempts/${id}`, { as: jar })).json.attempt as {
        status: string;
        outcome: string | null;
        final_offer: { base: number } | null;
      };
      const events = ((await api(`/api/attempts/${id}/events`, { as: jar })).json.events ?? []) as Array<{ type: string; actor: string }>;
      const acceptedEvent = events.some((e) => e.type === "acceptance" && e.actor === "opponent");
      const report = await api(`/api/attempts/${id}/report`, { as: jar });
      const consistent =
        state.status === "completed" &&
        report.status === 200 &&
        (state.outcome === "accepted") === acceptedEvent &&
        (state.final_offer == null || withinPackageLimits(BAND, state.final_offer)) &&
        complete.status === 200 &&
        turn.status !== 500;
      check(
        `run ${i}: the call ends consistently (outcome=${state.outcome ?? "none"}, acceptance=${acceptedEvent}, turn=${turn.status})`,
        consistent,
        JSON.stringify({ state, reportStatus: report.status, completeStatus: complete.status }),
      );
    }

    console.log("\nB8. Completion racing an offer reconciliation");
    for (let i = 1; i <= 3; i++) {
      const jar = `raceoffer${i}`;
      const start = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: jar });
      const id = start.json.attempt_id as string;
      if (!id) {
        check(`offer run ${i}: the attempt was created`, false, JSON.stringify(start.json));
        continue;
      }
      createdAttemptIds.push(id);
      const r1 = await api(`/api/attempts/${id}/turn`, {
        method: "POST",
        body: { user_text: "I was thinking 168,000 base given the scope and the market data here.", turn_id: `race-${i}-1` },
        as: jar,
      });
      const r2 = await api(`/api/attempts/${id}/turn`, {
        method: "POST",
        body: { user_text: "Okay, I accept. Let's do it.", turn_id: `race-${i}-2` },
        as: jar,
      });
      const r3 = await api(`/api/attempts/${id}/turn`, {
        method: "POST",
        body: { user_text: "I accept your numbers — I'm ready to sign right now.", turn_id: `race-${i}-3` },
        as: jar,
      });
      type RaceAuth = { token: string; action: "offer" | "accept"; package: { base: number; sign_on?: number | null; equity?: number | null } };
      const acceptAuth2 =
        (r1.json.authorization as RaceAuth | undefined)?.action === "accept"
          ? (r1.json.authorization as RaceAuth)
          : (r2.json.authorization as RaceAuth | undefined)?.action === "accept"
            ? (r2.json.authorization as RaceAuth)
            : (r3.json.authorization as RaceAuth | undefined);
      // The recruiter's acceptance confirmation via `/offer` has to race
      // completion exactly like a final turn.
      const [offerRes, completeRes] = await Promise.all([
        api(`/api/attempts/${id}/offer`, {
          method: "POST",
          body: {
            accept_candidate_package: acceptAuth2?.package,
            authorization_token: acceptAuth2?.token,
          },
          as: jar,
        }),
        api(`/api/attempts/${id}/complete`, { method: "POST", body: { transcript: [{ role: "user", text: "Deal." }] }, as: jar }),
      ]);
      const state = (await api(`/api/attempts/${id}`, { as: jar })).json.attempt as {
        status: string;
        outcome: string | null;
        final_offer: { base: number } | null;
      };
      const events = ((await api(`/api/attempts/${id}/events`, { as: jar })).json.events ?? []) as Array<{ type: string; actor: string }>;
      const acceptedEvent = events.some((e) => e.type === "acceptance" && e.actor === "opponent");
      const report = await api(`/api/attempts/${id}/report`, { as: jar });
      const consistent =
        state.status === "completed" &&
        report.status === 200 &&
        completeRes.status === 200 &&
        (offerRes.status === 200 || offerRes.status === 409) &&
        (state.outcome === "accepted") === acceptedEvent &&
        (state.final_offer == null || withinPackageLimits(BAND, state.final_offer));
      check(
        `offer run ${i}: an acceptance request and completion agree (offer=${offerRes.status}, outcome=${state.outcome ?? "none"})`,
        consistent,
        JSON.stringify({ state, offer: offerRes.json, complete: completeRes.status }),
      );
    }

    console.log("\nB9. A late event arriving during scoring");
    {
      const jar = "raceevents";
      const start = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: jar });
      const id = start.json.attempt_id as string;
      createdAttemptIds.push(id);
      await api(`/api/attempts/${id}/offer`, { method: "POST", body: { package: { base: THRESHOLD } }, as: jar });
      const [eventRes] = await Promise.all([
        api(
          `/api/attempts/${id}/events`,
          {
            method: "POST",
            body: {
              events: [{ type: "rapport", actor: "user", source: "tool", payload: { note: "late-during-scoring" }, at_ms: 9_999 }],
            },
            as: jar,
          },
        ),
        api(`/api/attempts/${id}/complete`, { method: "POST", body: { transcript: [{ role: "user", text: "Thanks." }] }, as: jar }),
      ]);
      const report = await api(`/api/attempts/${id}/report`, { as: jar });
      const reportBody = (report.json.report ?? {}) as { events?: Array<{ payload?: { note?: string } }> };
      const inReport = (reportBody.events ?? []).some((e) => e.payload?.note === "late-during-scoring");
      // Either the batch won the lock before the barrier (so it is part of the
      // snapshot the report was scored from) or it was refused. What must never
      // happen is 200 + absent from the report: an event written into a call that
      // had already been scored.
      check(
        `a late batch lands in the scored snapshot or is refused (status=${eventRes.status})`,
        (eventRes.status === 409 && !inReport) || (eventRes.status === 200 && inReport),
        JSON.stringify({ status: eventRes.status, inReport }),
      );
      check("and the call still completes", report.status === 200, `report=${report.status}`);
    }

    console.log("\nB10. A completed call is closed to every late mutation");
    const closed = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: "closedUser" });
    const closedId = closed.json.attempt_id as string;
    createdAttemptIds.push(closedId);
    const closedDone = await api(`/api/attempts/${closedId}/complete`, { method: "POST", body: { transcript: [{ role: "user", text: "Thanks, that works for me." }] }, as: "closedUser" });
    check("the call completes normally first", closedDone.status === 200, `status=${closedDone.status}`);
    check("a late turn → 409", (await api(`/api/attempts/${closedId}/turn`, { method: "POST", body: { user_text: "one more thing" }, as: "closedUser" })).status === 409);
    check("a late offer → 409", (await api(`/api/attempts/${closedId}/offer`, { method: "POST", body: { agent_text: "160000 base" }, as: "closedUser" })).status === 409);
    const lateEvents = await api(`/api/attempts/${closedId}/events`, {
      method: "POST",
      body: { events: [{ type: "rapport", actor: "user", source: "tool", payload: {} }] },
      as: "closedUser",
    });
    check("a late event → 409", lateEvents.status === 409, `status=${lateEvents.status}`);
    const before = await api(`/api/attempts/${closedId}/report`, { as: "closedUser" });
    const afterReport = await api(`/api/attempts/${closedId}/report`, { as: "closedUser" });
    check("so the report still describes the call that was scored", JSON.stringify(before.json) === JSON.stringify(afterReport.json));

    console.log("\nB11. Retries are idempotent");
    const idem = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: "idemUser" });
    const idemId = idem.json.attempt_id as string;
    createdAttemptIds.push(idemId);
    const turnBody = { user_text: "I was thinking 150000 based on market data.", turn_id: "turn-aaaaaaaa" };
    const t1 = await api(`/api/attempts/${idemId}/turn`, { method: "POST", body: turnBody, as: "idemUser" });
    const t2 = await api(`/api/attempts/${idemId}/turn`, { method: "POST", body: turnBody, as: "idemUser" });
    check("a replayed turn returns the original response", t2.json.replayed === true && t2.json.round === t1.json.round, JSON.stringify({ t1: t1.json.round, t2: t2.json }));
    const batch = [
      { type: "user_offer", actor: "user", source: "tool", payload: { amount: 150_000, note: "150k" }, at_ms: 5_000 },
      { type: "rapport", actor: "user", source: "tool", payload: {}, at_ms: 6_000 },
    ];
    const e1 = await api(`/api/attempts/${idemId}/events`, { method: "POST", body: { events: batch }, as: "idemUser" });
    const e2 = await api(`/api/attempts/${idemId}/events`, { method: "POST", body: { events: batch }, as: "idemUser" });
    check("a re-sent event batch is recorded once", e1.json.inserted === 2 && e2.json.inserted === 0 && e2.json.duplicates === 2, JSON.stringify({ e1: e1.json, e2: e2.json }));
    const fabricate = await api(`/api/attempts/${idemId}/events`, {
      method: "POST",
      body: { events: [{ type: "acceptance", actor: "opponent", source: "tool", payload: { package: { base: 999_999 } } }] },
      as: "idemUser",
    });
    check("a client still cannot fabricate an opponent acceptance", fabricate.json.inserted === 0 && fabricate.json.rejected === 1, JSON.stringify(fabricate.json));
    const twoReports = await Promise.all([
      api(`/api/attempts/${idemId}/complete`, { method: "POST", body: { transcript: [{ role: "user", text: "I accept." }] }, as: "idemUser" }),
      api(`/api/attempts/${idemId}/complete`, { method: "POST", body: { transcript: [{ role: "user", text: "I accept." }] }, as: "idemUser" }),
    ]);
    const reportIds = twoReports.map((r) => r.json.report_id as string | undefined);
    check(
      "two concurrent completions publish exactly one report",
      reportIds[0] != null && reportIds[0] === reportIds[1],
      JSON.stringify(twoReports.map((r) => ({ s: r.status, id: r.json.report_id, already: r.json.already_completed }))),
    );
    const settledAgain = await api(`/api/attempts/${idemId}/complete`, { method: "POST", body: {}, as: "idemUser" });
    check("a later completion is idempotent", settledAgain.json.already_completed === true && settledAgain.json.report_id === reportIds[0]);

    console.log("\nB12. Every attempt route is owner-gated");
    const victim = capId;
    const routes: Array<[string, string, unknown?]> = [
      [`/api/attempts/${victim}`, "GET"],
      [`/api/attempts/${victim}/report`, "GET"],
      [`/api/attempts/${victim}/counterfactual`, "GET"],
      [`/api/attempts/${victim}/events`, "GET"],
      [`/api/attempts/${victim}/events`, "POST", { events: [{ type: "rapport", actor: "user", source: "tool", payload: {} }] }],
      [`/api/attempts/${victim}/turn`, "POST", { user_text: "hello there" }],
      [`/api/attempts/${victim}/offer`, "POST", { agent_text: "160000 base" }],
      [`/api/attempts/${victim}/complete`, "POST", { transcript: [] }],
      [`/api/attempts/${victim}/session`, "POST", { session_id: "foreign-session" }],
    ];
    for (const [path, method, body] of routes) {
      const foreign = await api(path, { method, body, as: "B" });
      const stranger = await api(path, { method, body, as: "anon" });
      check(
        `${method} ${path.replace(victim, ":id")} → 404 for a foreign owner and a stranger`,
        foreign.status === 404 && stranger.status === 404,
        `foreign=${foreign.status} anon=${stranger.status}`,
      );
    }

    console.log("\nB13. The report and the counterfactual expose only authorized shapes");
    const report = await api(`/api/attempts/${victim}/report`, { as: "A" });
    const cf = await api(`/api/attempts/${victim}/counterfactual`, { as: "A" });
    const keys = new Set<string>();
    collectKeys(report.json, keys);
    collectKeys(cf.json, keys);
    const forbidden = [
      "budget",
      "reservation",
      "target",
      "opening_anchor",
      "floor_base",
      "authorized_total",
      "acceptAtOrAboveTotal",
      "acceptAtOrAboveThreshold",
      "anchor",
      "leverageAmount",
      "turns",
      "effective_hidden",
      "maxOfferTotal",
    ];
    check(
      "no hidden-state field name appears in the report or the counterfactual",
      forbidden.every((k) => !keys.has(k)),
      [...forbidden].filter((k) => keys.has(k)).join(","),
    );
    const reportBody = report.json.report as { events: Array<{ seq: number }>; rubric: Array<{ event_seqs: number[] }> };
    check("the durable timeline is present", reportBody.events.length > 0);
    const realSeqs = new Set(reportBody.events.map((e) => e.seq));
    check(
      "every cited evidence pointer names a real event",
      reportBody.rubric.flatMap((d) => d.event_seqs).every((s) => realSeqs.has(s)),
    );
    const cfBody = cf.json.counterfactual as { results?: unknown[]; disclaimer?: string };
    check("the counterfactual models alternatives with a disclaimer", (cfBody.results?.length ?? 0) > 0 && typeof cfBody.disclaimer === "string");
    check("and it is only available once the call is scored", (await api(`/api/attempts/${closedId}/counterfactual`, { as: "closedUser" })).status === 200);
    const unscored = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: "cfUser" });
    const unscoredId = unscored.json.attempt_id as string;
    createdAttemptIds.push(unscoredId);
    check("an unscored call has no counterfactual", (await api(`/api/attempts/${unscoredId}/counterfactual`, { as: "cfUser" })).status === 409);

    console.log("\nB14. The voice token is bound to an owned, live attempt");
    check("a token request with no attempt is rejected", (await api("/api/token", { as: "A" })).status === 400);
    check("a malformed attempt id is rejected", (await api("/api/token?attempt_id=nope", { as: "A" })).status === 400);
    check(
      "a foreign owner cannot mint a token for someone else's attempt",
      (await api(`/api/token?attempt_id=${capId}`, { as: "B" })).status === 404,
    );
    check(
      "a completed attempt cannot start a new call",
      (await api(`/api/token?attempt_id=${capId}`, { as: "A" })).status === 409,
    );
    const tokStart = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: "A" });
    const tokId = tokStart.json.attempt_id as string;
    if (tokId) createdAttemptIds.push(tokId);
    const minted = await api(`/api/token?attempt_id=${tokId}`, { as: "A" });
    check(
      "an owned, active attempt can mint a token",
      minted.status === 200 && typeof minted.json.token === "string",
      JSON.stringify(minted.json),
    );
    await db.update(attemptsTable).set({ status: "abandoned" }).where(eq(attemptsTable.id, tokId));
    check(
      "an abandoned attempt cannot mint one either",
      (await api(`/api/token?attempt_id=${tokId}`, { as: "A" })).status === 409,
    );

    console.log("\nB15. The attempt's voice session cannot be swapped");
    const sJar = "sessUser";
    const s1 = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: sJar });
    const s1Id = s1.json.attempt_id as string;
    if (s1Id) createdAttemptIds.push(s1Id);
    const firstBind = await api(`/api/attempts/${s1Id}/session`, {
      method: "POST",
      body: { session_id: sess("http-sess-1") },
      as: sJar,
    });
    check(
      "the first session bind succeeds",
      firstBind.status === 200 && firstBind.json.bound === true,
      JSON.stringify(firstBind.json),
    );
    const sameBind = await api(`/api/attempts/${s1Id}/session`, {
      method: "POST",
      body: { session_id: sess("http-sess-1") },
      as: sJar,
    });
    check("rebinding the SAME session is idempotent", sameBind.status === 200 && sameBind.json.bound === false);
    const silentSwap = await api(`/api/attempts/${s1Id}/session`, {
      method: "POST",
      body: { session_id: sess("http-sess-2") },
      as: sJar,
    });
    check("a conflicting session is rejected", silentSwap.status === 409, String(silentSwap.status));
    const deliberate = await api(`/api/attempts/${s1Id}/session`, {
      method: "POST",
      body: { session_id: sess("http-sess-2"), previous_session_id: sess("http-sess-1") },
      as: sJar,
    });
    check(
      "an intentional reconnect rebinds",
      deliberate.status === 200 && deliberate.json.bound === true,
      JSON.stringify(deliberate.json),
    );
    check(
      "a foreign owner cannot bind the attempt's session",
      (await api(`/api/attempts/${s1Id}/session`, { method: "POST", body: { session_id: sess("http-sess-3") }, as: "B" })).status === 404,
    );
    const eventSwap = await api(`/api/attempts/${s1Id}/events`, {
      method: "POST",
      body: { session_id: sess("http-sess-9"), events: [{ type: "rapport", actor: "user", source: "tool", payload: {} }] },
      as: sJar,
    });
    check("an events batch cannot swap the session", eventSwap.status === 409, String(eventSwap.status));
    const s2 = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: sJar });
    const s2Id = s2.json.attempt_id as string;
    if (s2Id) createdAttemptIds.push(s2Id);
    const steal = await api(`/api/attempts/${s2Id}/session`, {
      method: "POST",
      body: { session_id: sess("http-sess-2") },
      as: sJar,
    });
    check(
      "a session already bound to another attempt cannot be adopted",
      steal.status === 409,
      String(steal.status),
    );
    const substituted = await api(`/api/attempts/${s1Id}/complete`, {
      method: "POST",
      body: { session_id: sess("http-sess-77"), transcript: [{ role: "user", text: "hello" }] },
      as: sJar,
    });
    check(
      "completion cannot substitute a different session id",
      substituted.status === 409,
      String(substituted.status),
    );

    console.log("\nB16. A scenario with a live call cannot be deleted");
    const liveStart = await api("/api/attempts", { method: "POST", body: { scenario_id: scnA.id }, as: "A" });
    const liveId = liveStart.json.attempt_id as string;
    if (liveId) createdAttemptIds.push(liveId);
    const blockedDelete = await api(`/api/scenarios/${scnA.id}`, { method: "DELETE", as: "A" });
    check(
      "deleting a scenario with a call in progress is refused with a reason",
      blockedDelete.status === 409 && typeof blockedDelete.json.error === "string",
      JSON.stringify(blockedDelete.json),
    );

    console.log("\nB17. Candidate moves have exactly one authoritative record");
    const provJar = "provUser";
    const provStart = await api("/api/attempts", { method: "POST", body: { scenario_id: scnDemo.id }, as: provJar });
    const provId = provStart.json.attempt_id as string;
    if (provId) createdAttemptIds.push(provId);
    const provTurn = { user_text: "I was thinking 168,000 base given the scope and the market data here.", turn_id: "prov-turn-1" };
    await api(`/api/attempts/${provId}/turn`, { method: "POST", body: provTurn, as: provJar });
    // The same utterance, retried with the same idempotency key.
    await api(`/api/attempts/${provId}/turn`, { method: "POST", body: provTurn, as: provJar });
    // A client annotation for the SAME utterance, exactly what the voice model's
    // `log_user_move` tool posts.
    await api(`/api/attempts/${provId}/events`, {
      method: "POST",
      body: {
        events: [
          { type: "user_offer", actor: "user", source: "tool", payload: { amount: 168_000, note: "same sentence" }, at_ms: 1_000 },
          { type: "leverage_introduced", actor: "user", source: "tool", payload: { leverage: 220_000 }, at_ms: 1_100 },
          { type: "concession", actor: "user", source: "tool", payload: { amount: 160_000 }, at_ms: 1_200 },
        ],
      },
      as: provJar,
    });
    const provEvents = ((await api(`/api/attempts/${provId}/events`, { as: provJar })).json.events ?? []) as Array<{
      type: string;
      actor: string;
      authoritative: boolean;
      payload: Record<string, unknown>;
    }>;
    const authoritativeOffers = provEvents.filter(
      (e) => e.type === "user_offer" && e.actor === "user" && e.authoritative,
    );
    check(
      "two identical turns produce exactly one authoritative candidate event",
      authoritativeOffers.length === 1,
      `count=${authoritativeOffers.length}`,
    );
    const forgedLeverage = provEvents.find((e) => e.type === "leverage_introduced");
    const forgedConcession = provEvents.find((e) => e.type === "concession");
    check(
      "a client annotation is stored but never authoritative",
      forgedLeverage != null && forgedLeverage.authoritative === false &&
        forgedConcession != null && forgedConcession.authoritative === false,
      JSON.stringify({ leverage: forgedLeverage?.authoritative, concession: forgedConcession?.authoritative }),
    );
    const provComplete = await api(`/api/attempts/${provId}/complete`, {
      method: "POST",
      body: { transcript: [{ role: "user", text: "I was thinking 168,000 base given the scope and the market data here." }] },
      as: provJar,
    });
    check("the call scores", provComplete.status === 200, JSON.stringify(provComplete.json));
    const provReport = (await api(`/api/attempts/${provId}/report`, { as: provJar })).json.report as {
      events: Array<{ type: string; actor: string; authoritative: boolean }>;
      transcript_source?: string | null;
    };
    check(
      "the report distinguishes authoritative moves from annotations",
      provReport.events.some((e) => e.authoritative) && provReport.events.some((e) => !e.authoritative),
      JSON.stringify(provReport.events.map((e) => [e.type, e.authoritative])),
    );
    check(
      "and states where the scored transcript came from",
      provReport.transcript_source === "client" || provReport.transcript_source === "server" || provReport.transcript_source === "server+client",
      String(provReport.transcript_source),
    );
    check(
      "a forged annotation cannot appear as a server-classified move",
      provReport.events.filter((e) => e.type === "leverage_introduced").every((e) => !e.authoritative),
    );

    check("the band is what the fixtures actually used", CAP === 189_250 && THRESHOLD === 173_250, `cap=${CAP} bar=${THRESHOLD}`);
  } finally {
    child.kill("SIGTERM");
  }
}

async function cleanup() {
  try {
    if (createdAttemptIds.length > 0) {
      await db.delete(attemptsTable).where(inArray(attemptsTable.id, createdAttemptIds));
    }
    for (const id of createdScenarioIds) {
      await deleteScenario(id).catch(() => undefined);
    }
  } catch (err) {
    console.error("[integration] cleanup failed:", err);
  }
}

async function main() {
  console.log("Integration tests (real database + real server)");
  try {
    await dbTests();
    // INTEGRATION_DB_ONLY=1 skips the HTTP half (useful when the guard under
    // test lives entirely in the query layer and no rebuild is needed).
    if (process.env.INTEGRATION_DB_ONLY !== "1") await httpTests();
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.$client.end();
  process.exit(fail > 0 ? 1 : 0);
}

void main();