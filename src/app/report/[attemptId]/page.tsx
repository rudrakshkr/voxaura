"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { money, ScoreRing, Spinner } from "@/components/ui";
import type { ReportData } from "@/lib/types";

interface AttemptDetail {
  attempt: {
    id: string;
    scenario_id: string;
    status: string;
    outcome: string | null;
    final_offer: { base: number; sign_on: number | null; equity: number | null } | null;
    retry_mode: string | null;
  };
  scenario: { id: string; title: string; company: string; role: string };
  score: number | null;
}

const DIMENSION_LABELS: Record<string, string> = {
  anchoring: "Anchoring",
  information_gathering: "Information gathering",
  justification: "Justification & leverage",
  concession_management: "Concession management",
  package_creativity: "Package creativity",
  composure: "Composure & rapport",
  information_control: "Information control",
  outcome: "Outcome vs. achievable",
};

export default function ReportPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/attempts/${attemptId}`).then((r) => r.json()),
      fetch(`/api/attempts/${attemptId}/report`).then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as { report: ReportData };
      }),
    ])
      .then(([d, r]) => {
        setDetail(d as AttemptDetail);
        setReport(r?.report ?? null);
      })
      .catch((err) => setError((err as Error).message));
  }, [attemptId]);

  async function retry(mode: "harder" | "reroll") {
    if (!detail) return;
    setRetrying(true);
    try {
      const res = await fetch("/api/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_id: detail.attempt.scenario_id,
          retry_mode: mode,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Retry failed");
      }
      const data = (await res.json()) as { attempt_id: string; agent_id: string | null; agent_mode: string };
      router.push(
        `/scenario/${detail.attempt.scenario_id}/session?attempt=${data.attempt_id}&mode=${data.agent_mode}&agent=${data.agent_id ?? ""}`,
      );
    } catch (err) {
      setError((err as Error).message);
      setRetrying(false);
    }
  }

  if (error && !detail) {
    return (
      <div className="space-y-4">
        <p className="text-red-300">{error}</p>
        <Link href="/" className="btn btn-ghost">
          ← Back
        </Link>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center gap-2 text-white/50">
        <Spinner /> Loading report…
      </div>
    );
  }

  const prevScore = detail.score;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/scenario/${detail.attempt.scenario_id}`}
          className="text-sm text-white/40 underline-offset-2 hover:underline"
        >
          ← {detail.scenario.title}
        </Link>
        <h1 className="mt-2 text-3xl font-bold">Negotiation report</h1>
        <p className="text-white/50">
          {detail.scenario.company} · {detail.scenario.role}
          {detail.attempt.retry_mode ? ` · retry (${detail.attempt.retry_mode})` : ""}
        </p>
      </div>

      {!report && (
        <div className="card space-y-3">
          <p className="text-white/70">
            {prevScore == null
              ? "This attempt hasn't been scored yet."
              : "Report details are loading…"}
          </p>
          <Link href={`/scenario/${detail.attempt.scenario_id}/session?attempt=${attemptId}&mode=stored&agent=`} className="btn btn-ghost">
            Back to session
          </Link>
        </div>
      )}

      {report && (
        <>
          <div className="grid gap-6 md:grid-cols-[auto_1fr]">
            <div className="card flex flex-col items-center justify-center gap-2">
              <ScoreRing score={report.overall_score} />
              <p className="text-sm font-semibold">
                {report.outcome ? report.outcome.replace("_", " ") : "scored"}
              </p>
              {detail.attempt.final_offer && (
                <p className="text-sm text-white/50">
                  Final: {money(detail.attempt.final_offer.base)} base
                  {detail.attempt.final_offer.sign_on
                    ? ` · ${money(detail.attempt.final_offer.sign_on)} sign-on`
                    : ""}
                  {detail.attempt.final_offer.equity
                    ? ` · ${money(detail.attempt.final_offer.equity)}/yr equity`
                    : ""}
                </p>
              )}
            </div>

            <div className="card">
              <h2 className="font-semibold">Coach&apos;s verdict</h2>
              <p className="mt-2 text-white/70">{report.summary}</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-300">
                    Strengths
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-white/70">
                    {(report.strengths ?? []).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-300">
                    Work on
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-white/70">
                    {(report.improvements ?? []).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <section className="card">
            <h2 className="font-semibold">Dimension scores</h2>
            <div className="mt-4 space-y-3">
              {(report.rubric ?? []).map((dim) => (
                <div key={dim.dimension}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/70">
                      {DIMENSION_LABELS[dim.dimension] ?? dim.dimension}
                    </span>
                    <span className="font-mono">{dim.score}/10</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${(dim.score / 10) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-white/40">{dim.feedback}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section className="card">
              <h2 className="font-semibold">Transcript</h2>
              <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                {(report.transcript ?? []).map((t, i) => (
                  <p key={i} className="text-sm">
                    <span
                      className={
                        t.role === "user"
                          ? "font-semibold text-violet-300"
                          : "font-semibold text-white/70"
                      }
                    >
                      {t.role === "user" ? "You: " : "Recruiter: "}
                    </span>
                    <span className="text-white/70">
                      {t.text}
                      {t.interrupted && <span className="ml-1 text-xs text-white/30">(cut off)</span>}
                    </span>
                  </p>
                ))}
              </div>
            </section>

            <section className="card">
              <h2 className="font-semibold">Moves detected</h2>
              <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                {(report.events?.length ?? 0) === 0 && (
                  <p className="text-sm text-white/40">No negotiation events were detected.</p>
                )}
                {(report.events ?? []).map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span
                      className={
                        e.actor === "user"
                          ? "rounded bg-violet-600/30 px-1.5 py-0.5 text-xs text-violet-200"
                          : "rounded bg-white/10 px-1.5 py-0.5 text-xs text-white/70"
                      }
                    >
                      {e.actor}
                    </span>
                    <span className="text-white/70">
                      {e.type.replace(/_/g, " ")}
                      {typeof e.payload?.amount === "number" &&
                        ` · ${money(e.payload.amount)}`}
                      {typeof e.payload?.note === "string" && e.payload.note
                        ? ` — ${e.payload.note}`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      <section className="card flex flex-wrap items-center gap-3">
        <h2 className="w-full font-semibold">Run it again?</h2>
        <button className="btn btn-primary" disabled={retrying} onClick={() => void retry("reroll")}>
          {retrying ? <Spinner /> : "🔁"} Retry (fresh numbers)
        </button>
        <button
          className="btn btn-ghost"
          disabled={retrying}
          onClick={() => void retry("harder")}
        >
          🔥 Retry harder (firmer recruiter)
        </button>
        <Link href="/history" className="btn btn-ghost">
          View history
        </Link>
        {error && <p className="text-sm text-red-300">{error}</p>}
      </section>
    </div>
  );
}
