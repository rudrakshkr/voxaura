"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useMicCapture } from "./useMicCapture";
import { usePcmPlayback } from "./usePcmPlayback";
import {
  base64EncodePCM,
  type ClientMsg,
  type VoiceAgentEvent,
} from "@/lib/voice/protocol";
import type { BatchedEvent, CompPackage, TranscriptTurn } from "@/lib/types";
import {
  extractSpokenPackage,
  transcriptSignature,
  type TurnDirective,
} from "@/lib/negotiation-engine";

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
}

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
const SETUP_TIMEOUT_MS = 15_000; // token + WS + session.ready must land within this
const MIC_READY_TIMEOUT_MS = 10_000; // first-time mic permission can be slow, not infinite
const GREETING_TIMEOUT_MS = 12_000; // ready but no recruiter audio => setup is wedged

export function useVoiceAgent(args: {
  attemptId: string;
  agentId: string | null;
  agentMode: "stored" | "inline";
  inlineConfig?: InlineAgentConfig | null;
  /** Server-derived standing package, so the panel is never empty at call start. */
  initialOffer?: CompPackage | null;
}) {
  const [state, setState] = useState<VoiceAgentState>({
    status: "idle",
    error: null,
    sessionId: null,
    transcript: [],
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
  });

  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<AgentStatus>("idle");
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
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

  // Turn relay: last user utterance queued until its agent reply completes.
  const pendingTurnRef = useRef<{ text: string; interrupted: boolean } | null>(null);
  const turnInFlightRef = useRef(false);

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

  const queueEvent = useCallback((e: BatchedEvent) => {
    eventQueueRef.current.push(e);
    if (eventQueueRef.current.length >= 10) {
      void flushEvents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushEvents = useCallback(async () => {
    const events = eventQueueRef.current;
    if (events.length === 0) return;
    eventQueueRef.current = [];
    try {
      await fetch(`/api/attempts/${argsRef.current.attemptId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionIdRef.current, events }),
      });
    } catch {
      // Non-fatal: the scorer re-extracts events from the transcript.
      eventQueueRef.current.unshift(...events);
    }
  }, []);

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
      input: { agentText?: string; pkg?: CompPackage; conditions?: string[] | null },
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
            at_ms: atMs,
          }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          offer: CompPackage;
          changed: boolean;
          adjusted: boolean;
          notice: string | null;
          conditions: string[] | null;
          deferral?: { outstanding: boolean; deferredNow: boolean; quote: string | null };
        };

        // The panel is already showing what the recruiter said (it was set the
        // moment the words arrived); the server response only confirms what the
        // engine state now holds, so later FACT lines quote the same figures.
        if (data.changed && data.offer) {
          setOffer(data.offer, data.conditions?.length ? data.conditions : undefined);
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
        void reconcileOffer({ pkg: offer, conditions }, elapsedMs());
        queueEvent({
          type: "opponent_offer",
          actor: "opponent",
          source: "tool",
          payload: { package: offer, note: args.notes ?? null },
          at_ms: elapsedMs(),
        });
        return JSON.stringify({ delivered: true });
      }

      if (name === "accept_user_offer") {
        const offer: CompPackage = {
          base: num(args.final_base) ?? 0,
          sign_on: num(args.sign_on),
          equity: num(args.equity),
        };
        // Same mirror rule: the accepted package is exactly what the recruiter
        // accepted out loud — shown instantly, persisted by the server.
        setOffer(offer);
        void reconcileOffer({ pkg: offer }, elapsedMs()).then((res) => {
          patch({ acceptedOffer: res?.offer ?? offer });
        });
        queueEvent({
          type: "commitment_signal",
          actor: "opponent",
          source: "tool",
          payload: { package: offer, note: "recruiter accepted the candidate's package" },
          at_ms: elapsedMs(),
        });
        return JSON.stringify({ accepted: true });
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

  const send = useCallback((msg: ClientMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Turn relay: user utterance → server engine → directive → agent
  // ---------------------------------------------------------------------------

  const dispatchTurn = useCallback(
    async (text: string, interrupted: boolean) => {
      if (turnInFlightRef.current) return;
      turnInFlightRef.current = true;
      patch({ recruiterThinking: true });
      try {
        const res = await fetch(`/api/attempts/${argsRef.current.attemptId}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_text: text, user_interrupted: interrupted }),
        });
        if (!res.ok) return; // engine hiccup must never break the live call
        const data = (await res.json()) as { directive: TurnDirective };
        const d = data.directive;
        if (!d) return;

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

        send({ type: "conversation.message", role: "system", content: lines.join("\n") });
      } finally {
        turnInFlightRef.current = false;
      }
    },
    [patch, send],
  );

  const maybeDispatchPendingTurn = useCallback(() => {
    const pending = pendingTurnRef.current;
    if (pending && !turnInFlightRef.current) {
      pendingTurnRef.current = null;
      void dispatchTurn(pending.text, pending.interrupted);
    }
  }, [dispatchTurn]);

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

  const connectInner = useCallback(
    async (resumeSessionId: string | null) => {
      const a = argsRef.current;
      // Bounded token mint — a hung fetch must not strand the UI on "connecting".
      const tokenCtl = new AbortController();
      const tokenTimer = window.setTimeout(() => tokenCtl.abort(), SETUP_TIMEOUT_MS);
      let token: string;
      try {
        const res = await fetch("/api/token", { signal: tokenCtl.signal });
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
            sessionIdRef.current = event.session_id;
            clearSetupTimers();
            patch({ status: "ready", sessionId: event.session_id });
            startedAtRef.current = Date.now();
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
            pendingTurnRef.current = { text: event.text, interrupted: false };
            // Deliver the engine directive NOW instead of waiting for the
            // recruiter's reply to finish. The reply is generated moments after
            // this event, so the old ordering meant every directive arrived a
            // turn late — the model was left to improvise its own numbers and
            // concessions in between. If the recruiter is already mid-utterance
            // (barge-in) we must not inject into it: that path keeps the
            // reply.done fallback below.
            if (!agentSpeakingRef.current && !turnInFlightRef.current) {
              const pending = pendingTurnRef.current;
              pendingTurnRef.current = null;
              void dispatchTurn(pending.text, pending.interrupted);
            }
            break;
          }

          case "reply.started": {
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
            patch({ agentSpeaking: false, recruiterThinking: false });
            if (event.status === "interrupted") {
              playback.flush();
              pendingToolsRef.current = []; // agent moved on; drop stale results
            } else {
              flushPendingTools();
              // User's turn just completed → run the negotiation engine now.
              maybeDispatchPendingTurn();
            }
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
      clearSetupTimers,
      dispatchTurn,
      flushPendingTools,
      maybeDispatchPendingTurn,
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
    patch({
      status: "connecting",
      error: null,
      audioWarning: null,
      audioFlowing: false,
      deferral: null,
      offerNotice: null,
    });
    try {
      await connectInner(null);
    } catch (err) {
      patch({ status: "error", error: (err as Error).message });
    } finally {
      connectingRef.current = false;
    }
  }, [connectInner, patch]);

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
    deferralRef.current = false;
    patch({
      status: "ended",
      agentSpeaking: false,
      userSpeaking: false,
      audioFlowing: false,
      audioWarning: null,
      deferral: null,
      offerNotice: null,
    });
  }, [flushEvents, mic, patch, playback, send]);

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
    });
    window.setTimeout(() => {
      void connectInner(null)
        .catch((err) => {
          patch({ status: "error", error: (err as Error).message });
        })
        .finally(() => {
          restartingRef.current = false;
        });
    }, 300);
  }, [clearSetupTimers, connectInner, mic, patch, playback]);

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

  // Periodic event flush.
  useEffect(() => {
    if (state.status !== "ready" && state.status !== "reconnecting") return;
    const t = window.setInterval(() => void flushEvents(), 5000);
    return () => window.clearInterval(t);
  }, [state.status, flushEvents]);

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
