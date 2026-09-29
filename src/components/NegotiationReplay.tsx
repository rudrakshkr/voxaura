"use client";

import { useMemo, useState } from "react";

import { buildReplay, type Impact, type ReplayStep } from "@/lib/replay";
import type { NegotiationEvent } from "@/lib/types";

/**
 * Segment-oriented replay: the negotiation as a list of decisions you can open.
 *
 * The timeline shows what happened; this shows why it mattered and what the
 * alternative was. Each step is a deterministic narration computed from the
 * event log (see `src/lib/replay.ts`), so the economic read — this move raised
 * the total by $6,000, this one revealed your floor for free — always agrees
 * with the numbers being displayed.
 */

const IMPACT_STYLE: Record<Impact, { dot: string; chip: string; label: string }> = {
  strong: {
    dot: "bg-emerald-400 ring-emerald-400/30",
    chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    label: "Strong",
  },
  neutral: {
    dot: "bg-slate-400/70 ring-slate-400/20",
    chip: "border-white/15 bg-white/[0.06] text-white/70",
    label: "Neutral",
  },
  risky: {
    dot: "bg-amber-400 ring-amber-400/30",
    chip: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    label: "Risky",
  },
};

function clock(ms: number | null): string {
  if (ms == null) return "--:--";
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function StepRow({
  step,
  open,
  onToggle,
  highlighted,
}: {
  step: ReplayStep;
  open: boolean;
  onToggle: () => void;
  highlighted: boolean;
}) {
  const style = IMPACT_STYLE[step.impact];
  return (
    <li
      id={step.seq != null ? `ev-${step.seq}` : undefined}
      className={`relative scroll-mt-24 rounded-xl transition ${
        highlighted ? "bg-violet-500/10 ring-1 ring-violet-400/40" : ""
      }`}
    >
      <span className={`absolute -left-[31px] top-4 h-3 w-3 rounded-full ring-4 ${style.dot}`} />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-baseline gap-x-2 rounded-xl px-3 py-2 text-left hover:bg-white/[0.04]"
      >
        <span className="font-mono text-xs text-white/40">{clock(step.atMs)}</span>
        <span
          className={`text-sm font-semibold ${
            step.actor === "user" ? "text-violet-300" : "text-white/85"
          }`}
        >
          {step.actor === "user" ? "You" : "Recruiter"}
        </span>
        <span className="text-sm text-white/75">{step.title}</span>
        {step.deltaTotal != null && step.deltaTotal > 0 && (
          <span className="font-mono text-xs text-emerald-300">+{money(step.deltaTotal)}</span>
        )}
        <span className={`ml-auto rounded-md border px-2 py-0.5 text-[11px] ${style.chip}`}>
          {style.label}
        </span>
      </button>

      {open && (
        <div className="mb-2 ml-3 space-y-2 border-l border-white/10 pl-4 text-sm">
          <p className="text-white/70">{step.what}</p>
          {step.why && <p className="text-white/55">{step.why}</p>}
          {step.runningTotal != null && (
            <p className="font-mono text-xs text-white/40">
              First-year total on the table: {money(step.runningTotal)}
            </p>
          )}
          {step.better && (
            <p className="text-amber-200/90">
              <span className="font-semibold">Instead: </span>
              {step.better}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function NegotiationReplay({ events }: { events: NegotiationEvent[] }) {
  const steps = useMemo(() => buildReplay(events), [events]);
  // Open the two most recent turns by default: the end of the call is what the
  // candidate remembers, so the replay should start there rather than collapsed.
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(steps.slice(-2).flatMap((s) => (s.seq != null ? [s.seq] : []))),
  );
  const [highlight, setHighlight] = useState<number | null>(null);

  if (steps.length === 0) {
    return <p className="text-sm text-white/40">No negotiation moves were recorded in this call.</p>;
  }

  const toggle = (seq: number | null) => {
    if (seq == null) return;
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  /** Jump to an event referenced by a dimension's evidence. */
  const jumpTo = (seq: number) => {
    setOpen((prev) => new Set(prev).add(seq));
    setHighlight(seq);
    const el = document.getElementById(`ev-${seq}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 2000);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-white/40">
        Click any move to see what happened, why it mattered, and what a stronger alternative would
        have been.
      </p>
      <ol className="relative space-y-1 border-l border-white/10 pl-6">
        {steps.map((step, i) => (
          <StepRow
            key={`${step.seq ?? i}-${step.type}`}
            step={step}
            open={step.seq != null && open.has(step.seq)}
            onToggle={() => toggle(step.seq)}
            highlighted={step.seq != null && highlight === step.seq}
          />
        ))}
      </ol>
      {steps.some((s) => s.seq != null) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-[11px] uppercase tracking-wide text-white/35">Jump to move</span>
          {steps
            .filter((s) => s.seq != null)
            .map((s) => (
              <button
                key={s.seq}
                type="button"
                onClick={() => jumpTo(s.seq as number)}
                className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[11px] text-white/50 hover:bg-white/[0.06]"
                title={s.title}
              >
                #{s.seq}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Rendered inside a dimension card to link a score to the moves behind it. */
export function EvidenceList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {items.map((e, i) => (
        <li key={i} className="border-l-2 border-violet-400/30 pl-2 text-xs text-white/55">
          {e}
        </li>
      ))}
    </ul>
  );
}
