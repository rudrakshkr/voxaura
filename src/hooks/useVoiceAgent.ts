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
  currentOffer: CompPackage | null;
  acceptedOffer: CompPackage | null;
  elapsedSec: number;
}

export interface InlineAgentConfig {
  systemPrompt: string;
  greeting: string;
}

const MAX_SESSION_SEC = 10 * 60; // client-side guard; server TTL gives no warning
const MicBufferSamples = 4096; // ~170ms at 24 kHz per WS message
const RESUME_GRACE_MS = 25_000; // server holds sessions for 30s after drop

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
    currentOffer: null,
    acceptedOffer: null,
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

  const mic = useMicCapture();
  const playback = usePcmPlayback();
  const argsRef = useRef(args);
  argsRef.current = args;

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
        patch({ currentOffer: offer });
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

  const connectInner = useCallback(
    async (resumeSessionId: string | null) => {
      const a = argsRef.current;
      const res = await fetch("/api/token");
      if (!res.ok) throw new Error(`Token mint failed (${res.status})`);
      const { token } = (await res.json()) as { token: string };

      const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (resumeSessionId) {
          send({ type: "session.resume", session_id: resumeSessionId });
        } else if (a.agentMode === "stored" && a.agentId) {
          send({ type: "session.update", session: { agent_id: a.agentId } });
        } else if (a.agentMode === "inline" && a.inlineConfig) {
          send({
            type: "session.update",
            session: {
              system_prompt: a.inlineConfig.systemPrompt,
              greeting: a.inlineConfig.greeting,
              output: { voice: "anna" },
            },
          });
        } else {
          patch({ status: "error", error: "No agent configuration available" });
          ws.close();
        }
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        let event: VoiceAgentEvent;
        try {
          event = JSON.parse(ev.data) as VoiceAgentEvent;
        } catch {
          return;
        }
        handleEvent(event);
      };

      ws.onclose = (ev: CloseEvent) => {
        if (closedCleanlyRef.current || endedByUsRef.current) {
          patch({ status: "ended" });
          return;
        }
        // Abnormal close: one resume attempt within the 30s server grace window.
        const canResume =
          !resumedOnceRef.current &&
          sessionIdRef.current &&
          startedAtRef.current &&
          Date.now() - startedAtRef.current < 15 * 60_000 &&
          ev.code !== 1008;
        if (canResume) {
          resumedOnceRef.current = true;
          patch({ status: "reconnecting" });
          window.setTimeout(() => {
            void connectInner(sessionIdRef.current).catch((err) => {
              patch({ status: "error", error: `Reconnect failed: ${(err as Error).message}` });
            });
          }, 1200);
          // Give up if the grace window lapses.
          window.setTimeout(() => {
            if (
              wsRef.current?.readyState !== WebSocket.OPEN &&
              statusRef.current === "reconnecting"
            ) {
              patch({ status: "error", error: "Connection lost — resume window expired" });
            }
          }, RESUME_GRACE_MS);
        } else {
          patch({
            status: "error",
            error: `Connection closed (${ev.code})${ev.reason ? `: ${ev.reason}` : ""}`,
          });
        }
      };

      ws.onerror = () => {
        // onclose follows with details; surface nothing here.
      };

      function handleEvent(event: VoiceAgentEvent) {
        lastEventRef.current = event.type;

        switch (event.type) {
          case "session.ready": {
            sessionIdRef.current = event.session_id;
            patch({ status: "ready", sessionId: event.session_id });
            startedAtRef.current = Date.now();
            void mic.start({
              onChunk: (pcm) => {
                // Coalesce small worklet frames into ~170ms WS messages.
                const merged = new Int16Array(micBufRef.current.length + pcm.length);
                merged.set(micBufRef.current);
                merged.set(pcm, micBufRef.current.length);
                micBufRef.current = merged;
                if (micBufRef.current.length >= MicBufferSamples) {
                  send({ type: "input.audio", audio: base64EncodePCM(micBufRef.current) });
                  micBufRef.current = new Int16Array(0);
                }
              },
            });
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
            break;
          }

          case "reply.started": {
            patch({ agentSpeaking: true });
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
            patch({ agentSpeaking: false });
            if (event.status === "interrupted") {
              playback.flush();
              pendingToolsRef.current = []; // agent moved on; drop stale results
            } else {
              flushPendingTools();
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
            const fatal = !["at_capacity", "concurrency_exceeded", "internal_error"].includes(
              event.code,
            );
            if (fatal) {
              patch({ status: "error", error: `${event.code}: ${event.message}` });
            }
            break;
          }
        }
      }
    },
    [flushPendingTools, mic, patch, playback, queueEvent, runTool, send],
  );

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  const connect = useCallback(async () => {
    if (connectingRef.current) return; // StrictMode double-mount guard
    connectingRef.current = true;
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
    send({ type: "session.end" }); // stops billing immediately (vs 30s grace)
    micBufRef.current = new Int16Array(0);
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

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
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
