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
import type { TurnDirective } from "@/lib/negotiation-engine";

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
  acceptedOffer: CompPackage | null;
  offerConditions: string[];
  elapsedSec: number;
}

export interface InlineAgentConfig {
  systemPrompt: string;
  greeting: string;
}

/**
 * The `session.update` body for inline (non-stored) agents. One builder so the
 * initial handshake and a post-resume re-attach can never drift apart.
 * The greeting is skipped when re-attaching: it already played once.
 */
function inlineSessionPayload(cfg: InlineAgentConfig, opts?: { includeGreeting?: boolean }) {
  return {
    system_prompt: cfg.systemPrompt,
    ...(opts?.includeGreeting === false ? {} : { greeting: cfg.greeting }),
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

const MAX_SESSION_SEC = 10 * 60; // client-side guard; server TTL gives no warning
const MicBufferSamples = 4096; // ~170ms at 24 kHz per WS message
const RESUME_GRACE_MS = 25_000; // server holds sessions for 30s after drop
const SETUP_TIMEOUT_MS = 15_000; // token + WS + session.ready must land within this
const MIC_READY_TIMEOUT_MS = 10_000; // first-time mic permission can be slow, not infinite
const GREETING_TIMEOUT_MS = 12_000; // ready but no recruiter audio => setup is wedged

export function useVoiceAgent(args: {
  attemptId: string;
  agentId: string | null;
  agentMode: "stored" | "inline";
  inlineConfig?: InlineAgentConfig | null;
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
    currentOffer: null,
    acceptedOffer: null,
    offerConditions: [],
    elapsedSec: 0,
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

  // Event batch queue for the attempts API.
  const eventQueueRef = useRef<BatchedEvent[]>([]);

  // Turn relay: last user utterance queued until its agent reply completes.
  const pendingTurnRef = useRef<{ text: string; interrupted: boolean } | null>(null);
  const turnInFlightRef = useRef(false);

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
  // Live mirror of state for reads inside timers/event handlers without
  // stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  const patch = useCallback((p: Partial<VoiceAgentState>) => {
    if (p.status) statusRef.current = p.status;
    setState((s) => ({ ...s, ...p }));
  }, []);

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
        patch({ currentOffer: offer, offerConditions: conditions });
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
        patch({ acceptedOffer: offer });
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
    [patch, queueEvent],
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
      const merged = new Int16Array(micBufRef.current.length + pcm.length);
      merged.set(micBufRef.current);
      merged.set(pcm, micBufRef.current.length);
      micBufRef.current = merged;
      // Coalesce small worklet frames into ~170ms WS messages.
      if (micBufRef.current.length >= MicBufferSamples) {
        send({ type: "input.audio", audio: base64EncodePCM(micBufRef.current) });
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

        if (resumeSessionId) {
          send({ type: "session.resume", session_id: resumeSessionId });
          // Re-attach the agent config after resume (some servers drop it).
          if (a.agentMode === "stored" && a.agentId) {
            send({ type: "session.update", session: { agent_id: a.agentId, output: { voice: "anna" } } });
          } else if (a.agentMode === "inline" && a.inlineConfig) {
            send({
              type: "session.update",
              session: inlineSessionPayload(a.inlineConfig, { includeGreeting: false }),
            });
          }
        } else if (a.agentMode === "stored" && a.agentId) {
          send({ type: "session.update", session: { agent_id: a.agentId, output: { voice: "anna" } } });
        } else if (a.agentMode === "inline" && a.inlineConfig) {
          send({ type: "session.update", session: inlineSessionPayload(a.inlineConfig) });
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
              if (
                !playback.hasReceivedAudio() &&
                stateRef.current.transcript.length === 0
              ) {
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
            // Queue for the engine; dispatched when the recruiter's reply ends.
            pendingTurnRef.current = { text: event.text, interrupted: false };
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
            const turn: TranscriptTurn = {
              role: "agent",
              text: event.text,
              interrupted: event.interrupted,
              atMs: elapsedMs(),
            };
            setState((s) => ({ ...s, transcript: [...s.transcript, turn] }));
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
      flushPendingTools,
      maybeDispatchPendingTurn,
      patch,
      playback,
      queueEvent,
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
    patch({ status: "connecting", error: null });
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
    patch({ status: "ended", agentSpeaking: false, userSpeaking: false });
  }, [flushEvents, mic, patch, playback, send]);

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

  return { state, connect, end, flushEvents };
}
