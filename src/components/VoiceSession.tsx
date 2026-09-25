"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { OfferMeter } from "./OfferMeter";
import { TranscriptView } from "./TranscriptView";
import { VoiceStateBar } from "./VoiceStateBar";
import { money, Spinner, StatusPill } from "./ui";
import { useVoiceAgent } from "@/hooks/useVoiceAgent";
import type { ScenarioPublic } from "@/lib/types";interface Props {
  attemptId: string;
  agentId: string | null;
  agentMode: "stored" | "inline";
  inlineConfig?: { systemPrompt: string; greeting: string } | null;
  scenario: ScenarioPublic;
  retryMode: string | null;
  /** Server-authoritative standing package, so the panel is never empty. */
  initialOffer?: { base: number; sign_on?: number | null; equity?: number | null } | null;
}

/** The line the candidate should say when the recruiter stalls on a decision. */
const DECISION_LINE = "What did the team say?";

export function VoiceSession(props: Props) {
  const router = useRouter();
  const { state, connect, end, restart } = useVoiceAgent({
    attemptId: props.attemptId,
    agentId: props.agentId,
    agentMode: props.agentMode,
    inlineConfig: props.inlineConfig ?? null,
    initialOffer: props.initialOffer ?? null,
  });
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
          // Outcome is server-authoritative; this is only a fallback hint.
          outcome: null,
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
  }, [props.attemptId, router, state.transcript]);

  // Auto-complete shortly after the engine validates an acceptance.
  const accepted = state.acceptedOffer != null;
  useEffect(() => {
    if (!accepted) return;
    const t = window.setTimeout(() => {
      end();
      void complete();
    }, 5000);
    return () => window.clearTimeout(t);
  }, [accepted, complete, end]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-white/50">
            {props.scenario.company} · {props.scenario.role}
            {props.retryMode ? ` · retry (${props.retryMode === "harder" ? "harder" : "fresh"})` : ""}
          </p>
          <h1 className="text-2xl font-bold">{props.scenario.title}</h1>
        </div>
        <StatusPill status={state.status} />
      </div>

      {state.error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <p>{state.error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              onClick={() => {
                void connect();
              }}
            >
              Try again
            </button>
            <Link href={`/scenario/${props.scenario.id}`} className="btn btn-ghost">
              Back to prep
            </Link>
          </div>
          {state.transcript.length > 0 && (
            <p className="mt-2 text-xs text-white/50">
              Your transcript so far is saved — you can still score this attempt instead of
              retrying.
            </p>
          )}
        </div>
      )}

      <VoiceStateBar
        status={state.status}
        userSpeaking={state.userSpeaking}
        agentSpeaking={state.agentSpeaking}
        recruiterThinking={state.recruiterThinking}
        justInterrupted={state.justInterrupted}
        elapsedSec={state.elapsedSec}
        audioFlowing={state.audioFlowing}
      />

      {/* The call can look perfectly healthy while the agent receives no audio.
          Surface that the moment it's detected instead of letting the user
          talk into a dead line. */}
      {state.audioWarning && state.status === "ready" && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">The recruiter may not be hearing you</p>
          <p className="mt-1 text-amber-100/80">{state.audioWarning}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={restart}>
              Restart the call
            </button>
            <Link href={`/scenario/${props.scenario.id}`} className="btn btn-ghost">
              Change microphone setup
            </Link>
          </div>
          <p className="mt-2 text-xs text-amber-100/60">
            Restarting keeps your transcript and this attempt — the recruiter will greet you again.
          </p>
        </div>
      )}

      {/* Nothing happens off-screen in a simulation. When the recruiter promises
          to "take it back to the team", say so plainly and hand the candidate
          the line that forces a real decision. */}
      {state.deferral && state.status === "ready" && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">The recruiter stalled on the decision</p>
          <p className="mt-1 text-amber-100/80">
            They said they&apos;d take your number away for approval. There is no off-screen team —
            press for the answer before the call ends.
          </p>
          {state.deferral.quote && (
            <p className="mt-2 border-l-2 border-amber-400/40 pl-3 text-xs italic text-amber-100/60">
              “{state.deferral.quote}”
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-white/10 px-3 py-1.5 font-mono text-xs text-amber-50">
              “{DECISION_LINE}”
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void Promise.resolve(navigator.clipboard?.writeText(DECISION_LINE)).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "Copied" : "Copy the line"}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-100/60">
            Say it out loud — the recruiter has to give you a straight answer this time.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <TranscriptView
            transcript={state.transcript}
            partialUser={state.partialUser}
            agentSpeaking={state.agentSpeaking}
          />
        </div>

        <div className="space-y-4">
          <OfferMeter
            currentOffer={state.currentOffer}
            acceptedOffer={state.acceptedOffer}
            conditions={state.offerConditions}
            previousOffer={state.previousOffer}
            notice={state.offerNotice}
          />

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
              <div className="space-y-2 text-sm text-white/60">
                <div className="flex items-center gap-2">
                  <Spinner /> Setting up the call…
                </div>
                <p className="text-xs text-white/40">
                  Your browser will ask for microphone access — click Allow.
                </p>
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

          <div className="card space-y-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
                Coaching objective
              </h3>
              <p className="mt-2 text-sm text-white/70">
                {props.scenario.prep_pack?.coaching_objective}
              </p>
            </div>
            <div className="border-t border-white/10 pt-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
                Your prep targets
              </h3>
              <div className="mt-2 flex gap-6 text-sm">
                <div>
                  <p className="text-xs text-white/40">Target</p>
                  <p className="font-mono text-violet-300">
                    {money(props.scenario.prep_pack?.your_target ?? null)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-white/40">Walk away below</p>
                  <p className="font-mono text-white/80">
                    {money(props.scenario.prep_pack?.your_reservation ?? null)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
