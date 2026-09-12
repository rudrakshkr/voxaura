"use client";

import clsx from "clsx";

export function StatusPill({
  status,
}: {
  status: "idle" | "connecting" | "ready" | "reconnecting" | "ended" | "error";
}) {
  const map: Record<string, { label: string; cls: string }> = {
    idle: { label: "Idle", cls: "text-white/60" },
    connecting: { label: "Connecting…", cls: "text-amber-300" },
    ready: { label: "Live", cls: "text-emerald-300" },
    reconnecting: { label: "Reconnecting…", cls: "text-amber-300" },
    ended: { label: "Ended", cls: "text-white/60" },
    error: { label: "Error", cls: "text-red-300" },
  };
  const { label, cls } = map[status];
  return (
    <span className={clsx("badge", cls)}>
      <span
        className={clsx(
          "mr-1.5 inline-block h-2 w-2 rounded-full",
          status === "ready" && "animate-pulse bg-emerald-400",
          status === "connecting" && "animate-pulse bg-amber-400",
          status === "reconnecting" && "animate-pulse bg-amber-400",
          status === "error" && "bg-red-400",
          (status === "idle" || status === "ended") && "bg-white/40",
        )}
      />
      {label}
    </span>
  );
}

export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
  );
}

export function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const filled = (score / 100) * c;
  const color = score >= 75 ? "#34d399" : score >= 50 ? "#fbbf24" : "#f87171";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={10}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="52%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="white"
        fontSize={size * 0.24}
        fontWeight={700}
      >
        {score}
      </text>
    </svg>
  );
}
