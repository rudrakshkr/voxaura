"use client";

import { money } from "./ui";
import type { NegotiationEvent } from "@/lib/types";

/**
 * Chronological negotiation timeline. Impact-coded: strong (emerald),
 * neutral (slate), risky (amber/red). Renders time, actor, event, amount,
 * and a concise interpretation per move.
 */

const EVENT_LABELS: Record<string, string> = {
  user_offer: "asked for",
  opponent_offer: "offered",
  user_anchor: "anchored at",
  opponent_anchor: "opened at",
  counteroffer: "countered with",
  concession: "conceded",
  leverage_introduced: "cited leverage",
  leverage_challenged: "challenged the leverage",
  information_request: "asked about flexibility",
  information_revealed: "revealed information",
  package_trade: "proposed a trade",
  missed_opportunity: "missed opportunity",
  commitment_signal: "signaled commitment",
  acceptance: "accepted the deal",
  rejection: "rejected the offer",
  walk_away: "walked away",
  pressure_tactic: "applied pressure",
  objection_raised: "raised an objection",
  rapport: "built rapport",
  target_covered: "covered the target",
  interruption: "interrupted",
};

const IMPACT_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  strong: {
    dot: "bg-emerald-400 ring-emerald-400/30",
    label: "text-emerald-300",
    text: "Strong move",
  },
  neutral: {
    dot: "bg-slate-400/70 ring-slate-400/20",
    label: "text-white/70",
    text: "",
  },
  risky: {
    dot: "bg-amber-400 ring-amber-400/30",
    label: "text-amber-300",
    text: "Risky move",
  },
};

function impactFor(event: NegotiationEvent): "strong" | "neutral" | "risky" {
  const explicit = (event.payload as { impact?: string }).impact;
  if (explicit === "strong" || explicit === "risky" || explicit === "neutral") {
    return explicit;
  }
  // Heuristic defaults when the scorer didn't classify.
  const strong = new Set([
    "user_anchor",
    "counteroffer",
    "leverage_introduced",
    "package_trade",
    "acceptance",
    "information_request",
  ]);
  const risky = new Set([
    "information_revealed",
    "missed_opportunity",
    "walk_away",
    "interruption",
  ]);
  if (strong.has(event.type)) return "strong";
  if (risky.has(event.type)) return "risky";
  return "neutral";
}

function fmtClock(ms: number | null | undefined): string {
  if (ms == null) return "--:--";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function amountLabel(event: NegotiationEvent): string | null {
  const p = event.payload as {
    amount?: number;
    package?: { base?: number; sign_on?: number | null; equity?: number | null };
    reservation_reveal?: number | null;
    leverage?: number | null;
  };
  const pkg = p.package;
  if (pkg && typeof pkg.base === "number") {
    const parts = [`$${Math.round(pkg.base / 1000)}k base`];
    if (pkg.sign_on) parts.push(`${money(pkg.sign_on)} sign-on`);
    if (pkg.equity) parts.push(`${money(pkg.equity)}/yr equity`);
    return parts.join(" + ");
  }
  if (p.leverage != null) return `competing offer at ${money(p.leverage)}`;
  if (p.reservation_reveal != null) return `floor of ${money(p.reservation_reveal)}`;
  if (p.amount != null) return money(p.amount);
  return null;
}

export function NegotiationTimeline({ events }: { events: NegotiationEvent[] }) {
  const sorted = [...events]
    .filter((e) => e.type !== "rapport")
    .sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-white/40">
        No negotiation moves were detected in this session.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 border-l border-white/10 pl-6">
      {sorted.map((e, i) => {
        const impact = impactFor(e);
        const style = IMPACT_STYLES[impact];
        const amount = amountLabel(e);
        const note = typeof e.payload?.note === "string" ? e.payload.note : null;
        const condition =
          typeof e.payload?.condition === "string"
            ? e.payload.condition
            : Array.isArray(e.payload?.conditions) && e.payload.conditions.length > 0
              ? e.payload.conditions.map(String).join("; ")
              : null;
        return (
          <li key={i} className="relative">
            <span
              className={`absolute -left-[31px] top-1 h-3 w-3 rounded-full ring-4 ${style.dot}`}
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-white/40">{fmtClock(e.at_ms)}</span>
              <span
                className={`text-sm font-semibold ${
                  e.actor === "user" ? "text-violet-300" : "text-white/85"
                }`}
              >
                {e.actor === "user" ? "You" : "Recruiter"}
              </span>
              <span className={`text-sm ${style.label}`}>
                {EVENT_LABELS[e.type] ?? e.type.replace(/_/g, " ")}
                {amount && <span className="font-mono"> {amount}</span>}
              </span>
            </div>
            {(condition || (note && impact !== "neutral")) && (
              <p className="mt-0.5 text-xs text-white/45">
                {condition && <>Condition: {condition}. </>}
                {impact === "risky" && note && note.length < 140 ? note : ""}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
