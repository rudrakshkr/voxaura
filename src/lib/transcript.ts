import { dedupeTranscriptTurns } from "./negotiation-engine";
import { MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_TURN_CHARS, MAX_TRANSCRIPT_TURNS } from "./types";
import type { TranscriptTurn } from "./types";

/**
 * Where the scored transcript came from.
 *
 * `server` is the voice service's own recorded timeline — the authoritative
 * record of the call. `client` means no timeline was available and the browser's
 * buffer had to be used, which the report labels as unverified. `server+client`
 * remains a legacy provenance value for persisted data; new scoring never produces it.
 */
export type TranscriptSource = "server" | "client" | "server+client";

/**
 * Reconcile the client's live transcript with the recorded session timeline.
 *
 * The old rule kept whichever list had MORE TURNS, which handed the authority
 * decision to raw array length: a client could out-count the server simply by
 * sending more turns, and the longest client transcript became the canonical
 * scoring input — untrusted text scored as if it were the recorded call. The rule
 * now:
 *
 *  - the server timeline is authoritative whenever a usable one exists;
 *  - browser-only turns are never merged into the recorded timeline;
 *  - with no server timeline at all, the client transcript is used and the
 *    report says so explicitly rather than pretending the two are equivalent.
 *
 * Deterministic: same inputs, same output, no LLM.
 */
/**
 * Bound a turn list to the same aggregate limits `/complete` enforces on the
 * client body, keeping the MOST RECENT turns.
 *
 * The client's transcript is capped by the request schema, but the recorded
 * timeline is fetched from the voice service and arrives unbounded — a long call,
 * or a service that returns far more than the call contained, would otherwise be
 * interpolated into the scoring prompt whole. Keeping the tail rather than the
 * head is deliberate: the opening facts (anchor, first counter) are already
 * recorded authoritatively in the engine state, while the close is only in the
 * transcript.
 */
export function boundTranscriptTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  const window = (
    turns.length > MAX_TRANSCRIPT_TURNS ? turns.slice(turns.length - MAX_TRANSCRIPT_TURNS) : turns
  ).map((t) =>
    // A single turn longer than the aggregate cap would make the trim below
    // meaningless: clamp each turn first, exactly as the request schema does.
    t.text.length > MAX_TRANSCRIPT_TURN_CHARS
      ? { ...t, text: t.text.slice(0, MAX_TRANSCRIPT_TURN_CHARS) }
      : t,
  );
  const total = window.reduce((n, t) => n + t.text.length, 0);
  if (total <= MAX_TRANSCRIPT_CHARS) return window;
  // Walk backwards KEEPING turns — the running total has to measure what is kept,
  // not what is dropped. At least one turn survives: a single turn longer than the
  // cap is better than an empty transcript.
  const out: TranscriptTurn[] = [];
  let kept = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    const len = window[i].text.length;
    if (out.length > 0 && kept + len > MAX_TRANSCRIPT_CHARS) break;
    kept += len;
    out.unshift(window[i]);
  }
  return out;
}

export function canonicalTranscript(
  clientTurns: TranscriptTurn[],
  serverTurns: TranscriptTurn[],
): { turns: TranscriptTurn[]; source: TranscriptSource } {
  const client = dedupeTranscriptTurns(boundTranscriptTurns(clientTurns));
  const server = dedupeTranscriptTurns(boundTranscriptTurns(serverTurns));

  // The voice service timeline is authoritative whenever a usable one exists.
  // Never allow arbitrary browser-only turns to be injected into the scored
  // transcript: the browser payload is untrusted input.
  if (server.length > 0) return { turns: server, source: "server" };

  // Only fall back to the browser transcript when the recorded timeline is
  // genuinely unavailable. The report UI labels this provenance as unverified.
  return { turns: client, source: "client" };
}

/**
 * Map a recorded timeline artifact into transcript turns.
 *
 * A single timeline item can carry BOTH sides of an exchange; keeping only one
 * of them (the old code read `user_transcript ?? agent_text`) silently dropped the
 * recruiter's half of the conversation. Both are emitted, user first.
 */
export function timelineToTurns(
  timeline: Array<{ user_transcript?: string; agent_text?: string }>,
): TranscriptTurn[] {
  // One timeline item can yield two turns, so only the items that could still
  // fit inside the aggregate cap are mapped at all, and the result is bounded
  // like every other transcript that reaches the scorer.
  return boundTranscriptTurns(
    timeline
      .slice(-MAX_TRANSCRIPT_TURNS)
      .flatMap((turn): TranscriptTurn[] => {
        const out: TranscriptTurn[] = [];
        const user = turn.user_transcript?.trim();
        const agent = turn.agent_text?.trim();
        if (user) out.push({ role: "user", text: user, interrupted: false, atMs: null });
        if (agent) out.push({ role: "agent", text: agent, interrupted: false, atMs: null });
        return out;
      })
      .filter((t) => t.text.length > 0),
  );
}