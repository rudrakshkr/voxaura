/**
 * Best-effort in-process rate limiting.
 *
 * LIMITATION, stated plainly so the next iteration does not mistake this for a
 * guarantee: the counters live in one Node process's memory. A serverless
 * deployment runs several instances (and recycles them), so a client can exceed
 * any of these limits by spreading requests across instances or simply waiting
 * for a cold start. What this DOES do is stop a single scripted client from
 * hammering one instance in a tight loop — a burst of expensive calls (each
 * attempt may create an AssemblyAI agent, each turn may call an LLM, each token
 * is independently billable) — and it costs nothing to operate.
 *
 * Replacing the backend with a shared store (Redis/Upstash, or the platform's own
 * rate limiter) is the intended next step; the call sites below are deliberately
 * kept thin (`take(key, limit)`) so that swap is contained to `take()`.
 *
 * Note also that nothing here is a security control: ownership checks, not rate
 * limits, are what stop one visitor from reaching another's data.
 */
const WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

function take(key: string, limit: number, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // Opportunistic cleanup so the map cannot grow without bound.
  if (hits.size > 5_000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
  return true;
}

/** Attempt creation: a handful of calls per minute per owner. */
export function takeAttemptSlot(ownerId: string): boolean {
  return take(`attempt:${ownerId}`, 12);
}

/** Negotiation turns: generous, but not unbounded against a stuck retry loop. */
export function takeTurnSlot(attemptId: string): boolean {
  return take(`turn:${attemptId}`, 120);
}

/**
 * Temp tokens for the voice socket. Each one is an independently billable
 * credential, so this is deliberately tighter than attempt creation — and keyed
 * on owner AND attempt, so a single attempt cannot be used to churn tokens.
 */
export function takeAttemptTokenSlot(ownerId: string, attemptId: string): boolean {
  return take(`token:${ownerId}:${attemptId}`, 30);
}

/**
 * Scenario creation and mutation. Generation costs an LLM call and deletion is
 * destructive, so both are throttled to keep a scripted client from churning
 * the library. Deliberately a speed bump, not a quota.
 */
export function takeScenarioSlot(ownerId: string): boolean {
  return take(`scenario-create:${ownerId}`, 10);
}

export function takeScenarioMutationSlot(ownerId: string): boolean {
  return take(`scenario-mutate:${ownerId}`, 30);
}
