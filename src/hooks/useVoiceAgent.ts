"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useMicCapture } from "./useMicCapture";
import { usePcmPlayback } from "./usePcmPlayback";
import {
  base64EncodePCM,
  type ClientMsg,
  type VoiceAgentEvent,
} from "@/lib/voice/protocol";
import { MAX_EVENTS_PER_REQUEST } from "@/lib/types";
import type { BatchedEvent, CompPackage, TranscriptTurn } from "@/lib/types";
import {
  detectHostileLanguage,
  extractSpokenPackage,
  transcriptSignature,
  type CloseOutcome,
  type TurnDirective,
} from "@/lib/negotiation-engine";
import {
  DirectiveRelay,
  type RelayedDirective,
  drainEventQueue,
  resolveAttemptStartedAt,
} from "@/lib/voice/relay";

/**
 * Client-handled function tools for the AssemblyAI voice agent.
 * Defined inline here to avoid tree-shaking by the bundler.
 * Must match src/lib/ai/tools.ts exactly.
 */
const OPPONENT_TOOLS = [
  {
    type: "function",
    name: "offer_to_candidate",
    description:
      "State a formal offer to the candidate. Call this whenever you present or revise your compensation numbers aloud, including your opening numbers.",
    parameters: {
      type: "object",
      properties: {
        base_salary: {
          type: "integer",
          description: "Annual base salary in USD. Example: 140000",
        },
        sign_on: {
          type: "integer",
          description: "One-time signing bonus in USD. Example: 10000",
        },
        equity: {
          type: "number",
          description: "Annualized equity value in USD per year. Example: 20000",
        },
        notes: {
          type: "string",
          description: "Very short framing, e.g. 'standard band for this level'",
        },
      },
      required: ["base_salary"],
    },
  },
  {
    type: "function",
    name: "accept_user_offer",
    description:
      "Accept the candidate's proposed package. Call this the moment you decide to agree to the candidate's numbers.",
    parameters: {
      type: "object",
      properties: {
        final_base: {
          type: "integer",
          description: "Agreed annual base salary in USD. Example: 152000",
        },
        sign_on: { type: "integer", description: "Agreed sign-on bonus in USD." },
        equity: { type: "number", description: "Agreed annualized equity value in USD." },
      },
      required: ["final_base"],
    },
  },
  {
    type: "function",
    name: "log_user_move",
    description:
      "Log a negotiation move the candidate just made. Call after the candidate states a number, makes a concession, applies pressure, or raises an objection.",
    parameters: {
      type: "object",
      properties: {
        move: {
          type: "string",
          enum: ["counter_offer", "ask", "concession", "pressure", "objection", "rapport", "walkaway_threat"],
          description: "The kind of move the candidate made.",
        },
        amount: {
          type: "integer",
          description: "Dollar amount mentioned, if any. Example: 160000",
        },
        note: {
          type: "string",
          description: "Short paraphrase of what the candidate said.",
        },
      },
      required: ["move"],
    },
  },
] as unknown as unknown[];

export type AgentStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "ended"
  | "error";

export interface VoiceAgentState {
  status: AgentStatus;
  error: string | null;
  sessionId: string | null;
  transcript: TranscriptTurn[];
  partialUser: string | null;
  userSpeaking: boolean;
  agentSpeaking: boolean;
  /** "thinking" = user finished, recruiter reply in flight. */
  recruiterThinking: boolean;
  /** True right after the user barged in; clears on the next recruiter turn. */
  justInterrupted: boolean;
  /** Authoritative package: set ONLY by server-validated offers/acceptances. */
  currentOffer: CompPackage | null;
  /** The package before the latest change, used for the "vs. last offer" delta. */
  previousOffer: CompPackage | null;
  acceptedOffer: CompPackage | null;
  offerConditions: string[];
  /**
   * Shown when the recruiter improvised a number beyond the approved band and
   * the panel had to trim it — so a mismatch between what was said aloud and
   * what the panel shows is explained rather than silently wrong.
   */
  offerNotice: string | null;
  /**
   * Set when the recruiter verbally deferred the decision to an off-screen
   * team. Nothing happens off-screen in a simulation, so the candidate is
   * prompted to press for the answer instead of waiting on a dead promise.
   */
  deferral: { quote: string } | null;
  elapsedSec: number;
  /**
   * Non-fatal call-health warning. A live-looking connection that transmits no
   * microphone audio is indistinguishable from a working call without this, so
   * the agent being deaf must be visible to the user.
   */
  audioWarning: string | null;
  /** True when mic frames actually reached the call in the last ~1.5s. */
  audioFlowing: boolean;
  /**
   * Set when the negotiation is genuinely over — the engine declares a deadlock
   * or the candidate is abusive. The call closes itself and the UI shows a
   * banner rather than leaving the user on a dead line.
   */
  dealClosed: { outcome: CallCloseReason } | null;
  /**
   * True once the candidate has been warned about hostile language. A second
   * offence ends the call — respect is not part of the negotiation.
   */
  abuseWarning: boolean;
  /**
   * Durable-event sync health, surfaced in the session status strip. Events are
   * batched client-side and flushed to Postgres; a failed flush keeps them
   * queued and retries, so nothing is silently lost mid-demo and the user can
   * see that state is still being recorded.
   */
  sync: { pending: number; recorded: number; state: "idle" | "syncing" | "error" };
}

/** Why the client hung up: an agreed deal, an engine-declared deadlock, or abuse. */
export type CallCloseReason = CloseOutcome | "abuse" | "accepted";

export interface InlineAgentConfig {
  systemPrompt: string;
  greeting: string;
}

/**
 * The `session.update` body for inline (non-stored) agents. One builder so the
 * initial handshake and a post-resume re-attach can never drift apart.
 *
 * `greetingOverride: null` skips the greeting entirely (a resume already played
 * it). `resumeNote` is appended to the system prompt: without it a reconnect
 * re-sent the ORIGINAL prompt — whose "opening package" section still describes
 * the un-negotiated offer — and the recruiter could go back to quoting numbers
 * the call had already moved past.
 */
function inlineSessionPayload(
  cfg: InlineAgentConfig,
  opts?: { greetingOverride?: string | null; resumeNote?: string },
) {
  const greeting = opts?.greetingOverride === undefined ? cfg.greeting : opts.greetingOverride;
  return {
    system_prompt: opts?.resumeNote ? `${cfg.systemPrompt}\n${opts.resumeNote}` : cfg.systemPrompt,
    ...(greeting ? { greeting } : {}),
    output: { voice: "anna" },
    tools: OPPONENT_TOOLS,
    input: {
      turn_detection: {
        min_silence: 700,
        max_silence: 1600,
        interrupt_response: true,
      },
    },
  };
}

/** One sentence naming the package, used by the resume note and greeting. */
function packagePhrase(pkg: CompPackage): string {
  const extras = [
    (pkg.sign_on ?? 0) > 0 ? `${(pkg.sign_on ?? 0).toLocaleString("en-US")} sign-on` : "",
    (pkg.equity ?? 0) > 0 ? `${(pkg.equity ?? 0).toLocaleString("en-US")} in annual equity` : "",
  ].filter(Boolean);
  const base = `${pkg.base.toLocaleString("en-US")} base`;
  return extras.length > 0 ? `${base}, ${extras.join(" and ")}` : base;
}

/**
 * Context for a re-attach or a mid-call restart: the call is already underway,
 * so the greeting and the prompt's opening facts are both wrong. Returns null
 * for a genuinely fresh call.
 */
function resumeContext(offer: CompPackage | null, midCall: boolean) {
  if (!midCall) return null;
  const sentence = offer ? packagePhrase(offer) : null;
  const note = [
    "## RESUME NOTE (this call is already in progress)",
    "- You have already spoken with this candidate on this call. Do not greet them again and do not restart the conversation.",
    sentence
      ? `- The package on the table right now is ${sentence}. That supersedes the opening package described above — never quote the opening numbers again.`
      : "- No package has been stated yet on this call.",
  ].join("\n");
  return {
    note,
    greeting: sentence
      ? `Sorry about that — I'm back. So, where we are: ${sentence}. Where were we?`
      : "Sorry about that — I'm back. Where were we?",
  };
}

const MAX_SESSION_SEC = 10 * 60; // client-side guard; server TTL gives no warning
const MicBufferSamples = 4096; // ~170ms at 24 kHz per WS message
const AUDIO_SILENCE_MS = 6000; // ready but no frames transmitted this long => warn
const AUDIO_FLOWING_MS = 1500; // frames this recent count as "audio is flowing"
const RESUME_GRACE_MS = 25_000; // server holds sessions for 30s after drop
// The voice service occasionally finalises the same utterance twice. Identical
// text from the same speaker inside this window is one turn, not two.
const AGENT_DUPLICATE_MS = 45_000;
const USER_DUPLICATE_MS = 3_000;
/** Bound on one engine round-trip before we give up and (once) retry. */
const TURN_FETCH_TIMEOUT_MS = 15_000;
/** A reply that runs this long is treated as dead — see the watchdog sweeper. */
const AGENT_SPEAKING_TIMEOUT_MS = 25_000;
/** How often the watchdog sweeps the queue and a stuck agent state. */
const TURN_WATCHDOG_MS = 1_500;
/** Total engine attempts (across retries + watchdog re-queues) per utterance. */
const MAX_TURN_ATTEMPTS = 4;
/**
 * How long the line must stay COMPLETELY quiet — no reply in flight, no audio
 * left to play — before we hang up.
 *
 * Measured from real silence, never from a guessed duration. Any delay picked
 * in advance is a delay that can be shorter than the recruiter's sentence.
 */
const CLOSE_QUIET_MS = 4000;
/** How often the close waiter re-checks whether the recruiter is still talking. */
const CLOSE_POLL_MS = 250;
/** Absolute ceiling on waiting, so a wedged reply can never strand the call. */
const CLOSE_MAX_WAIT_MS = 20_000;

/**
 * `fetch` with a real deadline.
 *
 * Rejecting a promise does not stop the request behind it: without an abort the
 * abandoned call keeps running, and a retry then races a request that is still
 * in flight. The controller cancels it, and the caller retries under the SAME
 * turn id so the server can replay instead of negotiating twice.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Refresh resilience.
 *
 * The engine's negotiation state lives server-side and survives a reload on its
 * own, but two things do not: the browser's transcript buffer and the voice
 * session identity. Losing them means a mid-call refresh restarts the
 * conversation from scratch — and, worse, a NEW AssemblyAI session id replaces
 * the recorded one, so the server-side transcript fallback can only recover the
 * part of the call that happened after the reload.
 *
 * Both are therefore mirrored into `sessionStorage` (per attempt, cleared when
 * the call ends), which is exactly the lifetime we want: surviving a reload,
 * gone when the tab closes.
 */
const MAX_PERSISTED_TURNS = 300;
const sessionKey = (attemptId: string) => `voxaura:session:${attemptId}`;
const transcriptKey = (attemptId: string) => `voxaura:transcript:${attemptId}`;
const directiveKey = (attemptId: string) => `voxaura:directives:${attemptId}`;

function storageGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null; // private mode / disabled storage
  }
}

function storageSet(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value == null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Best-effort: persistence must never break a live call.
  }
}

function loadPersistedTranscript(attemptId: string): TranscriptTurn[] {
  const raw = storageGet(transcriptKey(attemptId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TranscriptTurn[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.text === "string" && (t.role === "user" || t.role === "agent"))
      .slice(-MAX_PERSISTED_TURNS);
  } catch {
    return [];
  }
}

function loadPersistedSession(attemptId: string): string | null {
  return storageGet(sessionKey(attemptId));
}

function loadPersistedDirectives(attemptId: string): RelayedDirective[] {
  const raw = storageGet(directiveKey(attemptId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is RelayedDirective =>
        Boolean(d) &&
        typeof d === "object" &&
        typeof (d as { key?: unknown }).key === "string" &&
        typeof (d as { content?: unknown }).content === "string",
    );
  } catch {
    return [];
  }
}

/**
 * A per-utterance idempotency key. Stable across the retries of ONE utterance, so
 * a timeout-then-retry pair is processed exactly once. `randomUUID` needs a
 * secure context; the fallback keeps local (non-HTTPS, non-localhost) runs alive.
 */
function newTurnId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SETUP_TIMEOUT_MS = 15_000; // token + WS + session.ready must land within this
const GREETING_TIMEOUT_MS = 12_000; // ready but no recruiter audio => setup is wedged

export function useVoiceAgent(args: {
  attemptId: string;
  agentId: string | null;
  agentMode: "stored" | "inline";
  inlineConfig?: InlineAgentConfig | null;
  /** Server-derived standing package, so the panel is never empty at call start. */
  initialOffer?: CompPackage | null;
  /**
   * When the ATTEMPT started, from the server (`attempt.started_at`).
   *
   * The elapsed clock and every event timestamp are relative to this rather than
   * to the moment the socket last became ready, so a reconnect cannot reset the
   * timer and quietly extend the call past its maximum.
   */
  startedAtMs?: number | null;
}) {
  const [state, setState] = useState<VoiceAgentState>({
    status: "idle",
    error: null,
    sessionId: null,
    // Restored from sessionStorage: a reload mid-call keeps what was said, and
    // the report scores the whole conversation instead of the post-reload half.
    transcript: loadPersistedTranscript(args.attemptId),
    partialUser: null,
    userSpeaking: false,
    agentSpeaking: false,
    recruiterThinking: false,
    justInterrupted: false,
    currentOffer: args.initialOffer ?? null,
    previousOffer: null,
    acceptedOffer: null,
    offerConditions: [],
    offerNotice: null,
    deferral: null,
    elapsedSec: 0,
    audioWarning: null,
    audioFlowing: false,
    dealClosed: null,
    abuseWarning: false,
    sync: { pending: 0, recorded: 0, state: "idle" },
  });

  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<AgentStatus>("idle");
  // Restored so a reload resumes the SAME voice session rather than replacing
  // it — which also keeps the server-side session timeline complete.
  const sessionIdRef = useRef<string | null>(loadPersistedSession(args.attemptId));
  // Seeded from the attempt's server-side start time. A reconnect does NOT
  // re-stamp it (see `session.ready`), so a dropped socket cannot hand the caller
  // a fresh ten minutes.
  const startedAtRef = useRef<number | null>(args.startedAtMs ?? null);
  const endedByUsRef = useRef(false);
  const resumedOnceRef = useRef(false);
  const connectingRef = useRef(false);
  const closedCleanlyRef = useRef(false);

  // Tool-result idle tracking (per AssemblyAI client-side tools pattern).
  const lastEventRef = useRef<string | null>(null);
  const pendingToolsRef = useRef<Array<{ call_id: string; result: string }>>([]);

  // Mic chunk coalescing buffer.
  const micBufRef = useRef<Int16Array>(new Int16Array(0));

  // Live audio-flow health. `chunks` counts frames the mic produced and `sent`
  // counts input.audio messages that actually left the browser — the two
  // drifting apart is exactly the failure mode this exists to catch.
  const audioStatsRef = useRef({ chunks: 0, sent: 0, lastSentAt: 0 });
  // Last values pushed to state, so the 1s watchdog doesn't re-render needlessly.
  const audioWarnRef = useRef<string | null>(null);
  const audioFlowRef = useRef(false);
  // Set when a check was skipped because the tab was hidden, so capture gets a
  // fresh window to resume before we judge it.
  const hiddenSkipRef = useRef(false);

  // Event batch queue for the attempts API.
  const eventQueueRef = useRef<BatchedEvent[]>([]);
  /** Events confirmed inserted by the server — shown in the session status. */
  const recordedEventsRef = useRef(0);

  // Engine directives that were ready but could not be written to the socket.
  //
  // `send()` silently did nothing when the websocket was not open, so a
  // successful `/turn` whose recruiter directive arrived during a blip lost that
  // directive FOREVER: the engine had decided, the browser had the answer, and
  // the recruiter simply never heard it. Directives are now queued by turn id
  // and delivered after the session reconnects — re-running `/turn` would be
  // wrong (the state has already moved) and sending twice would make the
  // recruiter repeat itself.
  const directiveRelayRef = useRef(new DirectiveRelay(loadPersistedDirectives(args.attemptId)));
  // Authorization issued by the most recent `/turn`, presented to `/offer` so the
  // server can tell a real recruiter action from a forged request.
  const latestAuthRef = useRef<{ token: string; action: "offer" | "accept"; package: CompPackage } | null>(
    null,
  );

  // Turn relay: user utterances queue here until their engine directive has
  // been dispatched. A QUEUE, never a slot — an utterance the engine has not
  // seen must survive every later event (missed reply.done, hung fetch,
  // barge-in) until it is dispatched. The old single slot was overwritten by
  // each new utterance, so a wedged trigger meant the recruiter went deaf for
  // whole turns: the user spoke two, three times and nothing happened.
  const pendingTurnsRef = useRef<Array<{ text: string; interrupted: boolean; attempts: number }>>([]);
  const turnInFlightRef = useRef(false);
  // When the current agent reply started — the watchdog reaps a reply that
  // never ended (missing reply.done) instead of staying deaf forever.
  const agentSpeakingAtRef = useRef(0);

  // Closing the call. The engine only names a `close` outcome for a genuine,
  // worked-over deadlock (or an explicit walk-away), never a single firm "no".
  // Even then the recruiter finishes their sentence and anything the candidate
  // says in the meantime cancels the scheduled hang-up.
  const pendingCloseRef = useRef<CallCloseReason | null>(null);
  const closingRef = useRef(false);
  const abuseWarnedRef = useRef(false);
  const endRef = useRef<() => void>(() => {});
  /** Counts finished recruiter replies, so a close can wait for the last one. */
  const replyDoneSeqRef = useRef(0);
  /** Polling waiter that hangs up only once the line has gone quiet. */
  const closePollRef = useRef<number | null>(null);
  /** Set once a deal is agreed; makes the acceptance hang-up uncancellable. */
  const acceptCloseRef = useRef(false);

  // Duplicate-turn guards. A repeated finalisation used to print the recruiter's
  // sentence twice AND get re-parsed as a fresh offer, which is how the panel
  // ended up changing because of a duplicate rather than anything said.
  const lastAgentTurnRef = useRef<{ sig: string; at: number } | null>(null);
  const lastUserTurnRef = useRef<{ sig: string; at: number } | null>(null);

  const mic = useMicCapture();
  const playback = usePcmPlayback();
  const argsRef = useRef(args);
  argsRef.current = args;

  // Timer + mic handles for setup failure paths (cleared on ready/end).
  const setupTimerRef = useRef<number | null>(null);
  const greetingTimerRef = useRef<number | null>(null);
  // True once the mic stream is open (pre-flight or post-ready).
  const micReadyRef = useRef(false);
  // True while getUserMedia is pending — stops session.ready from firing a
  // second permission request when it lands before the grant.
  const micStartingRef = useRef(false);
  // One fresh-session restart per call is allowed when a resume turns out to
  // reference a session whose grace window has already expired.
  const freshRetriedRef = useRef(false);
  // True while we deliberately tear the socket down to restart a fresh call.
  const restartingRef = useRef(false);
  // True when the failure came from session setup (bad config / rejected
  // update) rather than the transport — lets onclose keep the better message.
  const setupFailRef = useRef(false);
  // True when this session was configured to speak on connect, so "connected but
  // silent" is a setup failure rather than a normal mid-call resume.
  const expectSpeechRef = useRef(false);
  // Live mirror of state for reads inside timers/event handlers without
  // stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Mirrors of state used by the WS handlers: the recruiter must not be
  // interrupted mid-utterance by a directive, and the deferral banner should
  // only re-render when its state actually changes.
  const agentSpeakingRef = useRef(false);
  const deferralRef = useRef(false);

  const patch = useCallback((p: Partial<VoiceAgentState>) => {
    if (p.status) statusRef.current = p.status;
    if (p.agentSpeaking !== undefined) agentSpeakingRef.current = p.agentSpeaking;
    setState((s) => ({ ...s, ...p }));
  }, []);

  /** Stop the close waiter, if one is running. */
  const stopClosePoll = useCallback(() => {
    if (closePollRef.current != null) {
      window.clearInterval(closePollRef.current);
      closePollRef.current = null;
    }
  }, []);

  /**
   * End the call gracefully.
   *
   * The banner goes up immediately, but the socket stays open until the line is
   * genuinely quiet: a reply has finished since we asked to close, nothing is
   * in flight, nothing is left to play, and it has stayed that way for
   * CLOSE_QUIET_MS. Waiting on measured silence rather than a guessed duration
   * is the only way to be sure we never hang up mid-sentence, however long the
   * recruiter's closing line runs.
   */
  const closeCall = useCallback(
    (outcome: CallCloseReason) => {
      if (endedByUsRef.current || closingRef.current) return;
      closingRef.current = true;
      pendingCloseRef.current = null;
      patch({ dealClosed: { outcome } });
      const armSeq = replyDoneSeqRef.current;
      const startedAt = Date.now();
      let idleSince = 0;
      stopClosePoll();
      closePollRef.current = window.setInterval(() => {
        if (endedByUsRef.current) {
          stopClosePoll();
          return;
        }
        const heardReply = replyDoneSeqRef.current > armSeq;
        const busy =
          agentSpeakingRef.current ||
          playback.remainingMs() > 0 ||
          // A deadlock close also waits for the candidate: nothing they said may
          // be left unanswered. (An agreed deal is final and skips this.)
          (!acceptCloseRef.current &&
            (turnInFlightRef.current || pendingTurnsRef.current.length > 0));
        if (heardReply && !busy) {
          if (idleSince === 0) idleSince = Date.now();
          else if (Date.now() - idleSince >= CLOSE_QUIET_MS) {
            stopClosePoll();
            endRef.current();
            return;
          }
        } else {
          idleSince = 0;
        }
        if (Date.now() - startedAt >= CLOSE_MAX_WAIT_MS) {
          stopClosePoll();
          endRef.current();
        }
      }, CLOSE_POLL_MS);
    },
    [patch, playback, stopClosePoll],
  );
  const closeCallRef = useRef(closeCall);
  closeCallRef.current = closeCall;

  /**
   * A scheduled hang-up is cancelled the moment the candidate says anything.
   * If there is still something to say, there is still something to negotiate.
   */
  const cancelPendingClose = useCallback(() => {
    if (acceptCloseRef.current) return; // the deal is agreed; the call is over
    stopClosePoll();
    if (closingRef.current && !endedByUsRef.current) {
      closingRef.current = false;
      patch({ dealClosed: null });
    }
  }, [patch, stopClosePoll]);
  const cancelPendingCloseRef = useRef(cancelPendingClose);
  cancelPendingCloseRef.current = cancelPendingClose;

  /**
   * The deal is agreed, so the call will close — but only after the recruiter
   * has finished announcing it. The waiter does the waiting; there is nothing
   * to schedule here.
   */
  const armAcceptClose = useCallback(() => {
    if (acceptCloseRef.current || endedByUsRef.current) return;
    acceptCloseRef.current = true;
    closeCallRef.current("accepted");
  }, []);
  const armAcceptCloseRef = useRef(armAcceptClose);
  armAcceptCloseRef.current = armAcceptClose;

  /**
   * Promote a new authoritative package, keeping the previous one for deltas.
   * Accepts an updater for the optimistic speech path, where the panel must
   * merge spoken components into whatever is already on the table.
   */
  const setOffer = useCallback(
    (
      pkg: CompPackage | ((prev: CompPackage) => CompPackage),
      conditions?: string[] | null,
    ) => {
      setState((s) => {
        const next =
          typeof pkg === "function"
            ? pkg(s.currentOffer ?? { base: 0, sign_on: 0, equity: 0 })
            : pkg;
        // Both the tool call and the spoken sentence reach the server, so the
        // same package can arrive twice. Re-promoting an identical package must
        // not manufacture a "vs. last offer" delta that never happened.
        const unchanged =
          s.currentOffer != null &&
          s.currentOffer.base === next.base &&
          (s.currentOffer.sign_on ?? 0) === (next.sign_on ?? 0) &&
          (s.currentOffer.equity ?? 0) === (next.equity ?? 0);
        return {
          ...s,
          previousOffer: unchanged ? s.previousOffer : s.currentOffer,
          currentOffer: next,
          ...(conditions ? { offerConditions: conditions } : {}),
        };
      });
    },
    [],
  );

  const queueEvent = useCallback(
    (e: BatchedEvent) => {
      eventQueueRef.current.push(e);
      patch({
        sync: {
          pending: eventQueueRef.current.length,
          recorded: recordedEventsRef.current,
          state: "idle",
        },
      });
      if (eventQueueRef.current.length >= 10) {
        void flushEventsRef.current();
      }
    },
    [patch],
  );

  /**
   * Flush queued events to the durable log.
   *
   * `await fetch(...)` resolving is NOT success — a 500 resolves too. The status
   * code is checked explicitly, failed batches are put back at the front of the
   * queue, and a retry is scheduled, so a mid-demo network blip delays the log
   * instead of silently dropping the negotiation history.
   *
   * Two things the naive whole-queue POST got wrong:
   *  - SIZE. The server accepts at most MAX_EVENTS_PER_REQUEST events. A long
   *    network outage lets the queue grow past that, and then every flush is
   *    answered with a 400 — forever, with each retry re-appending the same
   *    oversized batch, so the log silently stops growing mid-call. The queue is
   *    therefore drained in chunks the server will actually accept.
   *  - PERMANENCE. Retrying is only right while an error could be transient. A
   *    4xx (other than the two that explicitly mean "later") is the server
   *    refusing THIS payload — a retry loop can never succeed, blocks every
   *    event queued behind it, and hammers the API for the life of the tab.
   */
  const flushEvents = useCallback(
    async (opts?: {
      /**
       * Final flush before scoring: retry transient failures only until a bounded
       * deadline, and report whether the log is complete rather than assuming it.
       */
      final?: boolean;
      deadlineMs?: number;
    }): Promise<{ ok: boolean; pending: number }> => {
      const events = eventQueueRef.current;
      if (events.length === 0) {
        if (stateRef.current.sync.state !== "idle") {
          patch({
            sync: {
              pending: 0,
              recorded: recordedEventsRef.current,
              state: "idle",
            },
          });
        }
        return { ok: true, pending: 0 };
      }
      // Claim the whole queue before the first await: a second concurrent flush
      // then sees an empty queue instead of re-sending what this one already has.
      eventQueueRef.current = [];
      patch({
        sync: { pending: events.length, recorded: recordedEventsRef.current, state: "syncing" },
      });

      const batches: BatchedEvent[][] = [];
      for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
        batches.push(events.slice(i, i + MAX_EVENTS_PER_REQUEST));
      }

      // The retry/deadline policy lives in lib/voice/relay.ts so it can be tested
      // without a browser: transient failures are retried only within the final
      // flush's budget, a permanent refusal drops that chunk instead of wedging
      // every later event behind it, and the result says plainly whether the log
      // is complete.
      // Tracked locally rather than read off the drain result: `post` runs while
      // the call is still in flight, so the result object does not exist yet.
      let deliveredSoFar = 0;
      const result = await drainEventQueue({
        batches,
        deadlineAt: opts?.final ? Date.now() + (opts.deadlineMs ?? 3_000) : null,
        retryDelayMs: 250,
        sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
        post: async (batch) => {
          try {
            const res = await fetch(`/api/attempts/${argsRef.current.attemptId}/events`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: sessionIdRef.current, events: batch }),
            });
            if (!res.ok) {
              const permanent =
                res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
              if (permanent) {
                console.error(
                  `[voice] server refused ${batch.length} event(s) (${res.status}); dropping that batch`,
                );
                return "permanent";
              }
              return "transient";
            }
            const data = (await res.json().catch(() => ({}))) as { inserted?: number };
            recordedEventsRef.current += data.inserted ?? batch.length;
            deliveredSoFar += batch.length;
            patch({
              sync: {
                pending: Math.max(0, events.length - deliveredSoFar),
                recorded: recordedEventsRef.current,
                state: "syncing",
              },
            });
            return "ok";
          } catch {
            return "transient";
          }
        },
      });

      if (result.incompleteItems > 0) {
        // Put back exactly what was never delivered, ahead of anything queued
        // since, and (for the periodic flush) retry shortly.
        eventQueueRef.current.unshift(...events.slice(events.length - result.incompleteItems));
        patch({
          sync: {
            pending: eventQueueRef.current.length,
            recorded: recordedEventsRef.current,
            state: "error",
          },
        });
        if (!opts?.final) window.setTimeout(() => void flushEventsRef.current(), 2500);
        return { ok: false, pending: eventQueueRef.current.length };
      }

      patch({
        sync: {
          pending: eventQueueRef.current.length,
          recorded: recordedEventsRef.current,
          state: result.droppedItems > 0 ? "error" : "idle",
        },
      });
      return { ok: result.ok, pending: eventQueueRef.current.length };
    },
    [patch],
  );
  const flushEventsRef = useRef(flushEvents);
  flushEventsRef.current = flushEvents;

  // ---------------------------------------------------------------------------
  // Spoken-offer reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Tell the server what the recruiter just said, and adopt the package it
   * returns. The server owns the economics: it parses the utterance, trims any
   * improvised numbers to the company ceiling and persists the result — so the
   * panel, the engine and the final report all agree with the call the user
   * actually heard. It also tells us when the recruiter stalled by promising to
   * "check with the team".
   */
  const reconcileOffer = useCallback(
    async (
      input: {
        agentText?: string;
        pkg?: CompPackage;
        conditions?: string[] | null;
        /**
         * The recruiter agreed to the candidate's package. This is a REQUEST:
         * the server re-evaluates it against the authoritative economics and
         * only records a deal when the engine agrees.
         */
        acceptPackage?: CompPackage;
        /**
         * The single-use token `/turn` issued for this exact action. Without it
         * the server records the speech as an observation and changes no
         * economics — the browser cannot make a recruiter action real.
         */
        authorizationToken?: string;
      },
      atMs: number | null,
    ) => {
      try {
        const res = await fetch(`/api/attempts/${argsRef.current.attemptId}/offer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_text: input.agentText,
            package: input.pkg,
            conditions: input.conditions?.length ? input.conditions : undefined,
            accept_candidate_package: input.acceptPackage,
            authorization_token: input.authorizationToken,
            at_ms: atMs,
          }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          offer: CompPackage;
          changed: boolean;
          /** The engine state changed AND this request was authorized for it. */
          authoritative?: boolean;
          /** The recruiter said something that is not on the table. */
          correction?: boolean;
          notice: string | null;
          conditions: string[] | null;
          /** True only when the ENGINE validated the agreement. */
          accepted?: boolean;
          accept_reason?: string | null;
          deferral?: { outstanding: boolean; deferredNow: boolean; quote: string | null };
        };

        // The panel is already showing what the recruiter said (it was set the
        // moment the words arrived); the server response only confirms what the
        // engine state now holds, so later FACT lines quote the same figures.
        if (data.changed && data.offer) {
          setOffer(data.offer, data.conditions?.length ? data.conditions : undefined);
        } else if (data.correction && data.offer) {
          // An unauthorized spoken figure was recorded as an inconsistency. The
          // panel must not keep showing a number that is not on the table.
          setOffer(data.offer);
        }
        if (data.notice) patch({ offerNotice: data.notice });
        if (data.accepted) patch({ offerNotice: null });
        if (data.authoritative && input.authorizationToken) {
          // The token is spent; never present it again.
          if (latestAuthRef.current?.token === input.authorizationToken) latestAuthRef.current = null;
        }

        const outstanding = Boolean(data.deferral?.outstanding);
        if (outstanding && !deferralRef.current) {
          deferralRef.current = true;
          patch({ deferral: { quote: data.deferral?.quote ?? "" } });
        } else if (!outstanding && deferralRef.current) {
          deferralRef.current = false;
          patch({ deferral: null });
        }
        return data;
      } catch {
        // Non-fatal: a dropped reconcile must never break the live call.
        return null;
      }
    },
    [patch, setOffer],
  );

  /**
   * Speech path: put what the recruiter JUST SAID on the panel immediately —
   * the screen must never lag the audio or disagree with it — then let the
   * server mirror the same figures into the engine state so every later turn
   * quotes them. The optimistic panel update is skipped when the sentence only
   * names a total ("a package of 185,000"): splitting a total is the engine's
   * job, and the server's response arrives a moment later with the split.
   */
  const reconcileSpokenOffer = useCallback(
    (text: string, atMs: number | null) => {
      const spoken = extractSpokenPackage(text);
      const hasComponent = spoken.base != null || spoken.sign_on != null || spoken.equity != null;
      if (hasComponent) {
        setOffer(
          (prev) => ({
            base: spoken.base ?? prev.base,
            sign_on: spoken.sign_on ?? (prev.sign_on ?? 0),
            equity: spoken.equity ?? (prev.equity ?? 0),
          }),
          null,
        );
      }
      return reconcileOffer({ agentText: text }, atMs);
    },
    [reconcileOffer, setOffer],
  );

  // ---------------------------------------------------------------------------
  // Tool execution (client-side tools)
  // ---------------------------------------------------------------------------

  const runTool = useCallback(
    (name: string, args: Record<string, unknown>): string => {
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;

      if (name === "offer_to_candidate") {
        const offer: CompPackage = {
          base: num(args.base_salary) ?? 0,
          sign_on: num(args.sign_on),
          equity: num(args.equity),
        };
        const conditions = String(args.notes ?? "")
          .split(/[.;]\s*/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        // The panel mirrors the recruiter instantly: the tool arguments ARE what
        // the recruiter is putting on the table, so they go up on the board the
        // moment the tool fires, before any network round-trip. The server call
        // then mirrors the same figures into the engine state so the next
        // directive's FACT line quotes them.
        setOffer(offer, conditions);
        // The server records the opponent offer itself (/offer) — the client does
        // not report opponent events, so it cannot fabricate one. The server only
        // accepts the figures as authoritative when `/turn` authorized them.
        const offerAuth = latestAuthRef.current;
        void reconcileOffer(
          {
            pkg: offer,
            conditions,
            authorizationToken: offerAuth?.action === "offer" ? offerAuth.token : undefined,
          },
          elapsedMs(),
        );
        return JSON.stringify({ delivered: true });
      }

      if (name === "accept_user_offer") {
        const offer: CompPackage = {
          base: num(args.final_base) ?? 0,
          sign_on: num(args.sign_on),
          equity: num(args.equity),
        };
        // The panel mirrors what the recruiter just said, but the DEAL is not
        // the model's to declare: the server re-evaluates the package against
        // the authoritative economics. The call is only armed to close — and the
        // acceptance banner only shown — once the engine confirms it, and the
        // tool result carries the verdict back so the recruiter can correct
        // itself if the model jumped the gun.
        setOffer(offer);
        const acceptAuth = latestAuthRef.current;
        void reconcileOffer(
          {
            pkg: offer,
            acceptPackage: offer,
            authorizationToken: acceptAuth?.action === "accept" ? acceptAuth.token : undefined,
          },
          elapsedMs(),
        ).then((res) => {
          if (res?.accepted) {
            patch({ acceptedOffer: res.offer ?? offer, offerNotice: null });
            armAcceptCloseRef.current();
          } else {
            patch({
              acceptedOffer: null,
              offerNotice:
                res?.accept_reason ??
                (res
                  ? "The engine did not validate that agreement — the numbers are not confirmed."
                  : null),
            });
          }
        });
        return JSON.stringify({
          status: "pending_validation",
          note: "The platform validates every agreement against the company's approved economics before it is final. If it is rejected you will be told and must not treat the deal as agreed.",
        });
      }

      if (name === "log_user_move") {
        const move = String(args.move ?? "ask");
        const typeMap: Record<string, BatchedEvent["type"]> = {
          counter_offer: "user_offer",
          ask: "user_offer",
          concession: "concession",
          pressure: "pressure_tactic",
          objection: "objection_raised",
          rapport: "rapport",
          walkaway_threat: "pressure_tactic",
        };
        queueEvent({
          type: typeMap[move] ?? "user_offer",
          actor: "user",
          source: "tool",
          payload: { amount: num(args.amount), note: args.note ?? null, raw_move: move },
          at_ms: elapsedMs(),
        });
        return JSON.stringify({ logged: true });
      }

      return JSON.stringify({ error: `Unknown tool ${name}` });
    },
    [patch, queueEvent, reconcileOffer, setOffer],
  );

  function elapsedMs(): number {
    return startedAtRef.current ? Date.now() - startedAtRef.current : 0;
  }

  // ---------------------------------------------------------------------------
  // WS send helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a message to the voice socket, reporting whether it actually left.
   *
   * This used to return nothing and silently no-op when the socket was not open,
   * which is how an engine directive could be produced, acknowledged and then
   * dropped on the floor during a reconnect.
   */
  const send = useCallback((msg: ClientMsg): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  /**
   * Deliver any directive that could not be written when it was produced.
   *
   * Called once the session is ready again — never re-runs `/turn` (the engine's
   * decision already happened) and never re-sends a directive that was written
   * successfully (each is keyed by its turn id and removed on delivery).
   */
  const persistDirectives = useCallback(() => {
    const pending = directiveRelayRef.current.snapshot();
    storageSet(
      directiveKey(argsRef.current.attemptId),
      pending.length > 0 ? JSON.stringify(pending) : null,
    );
  }, []);

  const flushDirectives = useCallback(() => {
    directiveRelayRef.current.drain(
      (content) => send({ type: "conversation.message", role: "system", content }),
    );
    persistDirectives();
  }, [persistDirectives, send]);
  const flushDirectivesRef = useRef(flushDirectives);
  flushDirectivesRef.current = flushDirectives;

  // ---------------------------------------------------------------------------
  // Turn relay: user utterance → server engine → directive → agent
  // ---------------------------------------------------------------------------

  // Stable indirection: event handlers and the watchdog call the pump through
  // this ref, so ordering of useCallback definitions never matters and the
  // callback identity churn of a big effect cannot strand the queue.
  const pumpTurnQueueRef = useRef<() => void>(() => {});

  /** Dispatch every queued turn, newest last; safe to call from anywhere. */
  const pumpTurnQueue = useCallback(() => {
    if (turnInFlightRef.current) return;
    const queue = pendingTurnsRef.current;
    if (queue.length === 0) return;
    pendingTurnsRef.current = [];
    // Collapse a rapid burst into its final utterance: the engine decides on
    // the whole message, and answering each fragment would sound robotic.
    const last = queue[queue.length - 1];
    const merged = queue
      .slice(0, -1)
      .map((t) => t.text)
      .join(" ");
    const text = merged ? `${merged} ${last.text}` : last.text;
    void dispatchTurnImplRef.current(text, last.interrupted).then((ok) => {
      if (!ok) {
        // Engine unreachable: put the utterance back for the watchdog to retry,
        // until it has had MAX_TURN_ATTEMPTS tries in total.
        const attempts = last.attempts + 1;
        if (attempts < MAX_TURN_ATTEMPTS) {
          pendingTurnsRef.current.unshift({ text, interrupted: last.interrupted, attempts });
          pumpTurnQueueRef.current(); // retry immediately; the watchdog also sweeps
        } else {
          console.error("[voice] dropping utterance after repeated engine failures:", text.slice(0, 80));
        }
      }
    });
  }, []);

  pumpTurnQueueRef.current = pumpTurnQueue;

  const dispatchTurn = useCallback(
    async (text: string, interrupted: boolean) => {
      if (turnInFlightRef.current) return false;
      turnInFlightRef.current = true;
      patch({ recruiterThinking: true });
      try {
        let data: {
          directive: TurnDirective;
          final?: boolean;
          close?: CloseOutcome | null;
          authorization?: { token: string; action: "offer" | "accept"; package: CompPackage } | null;
        } | null = null;
        // One idempotency key for this utterance, reused by the retry: if the
        // first request timed out but still committed, the second returns the
        // stored answer instead of negotiating the same sentence twice.
        const turnId = newTurnId();
        // One retry: the relay must not die on a single dropped request — an
        // unbounded, unretried fetch is how the recruiter used to go deaf for
        // the rest of a call after one network blip.
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
          try {
            const res = await fetchWithTimeout(
              `/api/attempts/${argsRef.current.attemptId}/turn`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  user_text: text,
                  user_interrupted: interrupted,
                  turn_id: turnId,
                }),
              },
              TURN_FETCH_TIMEOUT_MS,
            );
            if (!res.ok) throw new Error(`turn ${res.status}`);
            data = (await res.json()) as {
              directive: TurnDirective;
              final?: boolean;
              close?: CloseOutcome | null;
              authorization?: { token: string; action: "offer" | "accept"; package: CompPackage } | null;
            };
          } catch (err) {
            if (attempt === 1) {
              console.error("[voice] engine turn failed after retry:", err);
            }
          }
        }
        const d = data?.directive;
        if (!d) {
          patch({ recruiterThinking: false }); // nothing is coming; unspin the UI
          return false; // engine unreachable — the pump re-queues the utterance
        }

        // The engine names a `close` only when the negotiation is genuinely
        // over — a worked-over deadlock, or a walk-away with no recovery left.
        // A mere `final` hold is just "that's my best" and never ends the call,
        // so the candidate can still accept or bring something new.
        pendingCloseRef.current = data?.close ?? null;
        // The server's proof that this turn authorized a recruiter action. The
        // tool call that follows presents it, so a browser cannot invent an
        // offer or an acceptance. A turn that authorizes nothing clears it.
        latestAuthRef.current = data?.authorization ?? null;

        const lines: string[] = [`SYSTEM DIRECTIVE (obey exactly): ${d.verdict}`];
        // The on-table package travels with every directive: the model restates
        // these exact components when the candidate questions the numbers,
        // instead of resurrecting its opening offer from memory.
        if (d.standingOfferLine) lines.push(d.standingOfferLine);
        if (d.allowedNumbers.length > 0) {
          lines.push(
            `ALLOWED NUMBERS this turn (you may say ONLY these, exactly as written): ${d.allowedNumbers.join(", ")}.`,
          );
        } else {
          lines.push("ALLOWED NUMBERS: none. Do not speak any dollar figures this turn.");
        }
        for (const m of d.mustSay) lines.push(`DO: ${m}`);
        for (const m of d.mustNotSay) lines.push(`DO NOT: ${m}`);
        if (d.conditions.length > 0) lines.push(`CONDITIONS to state: ${d.conditions.join("; ")}.`);
        if (d.askUserQuestion) lines.push(`ASK the candidate: "${d.askUserQuestion}"`);
        if (d.toolHint?.accept) {
          lines.push(
            `CALL accept_user_offer with exactly: ${JSON.stringify(d.toolHint.offer)}.`,
          );
        } else if (d.toolHint?.offer) {
          lines.push(
            `CALL offer_to_candidate with exactly: ${JSON.stringify(d.toolHint.offer)} and any conditions in notes.`,
          );
        }

        // Deliver now, or queue by turn id for the next time the session is
        // ready. Either way the turn is considered processed — the pump must not
        // re-run `/turn` because delivery was temporarily impossible.
        const directiveText = lines.join("\n");
        const delivered = send({
          type: "conversation.message",
          role: "system",
          content: directiveText,
        });
        if (!delivered) {
          directiveRelayRef.current.enqueue({ key: turnId, content: directiveText });
          persistDirectives();
        }
        return true;
      } finally {
        turnInFlightRef.current = false;
        // Drain whatever queued up while this turn was in flight — the recruiter
        // answers the latest thing the candidate said, and nothing is lost.
        pumpTurnQueueRef.current();
      }
    },
    [patch, persistDirectives, send],
  );

  // The pump dispatches through this ref so it can live above the dispatcher
  // without a circular dependency between the two callbacks.
  const dispatchTurnImplRef = useRef<(text: string, interrupted: boolean) => Promise<boolean>>(
    async () => false,
  );
  dispatchTurnImplRef.current = dispatchTurn;

  const flushPendingTools = useCallback(() => {
    const pending = pendingToolsRef.current;
    if (pending.length === 0) return;
    pendingToolsRef.current = [];
    for (const t of pending) {
      send({ type: "tool.result", call_id: t.call_id, result: t.result });
    }
  }, [send]);

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /** Clear both setup timers (called when ready lands or we tear down). */
  const clearSetupTimers = useCallback(() => {
    if (setupTimerRef.current) {
      window.clearTimeout(setupTimerRef.current);
      setupTimerRef.current = null;
    }
    if (greetingTimerRef.current) {
      window.clearTimeout(greetingTimerRef.current);
      greetingTimerRef.current = null;
    }
  }, []);

  /** Fail the call during setup: close the socket and surface a clear error. */
  const failSetup = useCallback(
    (message: string) => {
      setupFailRef.current = true;
      clearSetupTimers();
      const ws = wsRef.current;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      // onclose fires next; it keeps this message because setupFailRef is set.
      patch({ status: "error", error: message, agentSpeaking: false, userSpeaking: false });
    },
    [clearSetupTimers, patch],
  );

  /**
   * Single source of truth for mic → WS framing.
   *
   * This logic used to be duplicated at ws.onopen and session.ready, and the
   * onopen copy never stored the merged buffer, so the flush threshold was
   * never reached and NO audio was ever transmitted — the agent was deaf while
   * the call looked healthy. One callback keeps the copies from drifting.
   */
  const onMicChunk = useCallback(
    (pcm: Int16Array) => {
      audioStatsRef.current.chunks += 1;
      const merged = new Int16Array(micBufRef.current.length + pcm.length);
      merged.set(micBufRef.current);
      merged.set(pcm, micBufRef.current.length);
      micBufRef.current = merged;
      // Coalesce small worklet frames into ~170ms WS messages.
      if (micBufRef.current.length >= MicBufferSamples) {
        send({ type: "input.audio", audio: base64EncodePCM(micBufRef.current) });
        audioStatsRef.current.sent += 1;
        audioStatsRef.current.lastSentAt = Date.now();
        micBufRef.current = new Int16Array(0);
      }
    },
    [send],
  );

  /** Open the mic once (idempotent) and surface permission failures clearly. */
  const startMic = useCallback((): void => {
    if (micReadyRef.current || micStartingRef.current) return;
    micStartingRef.current = true;
    void mic
      .start({ onChunk: onMicChunk })
      .then(() => {
        micReadyRef.current = true;
      })
      .catch(() => {
        if (statusRef.current !== "ended") {
          failSetup(
            "Microphone access was blocked. Allow the mic in your browser's address-bar settings, then try again.",
          );
        }
      })
      .finally(() => {
        micStartingRef.current = false;
      });
  }, [failSetup, mic, onMicChunk]);

  /**
   * Tell the server which voice session this attempt is using.
   *
   * The attempt's session binding decides which transcript `/complete` scores, so
   * it is recorded explicitly rather than being whatever the next events batch
   * happens to carry. A reconnect that produces a new session id is authorized
   * by sending the previous one — the client has to prove it knows the binding it
   * is replacing.
   */
  const bindSessionId = useCallback((sessionId: string, previousSessionId: string | null) => {
    const attemptId = argsRef.current.attemptId;
    void fetch(`/api/attempts/${attemptId}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        previous_session_id: previousSessionId,
      }),
    }).catch(() => {
      // Non-fatal for the live call: the events flush carries the session id as
      // a fallback for the FIRST bind, and completion refuses a conflicting one.
    });
  }, []);

  const connectInner = useCallback(
    async (resumeSessionId: string | null) => {
      const a = argsRef.current;
      // Bounded token mint — a hung fetch must not strand the UI on "connecting".
      const tokenCtl = new AbortController();
      const tokenTimer = window.setTimeout(() => tokenCtl.abort(), SETUP_TIMEOUT_MS);
      let token: string;
      try {
        // The token is scoped to THIS attempt: the server verifies that the
        // caller owns it, that it is still active and that its agent mode is
        // actually servable before minting anything.
        const res = await fetch(`/api/token?attempt_id=${encodeURIComponent(a.attemptId)}`, {
          signal: tokenCtl.signal,
        });
        if (!res.ok) throw new Error(`Token request failed (${res.status})`);
        ({ token } = (await res.json()) as { token: string });
      } catch (err) {
        throw new Error(
          (err as Error).name === "AbortError"
            ? "Could not reach the server to start the call — check your connection and try again."
            : (err as Error).message,
        );
      } finally {
        window.clearTimeout(tokenTimer);
      }

      const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      // Whole-handshake guard: WS open + session.ready must land in time.
      setupTimerRef.current = window.setTimeout(() => {
        if (statusRef.current !== "ready" && statusRef.current !== "ended") {
          failSetup("The call didn't start in time — the voice service may be busy. Try again in a moment.");
        }
      }, SETUP_TIMEOUT_MS);

      ws.onopen = () => {
        // Pre-flight: ask for mic permission NOW, in parallel with the agent
        // handshake. First-time users grant while the session spins up instead
        // of hitting a second prompt after ready. A denial here fails fast with
        // a specific message rather than a deaf call.
        startMic();

        // A reconnect mid-call must not re-send the opening package as if the
        // negotiation had not happened, and a fresh start mid-call must not
        // re-greet the candidate with the original numbers.
        const midCall = Boolean(resumeSessionId) || stateRef.current.transcript.length > 0;
        const ctx = resumeContext(stateRef.current.currentOffer, midCall);

        if (resumeSessionId) {
          send({ type: "session.resume", session_id: resumeSessionId });
          // Re-attach the agent config after resume (some servers drop it).
          if (a.agentMode === "stored" && a.agentId) {
            send({ type: "session.update", session: { agent_id: a.agentId, output: { voice: "anna" } } });
          } else if (a.agentMode === "inline" && a.inlineConfig) {
            const payload = inlineSessionPayload(a.inlineConfig, {
              greetingOverride: null,
              resumeNote: ctx?.note,
            });
            expectSpeechRef.current = false;
            send({ type: "session.update", session: payload });
          }
        } else if (a.agentMode === "stored" && a.agentId) {
          send({ type: "session.update", session: { agent_id: a.agentId, output: { voice: "anna" } } });
        } else if (a.agentMode === "inline" && a.inlineConfig) {
          const payload = inlineSessionPayload(a.inlineConfig, {
            ...(ctx ? { greetingOverride: ctx.greeting, resumeNote: ctx.note } : {}),
          });
          expectSpeechRef.current = Boolean(payload.greeting);
          send({ type: "session.update", session: payload });
        } else {
          patch({ status: "error", error: "No agent configuration available" });
          ws.close();
        }
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        // Events from a socket we already replaced are stale — ignore them so a
        // dying connection's error can't fail the fresh one.
        if (ws !== wsRef.current) return;
        let event: VoiceAgentEvent;
        try {
          event = JSON.parse(ev.data) as VoiceAgentEvent;
        } catch {
          return;
        }
        handleEvent(event);
      };

      ws.onclose = (ev: CloseEvent) => {
        // We tore this socket down on purpose to restart a fresh session (or
        // it was already replaced) — don't report our own close as a failure.
        if (restartingRef.current || ws !== wsRef.current) return;
        if (closedCleanlyRef.current || endedByUsRef.current) {
          patch({ status: "ended" });
          return;
        }

        // AssemblyAI may close a session during greeting setup or policy checks.
        // Give a live call a brief, bounded chance to re-establish rather than
        // surfacing a raw close code to the user immediately.
        const canResume =
          !resumedOnceRef.current &&
          sessionIdRef.current &&
          startedAtRef.current &&
          Date.now() - startedAtRef.current < 15 * 60_000
          // 1008 = policy/payload close; retry once only if we never got ready,
          // since an established session that then closes 1008 is usually fatal.
          && (ev.code !== 1008 || statusRef.current !== "ready");
        if (canResume) {
          resumedOnceRef.current = true;
          patch({ status: "reconnecting" });
          window.setTimeout(() => {
            void connectInner(sessionIdRef.current).catch((err) => {
              patch({ status: "error", error: `Reconnect failed: ${(err as Error).message}` });
            });
          }, 1200);
          window.setTimeout(() => {
            if (
              wsRef.current?.readyState !== WebSocket.OPEN &&
              statusRef.current === "reconnecting"
            ) {
              patch({ status: "error", error: "Connection lost — resume window expired" });
            }
          }, RESUME_GRACE_MS);
        } else if (setupFailRef.current) {
          // failSetup() already surfaced a specific, actionable message — don't
          // clobber it with a generic close-code string.
          setupFailRef.current = false;
        } else {
          // If we never reached ready, the problem is almost certainly the
          // session setup (agent, greeting, or config) rather than the transport.
          const setupFailed =
            statusRef.current !== "ready" && statusRef.current !== "reconnecting";
          patch({
            status: "error",
            error:
              setupFailed && ev.code === 1008
                ? "The opponent couldn't start this call. It usually works on retry — try starting the call again."
                : `Connection closed (${ev.code})${ev.reason ? `: ${ev.reason}` : ""}`,
          });
        }
      };

      ws.onerror = () => {
        // onclose follows with details; surface nothing here.
        // Mark the attempt as a failed setup so the user sees a clear path.
        if (statusRef.current === "connecting" || statusRef.current === "reconnecting") {
          // Let onclose decide the final message.
        }
      };

      function handleEvent(event: VoiceAgentEvent) {
        lastEventRef.current = event.type;

        switch (event.type) {
          case "session.ready": {
            const previousSessionId = sessionIdRef.current;
            sessionIdRef.current = event.session_id;
            storageSet(sessionKey(argsRef.current.attemptId), event.session_id);
            clearSetupTimers();
            patch({ status: "ready", sessionId: event.session_id });
            // The start time belongs to the ATTEMPT (seeded from the server), so
            // reconnecting must not restart the elapsed clock or the
            // max-duration guard.
            startedAtRef.current = resolveAttemptStartedAt(
              argsRef.current.startedAtMs,
              startedAtRef.current,
            );
            bindSessionId(event.session_id, previousSessionId);
            // A directive produced while the socket was down is delivered now.
            flushDirectivesRef.current();
            // Mic capture was already started at ws.onopen (pre-flight). If
            // that start is still pending, startMic() is a no-op and the
            // original handler keeps streaming into this socket.
            startMic();
            // Greeting watchdog: if the recruiter never speaks (rejected
            // config, silent TTS failure), fail visibly instead of silence.
            greetingTimerRef.current = window.setTimeout(() => {
              if (statusRef.current !== "ready") return;
              // On a resumed call the recruiter is meant to stay quiet until the
              // candidate speaks, so silence is only a failure when a greeting
              // was expected (or on a call that never produced a single turn).
              const expectedSpeech =
                expectSpeechRef.current || stateRef.current.transcript.length === 0;
              if (expectedSpeech && !playback.hasReceivedAudio()) {
                failSetup(
                  "The opponent connected but never spoke. This usually clears on retry — try starting the call again.",
                );
              }
            }, GREETING_TIMEOUT_MS);
            break;
          }

          case "input.speech.started": {
            patch({ userSpeaking: true });
            break;
          }

          case "input.speech.stopped": {
            patch({ userSpeaking: false });
            break;
          }

          case "transcript.user.delta": {
            patch({ partialUser: event.text });
            break;
          }

          case "transcript.user": {
            // The same utterance can be finalised twice, which would append a
            // phantom turn AND run the engine a second time for one sentence.
            const userSig = transcriptSignature(event.text);
            const prevUser = lastUserTurnRef.current;
            if (prevUser && prevUser.sig === userSig && Date.now() - prevUser.at < USER_DUPLICATE_MS) {
              break;
            }
            lastUserTurnRef.current = { sig: userSig, at: Date.now() };
            const turn: TranscriptTurn = {
              role: "user",
              text: event.text,
              interrupted: false,
              atMs: elapsedMs(),
            };
            setState((s) => ({
              ...s,
              partialUser: null,
              transcript: [...s.transcript, turn],
            }));

            // They are still talking, so they are still negotiating: any
            // pending hang-up is off the table the moment a new utterance
            // lands. If what they said is abusive it is re-decided below.
            cancelPendingCloseRef.current();

            // Hostile language is not a negotiation move, so it never reaches
            // the engine. The recruiter warns once; a second offence ends the
            // call.
            if (detectHostileLanguage(event.text)) {
              if (abuseWarnedRef.current) {
                closeCallRef.current("abuse");
              } else {
                abuseWarnedRef.current = true;
                patch({ abuseWarning: true });
                send({
                  type: "conversation.message",
                  role: "system",
                  content:
                    "The candidate just insulted you. Stay calm and professional: tell them briefly that you are glad to keep working on the numbers, but you will end the call if that language continues. Do not answer the insult, do not apologise, and do not move any figure this turn.",
                });
              }
              break;
            }

            pendingTurnsRef.current.push({ text: event.text, interrupted: false, attempts: 0 });
            // Deliver the engine directive NOW instead of waiting for the
            // recruiter's reply to finish — the reply is generated moments after
            // this event, so waiting meant every directive arrived a turn late.
            // While the recruiter is mid-utterance (barge-in) the utterance stays
            // queued: reply.done, dispatch completion, or the watchdog delivers
            // it — one of them ALWAYS will, which is the point of the queue.
            if (!agentSpeakingRef.current) {
              pumpTurnQueueRef.current();
            }
            break;
          }

          case "reply.started": {
            agentSpeakingAtRef.current = Date.now(); // watchdog baseline
            patch({ agentSpeaking: true, recruiterThinking: false });
            break;
          }

          case "reply.audio": {
            playback.play(event.data);
            break;
          }

          case "transcript.agent": {
            // A duplicated finalisation is dropped here, before it can be shown
            // twice or re-parsed as a fresh offer — that pair of effects is what
            // made the recruiter look like it was repeating itself and changing
            // numbers it had already given.
            const agentSig = transcriptSignature(event.text);
            const prevAgent = lastAgentTurnRef.current;
            if (
              prevAgent &&
              prevAgent.sig === agentSig &&
              Date.now() - prevAgent.at < AGENT_DUPLICATE_MS
            ) {
              break;
            }
            lastAgentTurnRef.current = { sig: agentSig, at: Date.now() };
            const turn: TranscriptTurn = {
              role: "agent",
              text: event.text,
              interrupted: event.interrupted,
              atMs: elapsedMs(),
            };
            setState((s) => ({ ...s, transcript: [...s.transcript, turn] }));
            // What the recruiter says is authoritative for the offer panel, and
            // a promise to "check with the team" needs surfacing.
            void reconcileSpokenOffer(event.text, elapsedMs());
            if (event.interrupted) {
              patch({ justInterrupted: true });
              queueEvent({
                type: "interruption",
                actor: "user",
                source: "tool",
                payload: { note: "user barged in while the recruiter was speaking" },
                at_ms: elapsedMs(),
              });
            }
            break;
          }

          case "reply.done": {
            agentSpeakingAtRef.current = 0;
            patch({ agentSpeaking: false, recruiterThinking: false });
            if (event.status === "interrupted") {
              playback.flush();
              pendingToolsRef.current = []; // agent moved on; drop stale results
            } else {
              flushPendingTools();
              // A finished reply is the proof the close waiter waits for. Arm
              // first (capturing the sequence), then record the reply, so the
              // waiter immediately knows the closing line has been delivered.
              if (pendingCloseRef.current) closeCallRef.current(pendingCloseRef.current);
              replyDoneSeqRef.current += 1;
            }
            // Whatever the user said while the recruiter spoke gets its turn
            // now — and if a turn was somehow stuck, this unjams it.
            pumpTurnQueueRef.current();
            break;
          }

          case "tool.call": {
            const result = runTool(event.name, event.arguments);
            pendingToolsRef.current.push({ call_id: event.call_id, result });
            // reply.done may already be the latest event — flush now if idle.
            if (lastEventRef.current === "reply.done") flushPendingTools();
            break;
          }

          case "session.ended": {
            closedCleanlyRef.current = true;
            patch({ agentSpeaking: false, userSpeaking: false });
            break;
          }

          case "session.error": {
            // A resumed session that no longer exists can never be salvaged —
            // its grace window is gone. Restart a fresh call once rather than
            // dead-ending the user on a raw protocol error.
            if (
              event.code === "session_not_found" &&
              !freshRetriedRef.current &&
              !endedByUsRef.current
            ) {
              freshRetriedRef.current = true;
              resumedOnceRef.current = true; // never resume this dead session again
              restartingRef.current = true;
              clearSetupTimers();
              const dead = wsRef.current;
              if (dead && dead.readyState <= WebSocket.OPEN) {
                try {
                  dead.close();
                } catch {
                  // ignore
                }
              }
              patch({ status: "reconnecting", error: null });
              window.setTimeout(() => {
                void connectInner(null)
                  .catch((err) => {
                    patch({ status: "error", error: (err as Error).message });
                  })
                  .finally(() => {
                    restartingRef.current = false;
                  });
              }, 300);
              break;
            }
            const fatal = !["at_capacity", "concurrency_exceeded", "internal_error"].includes(
              event.code,
            );
            if (fatal) {
              // Close the socket so the user isn't stranded behind a zombie
              // connection after a fatal config/policy error.
              failSetup(`${event.code}: ${event.message}`);
            }
            break;
          }
        }
      }
    },
    [
      bindSessionId,
      clearSetupTimers,
      flushPendingTools,
      patch,
      playback,
      queueEvent,
      reconcileSpokenOffer,
      runTool,
      send,
      startMic,
    ],
  );

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  const connect = useCallback(async () => {
    if (connectingRef.current) return; // StrictMode double-mount guard
    connectingRef.current = true;
    // Fresh attempt: reset per-connection failure tracking and audio state.
    setupFailRef.current = false;
    micReadyRef.current = false;
    micStartingRef.current = false;
    freshRetriedRef.current = false;
    restartingRef.current = false;
    resumedOnceRef.current = false;
    closedCleanlyRef.current = false;
    endedByUsRef.current = false;
    audioStatsRef.current = { chunks: 0, sent: 0, lastSentAt: 0 };
    audioWarnRef.current = null;
    audioFlowRef.current = false;
    deferralRef.current = false;
    pendingTurnsRef.current = []; // a fresh call starts with a clean relay
    agentSpeakingAtRef.current = 0;
    turnInFlightRef.current = false;
    pendingCloseRef.current = null;
    closingRef.current = false;
    acceptCloseRef.current = false;
    abuseWarnedRef.current = false;
    replyDoneSeqRef.current = 0;
    stopClosePoll();
    patch({
      status: "connecting",
      error: null,
      audioWarning: null,
      audioFlowing: false,
      deferral: null,
      offerNotice: null,
      dealClosed: null,
      abuseWarning: false,
    });
    try {
      await connectInner(null);
    } catch (err) {
      patch({ status: "error", error: (err as Error).message });
    } finally {
      connectingRef.current = false;
    }
  }, [connectInner, patch, stopClosePoll]);

  const end = useCallback(() => {
    endedByUsRef.current = true;
    clearSetupTimers();
    send({ type: "session.end" }); // stops billing immediately (vs 30s grace)
    micBufRef.current = new Int16Array(0);
    micReadyRef.current = false;
    mic.stop();
    playback.flush();
    void flushEvents();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      window.setTimeout(() => ws.close(), 500);
    }
    // The call is over: the session must not be resumed by a later reload.
    storageSet(sessionKey(argsRef.current.attemptId), null);
    storageSet(directiveKey(argsRef.current.attemptId), null);
    directiveRelayRef.current.clear();
    deferralRef.current = false;
    pendingTurnsRef.current = []; // nothing queued may survive the call
    agentSpeakingAtRef.current = 0;
    turnInFlightRef.current = false;
    pendingCloseRef.current = null;
    closingRef.current = false;
    acceptCloseRef.current = false;
    stopClosePoll();
    patch({
      status: "ended",
      agentSpeaking: false,
      userSpeaking: false,
      audioFlowing: false,
      audioWarning: null,
      deferral: null,
      offerNotice: null,
    });
  }, [flushEvents, mic, patch, playback, send, stopClosePoll]);

  // The websocket handlers reach the hang-up through this ref so the close path
  // does not depend on callback definition order (same trick as the turn pump).
  endRef.current = end;

  /**
   * Replace the live socket with a brand-new session on the same attempt.
   * Used when the call is healthy-looking but broken (e.g. the mic is
   * transmitting nothing): rebuilding the AudioContext and the session is the
   * reliable fix, and the transcript collected so far is preserved.
   */
  const restart = useCallback(() => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    clearSetupTimers();
    mic.stop(); // force a fresh AudioContext + stream on reconnect
    micReadyRef.current = false;
    micStartingRef.current = false;
    micBufRef.current = new Int16Array(0);
    audioStatsRef.current = { chunks: 0, sent: 0, lastSentAt: 0 };
    audioWarnRef.current = null;
    audioFlowRef.current = false;
    playback.flush();
    const old = wsRef.current;
    if (old && old.readyState <= WebSocket.OPEN) {
      try {
        old.close();
      } catch {
        // ignore
      }
    }
    patch({
      status: "connecting",
      error: null,
      audioWarning: null,
      audioFlowing: false,
      agentSpeaking: false,
      userSpeaking: false,
      justInterrupted: false,
      recruiterThinking: false,
      dealClosed: null,
      abuseWarning: false,
    });
    pendingTurnsRef.current = []; // restart = fresh relay
    agentSpeakingAtRef.current = 0;
    turnInFlightRef.current = false;
    pendingCloseRef.current = null;
    closingRef.current = false;
    acceptCloseRef.current = false;
    abuseWarnedRef.current = false;
    replyDoneSeqRef.current = 0;
    stopClosePoll();
    window.setTimeout(() => {
      void connectInner(null)
        .catch((err) => {
          patch({ status: "error", error: (err as Error).message });
        })
        .finally(() => {
          restartingRef.current = false;
        });
    }, 300);
  }, [clearSetupTimers, connectInner, mic, patch, playback, stopClosePoll]);

  // Elapsed timer.
  useEffect(() => {
    if (state.status !== "ready") return;
    const t = window.setInterval(() => {
      if (startedAtRef.current) {
        patch({ elapsedSec: Math.floor((Date.now() - startedAtRef.current) / 1000) });
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [state.status, patch]);

  // Max-duration guard: the server sends no warning before session_expired.
  useEffect(() => {
    if (state.elapsedSec >= MAX_SESSION_SEC && state.status === "ready") {
      end();
    }
  }, [state.elapsedSec, state.status, end]);

  // Mirror the transcript so a reload mid-call does not lose the conversation.
  useEffect(() => {
    storageSet(
      transcriptKey(args.attemptId),
      JSON.stringify(state.transcript.slice(-MAX_PERSISTED_TURNS)),
    );
  }, [args.attemptId, state.transcript]);

  // The socket is rebuilt from scratch on restart, so the old session id is
  // stale by the time the new one is ready.
  useEffect(() => {
    if (state.status === "connecting" && restartingRef.current) {
      storageSet(sessionKey(args.attemptId), null);
    }
  }, [args.attemptId, state.status]);

  // Periodic event flush.
  useEffect(() => {
    if (state.status !== "ready" && state.status !== "reconnecting") return;
    const t = window.setInterval(() => void flushEvents(), 5000);
    return () => window.clearInterval(t);
  }, [state.status, flushEvents]);

  /**
   * Turn-relay watchdog.
   *
   * The old relay died silently whenever one expected event never arrived —
   * a missed reply.done, a hung fetch — and the recruiter simply stopped
   * responding for whole turns. This sweeper makes the system converge no
   * matter what gets lost: every 1.5s it delivers any utterance the engine has
   * not yet seen, and it reaps a reply that never ended (stuck
   * agentSpeaking), so a lost websocket message costs one delayed turn instead
   * of the rest of the call.
   */
  useEffect(() => {
    if (state.status !== "ready") return;
    const t = window.setInterval(() => {
      pumpTurnQueueRef.current();
      if (
        agentSpeakingAtRef.current > 0 &&
        Date.now() - agentSpeakingAtRef.current > AGENT_SPEAKING_TIMEOUT_MS
      ) {
        agentSpeakingAtRef.current = 0;
        patch({ agentSpeaking: false, recruiterThinking: false });
        pumpTurnQueueRef.current();
      }
    }, TURN_WATCHDOG_MS);
    return () => window.clearInterval(t);
  }, [state.status, patch]);

  // Clear the interrupted flag when the user speaks again.
  useEffect(() => {
    if (state.userSpeaking && state.justInterrupted) {
      patch({ justInterrupted: false });
    }
  }, [state.userSpeaking, state.justInterrupted, patch]);

  /**
   * Audio-flow self-check.
   *
   * A connection that is perfectly healthy but carries no microphone audio is
   * indistinguishable from a working call, so "ready" alone proves nothing.
   * This watches the frames that actually left the browser and tells the user
   * the moment the agent is deaf, with a one-click rebuild.
   */
  useEffect(() => {
    if (state.status !== "ready") return;
    const t = window.setInterval(() => {
      const now = Date.now();
      // Browsers throttle audio worklets in hidden tabs — don't cry wolf.
      if (document.visibilityState !== "visible") {
        hiddenSkipRef.current = true;
        return;
      }
      if (hiddenSkipRef.current) {
        // Back from a hidden tab: re-baseline so capture can restart before we
        // count the missed time against the user.
        hiddenSkipRef.current = false;
        audioStatsRef.current.lastSentAt = now;
        return;
      }
      const s = audioStatsRef.current;
      const flowing = now - s.lastSentAt < AUDIO_FLOWING_MS;
      const silentFor = now - (s.lastSentAt || startedAtRef.current || now);

      let warning: string | null = null;
      if (!flowing && silentFor > AUDIO_SILENCE_MS) {
        if (s.chunks === 0) {
          warning =
            "Your microphone isn't sending any audio. Check that it isn't muted and that the right input device is selected, then restart the call.";
        } else if (s.sent === 0) {
          warning =
            "Your microphone is capturing audio but none of it is reaching the call. Restarting the call usually fixes this.";
        } else {
          warning =
            "Microphone audio stopped a few seconds ago — the device may have been disconnected, or your browser paused capture. Restarting the call usually reconnects it.";
        }
      }

      // Only touch state on a real change: this runs every second.
      if (warning === audioWarnRef.current && flowing === audioFlowRef.current) return;
      audioWarnRef.current = warning;
      audioFlowRef.current = flowing;
      patch({ audioWarning: warning, audioFlowing: flowing });
    }, 1000);
    return () => window.clearInterval(t);
  }, [state.status, patch]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopClosePoll();
      clearSetupTimers();
      mic.stop();
      playback.close();
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          send({ type: "session.end" });
        } catch {
          // ignore
        }
        ws.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, connect, end, restart, flushEvents };
}