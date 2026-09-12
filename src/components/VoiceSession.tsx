"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { OfferMeter } from "./OfferMeter";
import { TranscriptView } from "./TranscriptView";
import { fmtTime, Spinner, StatusPill } from "./ui";
import { useVoiceAgent } from "@/hooks/useVoiceAgent";
import type { ScenarioPublic } from "@/lib/types";

interface Props {
  attemptId: string;
  agentId: string | null;
  agentMode: "stored" | "inline";
  scenario: ScenarioPublic;
  retryMode: string | null;
}

export function VoiceSession(props: Props) {
  const router = useRouter();
  const { state, connect, end } = useVoiceAgent({
    attemptId: props.attemptId,
    agentId: props.agentId,
    agentMode: props.agentMode,
  });
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const completingRef = useRef(false);

  const complete = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    setCompleteError(null);
    try {
      const res = await fetch(`/api/attempts/${props.attemptId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: state.transcript.map((t) => ({
            role: t.role,
            text: t.text,
            interrupted: t.interrupted,
            at_ms: t.atMs,
          })),
          outcome: state.acceptedOffer ? "accepted" : state.currentOffer ? "stalemate" : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Complete failed (${res.status})`);
      }
      router.push(`/report/${props.attemptId}`);
    } catch (err) {
      setCompleteError((err as Error).message);
      setCompleting(false);
    } finally {
      completingRef.current = false;
    }
  }, [props.attemptId, router, state.acceptedOffer, state.currentOffer, state.transcript]);

  // Auto-complete shortly after the recruiter accepts the candidate's offer.
  const accepted = state.acceptedOffer != null;
  useEffect(() => {
    if (!accepted) return;
    const t = window.setTimeout(() => {
      end();
      void complete();
    }, 4000);
    return () => window.clearTimeout(t);
  }, [accepted, complete, end]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-white/50">
            {props.scenario.company} · {props.scenario.role}
            {props.retryMode ? ` · retry (${props.retryMode})` : ""}
          </p>
          <h1 className="text-2xl font-bold">{props.scenario.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg">{fmtTime(state.elapsedSec)}</span>
          <StatusPill status={state.status} />
        </div>
      </div>

      {state.error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {state.error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <TranscriptView
            transcript={state.transcript}
            partialUser={state.partialUser}
            agentSpeaking={state.agentSpeaking}
          />
          {state.userSpeaking && <p className="text-sm text-violet-300">Listening…</p>}
        </div>

        <div className="space-y-4">
          <OfferMeter currentOffer={state.currentOffer} acceptedOffer={state.acceptedOffer} />

          <div className="card space-y-3">
            {state.status === "idle" && (
              <>
                <p className="text-sm text-white/60">
                  Headphones recommended. When you connect, your mic opens and the recruiter will
                  greet you.
                </p>
                <button className="btn btn-primary w-full" onClick={() => void connect()}>
                  Connect &amp; start call
                </button>
              </>
            )}

            {(state.status === "connecting" || state.status === "reconnecting") && (
              <div className="flex items-center gap-2 text-sm text-white/60">
                <Spinner /> Setting up the call…
              </div>
            )}

            {state.status === "ready" && (
              <button
                className="btn btn-danger w-full"
                onClick={() => {
                  end();
                  void complete();
                }}
              >
                End call &amp; get score
              </button>
            )}

            {(state.status === "ended" || state.status === "error") && !completing && (
              <div className="space-y-2">
                <button className="btn btn-primary w-full" onClick={() => void complete()}>
                  Score this attempt
                </button>
                <p className="text-xs text-white/40">
                  The call ended. Scoring runs the full transcript through the coach model.
                </p>
              </div>
            )}

            {completing && (
              <div className="flex items-center gap-2 text-sm text-white/60">
                <Spinner /> Scoring your negotiation…
              </div>
            )}

            {completeError && <p className="text-sm text-red-300">{completeError}</p>}

            <Link
              href={`/scenario/${props.scenario.id}`}
              className="block text-center text-xs text-white/40 underline-offset-2 hover:underline"
            >
              Back to prep
            </Link>
          </div>

          <div className="card">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Coaching objective
            </h3>
            <p className="mt-2 text-sm text-white/70">
              {props.scenario.prep_pack?.coaching_objective}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
