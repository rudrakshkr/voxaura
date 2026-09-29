"use client";

import { useEffect, useState } from "react";

import { Spinner } from "./ui";

/**
 * "What would have happened if I had done that differently?"
 *
 * Every row is a full re-simulation of this scenario against the SAME hidden
 * economics, run by the same deterministic engine that handled the live call —
 * not an LLM's guess. Deltas are measured against what actually happened, and
 * the disclaimer is part of the payload, not decoration: a modeled outcome is a
 * modeled outcome.
 */

interface CounterfactualResult {
  plan: { key: string; label: string; summary: string };
  finalPackage: { base: number; sign_on?: number | null; equity?: number | null };
  finalBase: number;
  finalTotal: number;
  outcome: string;
  rounds: number;
  deltaBase: number;
  deltaTotal: number;
}

interface CounterfactualReport {
  actual: { total: number; base: number; outcome: string | null } | null;
  results: CounterfactualResult[];
  disclaimer: string;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function Delta({ value }: { value: number }) {
  if (value === 0) return <span className="font-mono text-white/40">±0</span>;
  const up = value > 0;
  return (
    <span className={`font-mono ${up ? "text-emerald-300" : "text-rose-300"}`}>
      {up ? "+" : "−"}
      {money(Math.abs(value))}
    </span>
  );
}

export function CounterfactualPanel({ attemptId }: { attemptId: string }) {
  const [report, setReport] = useState<CounterfactualReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/attempts/${attemptId}/counterfactual`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Simulation unavailable");
        const data = (await res.json()) as { counterfactual: CounterfactualReport };
        if (alive) setReport(data.counterfactual);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [attemptId]);

  if (error) {
    return <p className="text-sm text-white/40">Alternatives could not be modeled: {error}</p>;
  }
  if (!report) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/50">
        <Spinner /> Replaying alternative strategies…
      </div>
    );
  }

  const best = [...report.results].sort((a, b) => b.deltaTotal - a.deltaTotal)[0];

  return (
    <div className="space-y-4">
      {report.actual && (
        <p className="text-sm text-white/60">
          What actually happened: <span className="font-mono">{money(report.actual.total)}</span>{" "}
          first-year total ({money(report.actual.base)} base).{" "}
          {best && best.deltaTotal > 0 ? (
            <>
              The strongest modeled alternative was{" "}
              <span className="font-semibold text-white/85">{best.plan.label.toLowerCase()}</span> —{" "}
              <span className="font-mono text-emerald-300">+{money(best.deltaTotal)}</span>.
            </>
          ) : (
            <>No modeled alternative beat what you actually did.</>
          )}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-white/40">
              <th className="pb-2 font-medium">Alternative</th>
              <th className="pb-2 font-medium">Modeled package</th>
              <th className="pb-2 font-medium">Outcome</th>
              <th className="pb-2 font-medium">vs. actual</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {report.results.map((r) => (
              <tr key={r.plan.key} className="align-top">
                <td className="py-3 pr-4">
                  <p className="font-medium text-white/85">{r.plan.label}</p>
                  <p className="text-xs text-white/45">{r.plan.summary}</p>
                </td>
                <td className="py-3 pr-4 font-mono text-white/70">
                  {money(r.finalBase)} base
                  <span className="block text-xs text-white/40">
                    {money(r.finalTotal)} first-year
                  </span>
                </td>
                <td className="py-3 pr-4 text-white/60">
                  {r.outcome.replace("_", " ")}
                  <span className="block text-xs text-white/35">{r.rounds} turns</span>
                </td>
                <td className="py-3">
                  <Delta value={r.deltaTotal} />
                  <span className="block text-xs text-white/35">{money(Math.abs(r.deltaBase))} base</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/40">{report.disclaimer}</p>
    </div>
  );
}
