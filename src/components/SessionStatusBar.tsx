"use client";

import type { VoiceAgentState } from "@/hooks/useVoiceAgent";

/**
 * Live reliability strip for the call screen.
 *
 * A voice demo lives or dies on whether the audience believes the state is real.
 * This shows the two things that can silently fail — the voice socket and the
 * durable event log — as plain status, so "Reconnecting" or "3 events pending"
 * is visible instead of a call that looks fine while nothing is being recorded.
 *
 * It shows counts and connection state only: never a hidden scenario value.
 */
type Dot = "ok" | "warn" | "bad" | "idle";

function Pill({
  dot,
  label,
  title,
}: {
  dot: Dot;
  label: string;
  title?: string;
}) {
  const color =
    dot === "ok"
      ? "bg-emerald-400"
      : dot === "warn"
        ? "bg-amber-400"
        : dot === "bad"
          ? "bg-rose-400"
          : "bg-white/30";
  return (
    <span
      title={title}
      className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/70"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}

export function SessionStatusBar({
  status,
  sync,
  elapsedSec,
}: {
  status: VoiceAgentState["status"];
  sync: VoiceAgentState["sync"];
  elapsedSec: number;
}) {
  const voice: { dot: Dot; label: string } =
    status === "ready"
      ? { dot: "ok", label: "Voice connected" }
      : status === "connecting"
        ? { dot: "warn", label: "Connecting…" }
        : status === "reconnecting"
          ? { dot: "warn", label: "Reconnecting…" }
          : status === "ended"
            ? { dot: "idle", label: "Call ended" }
            : status === "error"
              ? { dot: "bad", label: "Connection problem" }
              : { dot: "idle", label: "Not connected" };

  const engine: { dot: Dot; label: string } =
    sync.state === "error"
      ? { dot: "bad", label: `${sync.pending} event${sync.pending === 1 ? "" : "s"} pending — retrying` }
      : sync.pending > 0
        ? { dot: "warn", label: `${sync.pending} event${sync.pending === 1 ? "" : "s"} pending` }
        : { dot: "ok", label: "Engine synced" };

  const mm = Math.floor(elapsedSec / 60);
  const ss = Math.floor(elapsedSec % 60);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill dot={voice.dot} label={voice.label} />
      <Pill dot={engine.dot} label={engine.label} />
      <Pill
        dot={sync.recorded > 0 ? "ok" : "idle"}
        label={`${sync.recorded} event${sync.recorded === 1 ? "" : "s"} recorded`}
        title="Negotiation moves persisted to the database. Scoring reads this log."
      />
      <Pill dot="idle" label={`${mm}:${String(ss).padStart(2, "0")}`} title="Call time" />
    </div>
  );
}
