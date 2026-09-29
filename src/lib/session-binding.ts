/**
 * Voice-session binding rules.
 *
 * An attempt may be attached to exactly one recorded voice session at a time.
 * That sounds bureaucratic but it is the difference between a trustworthy report
 * and a forgeable one: `/complete` scores the transcript of the session the
 * attempt is bound to, so if any request could set the session id, a caller could
 * point their attempt at somebody else's call (or at a flattering one of their
 * own) and be scored for it.
 *
 * The rules, in order:
 *  - No session stored and no session requested -> nothing to fetch; the attempt
 *    simply has no timeline.
 *  - No session stored -> bind the requested one, unless it already belongs to a
 *    DIFFERENT attempt (which is what would import another call's transcript).
 *  - Same session already stored -> idempotent, no write.
 *  - A different session -> refused, UNLESS the caller explicitly asks for a
 *    reconnect (rebind) AND proves it knows the current session id. A reconnect
 *    genuinely produces a new session id, so rebinding has to be possible — but
 *    it is deliberate and the client must be in possession of the previous one,
 *    never merely "whatever the browser sent".
 *
 * Pure and database-free on purpose: the rule that decides whether one attempt
 * may adopt another's transcript is verified directly, not only through a route.
 */

export type SessionDecision =
  | { kind: "none" }
  | { kind: "use"; sessionId: string }
  | { kind: "bind"; sessionId: string }
  | { kind: "conflict"; message: string };

export function decideSessionBinding(input: {
  attemptId: string;
  stored: string | null;
  requested: string | null | undefined;
  /** The attempt that already owns `requested`, if any. */
  ownerOfRequested: string | null;
  /** True for the dedicated reconnect endpoint. */
  allowRebind: boolean;
  /** The session the caller says is current — proof of an intentional rebind. */
  previousSessionId?: string | null;
}): SessionDecision {
  const requested = input.requested?.trim() || null;
  if (!requested) {
    return input.stored ? { kind: "use", sessionId: input.stored } : { kind: "none" };
  }
  if (input.ownerOfRequested && input.ownerOfRequested !== input.attemptId) {
    // Never adopt a session another attempt is already using.
    return { kind: "conflict", message: "That session belongs to another attempt" };
  }
  if (!input.stored) return { kind: "bind", sessionId: requested };
  if (input.stored === requested) return { kind: "use", sessionId: requested };
  if (input.allowRebind && input.previousSessionId === input.stored) {
    return { kind: "bind", sessionId: requested };
  }
  return {
    kind: "conflict",
    message: "This attempt is bound to a different session",
  };
}
