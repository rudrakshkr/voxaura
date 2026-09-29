/**
 * Pure delivery logic for the voice session.
 *
 * Two things kept failing silently in the client, and neither could be tested
 * while it lived inside a React hook:
 *
 *  1. **Engine directives.** `send()` did nothing when the websocket was not
 *     open, so a successful `/turn` whose directive arrived during a blip was
 *     lost forever — the engine had decided and the recruiter never heard it.
 *  2. **Durable event flushes.** A retry loop with no deadline could keep a
 *     closing call busy, and a permanent refusal could wedge every event queued
 *     behind it.
 *
 * Both are expressed here as plain functions over injected effects, so the rules
 * (deliver once, queue on failure, retry transient failures only within a
 * deadline, never claim a sync that did not happen) are verified directly.
 */

export interface RelayedDirective {
  /** Turn id — the identity that makes delivery exactly-once. */
  key: string;
  content: string;
}

/**
 * Directives awaiting a working socket.
 *
 * A directive is removed only after it has actually been written; a duplicate key
 * replaces rather than appends, so a retried turn cannot make the recruiter say
 * the same thing twice.
 */
export class DirectiveRelay {
  private queue: RelayedDirective[];

  constructor(initial: RelayedDirective[] = []) {
    this.queue = [];
    for (const directive of initial) this.enqueue(directive);
  }

  enqueue(directive: RelayedDirective): void {
    const existing = this.queue.findIndex((d) => d.key === directive.key);
    if (existing >= 0) this.queue[existing] = directive;
    else this.queue.push(directive);
  }

  /** Number of directives still waiting for a socket. */
  get pending(): number {
    return this.queue.length;
  }

  snapshot(): RelayedDirective[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }

  /**
   * Try to deliver everything queued. `send` reports whether the write landed;
   * whatever fails stays queued (and is never re-sent once written).
   */
  drain(send: (content: string) => boolean): number {
    if (this.queue.length === 0) return 0;
    const remaining: RelayedDirective[] = [];
    let delivered = 0;
    for (const d of this.queue) {
      if (send(d.content)) delivered += 1;
      else remaining.push(d);
    }
    this.queue = remaining;
    return delivered;
  }
}

export type PostResult = "ok" | "permanent" | "transient";

export interface DrainResult {
  /** Items in batches that were accepted (or permanently refused) in order. */
  deliveredItems: number;
  /** Items permanently refused — recorded as an incomplete sync. */
  droppedItems: number;
  /** Items still undelivered when the drain gave up. */
  incompleteItems: number;
  /** True when every item was either stored or explicitly dropped. */
  ok: boolean;
}

/**
 * Drain ordered batches of events, retrying only transient failures and only
 * within an optional deadline.
 *
 * Contract:
 *  - batches are attempted in order; a batch that ends `transient` stops the
 *    drain (its successors are behind it in the log, so skipping ahead would
 *    record the call out of order);
 *  - `permanent` means the server refused THIS payload (a 4xx that is not
 *    408/429) — it is counted as dropped so the queue can move on rather than
 *    blocking every later event forever;
 *  - with a deadline, transient failures are retried until it passes; without
 *    one, a single attempt is made and the rest is handed back to the caller.
 */
export async function drainEventQueue<E>(input: {
  batches: E[][];
  post: (batch: E[]) => Promise<PostResult>;
  /** Absolute timestamp after which no further retry is attempted. */
  deadlineAt?: number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}): Promise<DrainResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retryDelayMs = input.retryDelayMs ?? 250;
  const deadline = input.deadlineAt ?? null;

  let deliveredItems = 0;
  let droppedItems = 0;

  for (let i = 0; i < input.batches.length; i++) {
    const batch = input.batches[i];
    for (;;) {
      let result: PostResult;
      try {
        result = await input.post(batch);
      } catch {
        result = "transient";
      }
      if (result === "ok") {
        deliveredItems += batch.length;
        break;
      }
      if (result === "permanent") {
        deliveredItems += batch.length;
        droppedItems += batch.length;
        break;
      }
      // Transient: retry only while there is budget for it.
      if (deadline == null || now() >= deadline) {
        const remaining = input.batches.slice(i).reduce((n, b) => n + b.length, 0);
        return { deliveredItems, droppedItems, incompleteItems: remaining, ok: false };
      }
      await sleep(retryDelayMs);
    }
  }

  return { deliveredItems, droppedItems, incompleteItems: 0, ok: droppedItems === 0 };
}

/**
 * The timestamp an attempt's clock should run from.
 *
 * Seeded once from the server's `started_at` and never re-stamped by a later
 * `session.ready`: a reconnect used to reset the elapsed timer, which quietly
 * extended a call past its maximum (and reset every event timestamp to zero).
 */
export function resolveAttemptStartedAt(
  serverStartedAtMs: number | null | undefined,
  existing: number | null,
  now: number = Date.now(),
): number {
  if (existing != null) return existing;
  if (serverStartedAtMs != null && Number.isFinite(serverStartedAtMs)) return serverStartedAtMs;
  return now;
}