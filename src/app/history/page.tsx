"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { money, Spinner } from "@/components/ui";

interface HistoryRow {
  attempt_id: string;
  scenario_title: string;
  scenario_id: string;
  status: string;
  outcome: string | null;
  retry_mode: string | null;
  final_base: number | null;
  score: number | null;
  started_at: string;
}

export default function HistoryPage() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((d: { history: HistoryRow[] }) => setRows(d.history ?? []))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Attempt history</h1>
        <Link href="/" className="btn btn-ghost">
          ← Scenarios
        </Link>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-white/50">
          <Spinner /> Loading…
        </div>
      )}

      {!loading && rows.length === 0 && (
        <p className="text-white/40">No attempts yet. Start a scenario from the home page.</p>
      )}

      {rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-white/50">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Scenario</th>
                <th className="py-2 pr-4 font-medium">Retry</th>
                <th className="py-2 pr-4 font-medium">Outcome</th>
                <th className="py-2 pr-4 font-medium">Final base</th>
                <th className="py-2 pr-4 font-medium">Score</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const prev = rows[idx + 1];
                const delta =
                  r.score != null && prev?.score != null ? r.score - prev.score : null;
                return (
                  <tr key={r.attempt_id} className="border-b border-white/5">
                    <td className="py-2 pr-4 text-white/50">
                      {new Date(r.started_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="py-2 pr-4">{r.scenario_title}</td>
                    <td className="py-2 pr-4 text-white/50">{r.retry_mode ?? "—"}</td>
                    <td className="py-2 pr-4">{r.outcome?.replace("_", " ") ?? "—"}</td>
                    <td className="py-2 pr-4 font-mono">{money(r.final_base)}</td>
                    <td className="py-2 pr-4">
                      {r.score != null ? (
                        <span>
                          {r.score}
                          {delta != null && delta !== 0 && (
                            <span className={delta > 0 ? "ml-1 text-emerald-300" : "ml-1 text-red-300"}>
                              {delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}
                            </span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2">
                      {r.score != null && (
                        <Link
                          href={`/report/${r.attempt_id}`}
                          className="text-violet-300 underline-offset-2 hover:underline"
                        >
                          Report →
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
