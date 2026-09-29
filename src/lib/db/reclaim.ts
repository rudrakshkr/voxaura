import { releaseAttemptAgent } from "../agent-lifecycle";
import { purgeExpiredAuthorizations, reclaimStaleAttempts } from "./queries";

/**
 * How long an attempt may sit `active` with no activity before it is abandoned.
 *
 * The client caps a call at 10 minutes and the voice service's own session TTL is
 * in the same range, so 15 minutes of complete silence (no start advancement, no
 * recorded event, no report) can only mean the browser went away. A call that is
 * genuinely still running keeps writing events, so it is never touched.
 *
 * The same window covers a dead completion barrier: a live one is held for under
 * a minute, so fifteen minutes of it means the function that took it is gone.
 */
export const STALE_ATTEMPT_MS = 15 * 60_000;

/** Minimum interval between sweeps in one server instance. */
const SWEEP_INTERVAL_MS = 60_000;

let lastSweepAt = 0;

/**
 * Abandon stale attempts and release what they were holding.
 *
 * Two resources outlive a closed tab: the attempt row (which would otherwise sit
 * `active` in history forever, keeping its scenario undeletable) and the stored
 * AssemblyAI agent provisioned for it (billable, and unbindable once the call is
 * over). `reclaimStaleAttempts` settles the rows; the release below deletes the
 * agents. Order matters — the release refuses to touch an `active` or
 * `finalizing` attempt, so it can only run once the row is terminal.
 *
 * Exported so the sweep can be driven directly by tests, and so a future
 * scheduler can call it without the throttle.
 */
export async function sweepStaleAttempts(idleMs: number = STALE_ATTEMPT_MS): Promise<string[]> {
  const reclaimed = await reclaimStaleAttempts(idleMs);
  for (const id of reclaimed) {
    await releaseAttemptAgent(id);
  }
  return reclaimed;
}

/**
 * Lazily abandon attempts left behind by a closed tab.
 *
 * `markAbandoned()` existed but had no caller, so an abandoned call stayed
 * `active` forever. Rather than a cron (this deploys to serverless, where there
 * is no scheduler), the sweep rides along on ordinary traffic — attempt creation
 * and history reads — throttled to one run a minute per instance. It is
 * best-effort by design: a failure to sweep must never fail the request, and the
 * next request will try again.
 */
export function scheduleStaleAttemptReclaim(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepStaleAttempts()
    .then((ids) => {
      if (ids.length > 0) {
        console.info(`[reclaim] abandoned ${ids.length} stale active attempt(s)`);
      }
    })
    .catch((err) => console.warn("[reclaim] stale-attempt sweep failed:", err));
  // Expired action tokens are dead weight; the table would otherwise grow with
  // every authorized turn forever.
  void purgeExpiredAuthorizations().catch((err) =>
    console.warn("[reclaim] authorization purge failed:", err),
  );
}
