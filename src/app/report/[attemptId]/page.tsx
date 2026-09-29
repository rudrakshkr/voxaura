"use client";

import { useEffect, useState } from "react";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { CounterfactualPanel } from "@/components/CounterfactualPanel";
import { EvidenceList, NegotiationReplay } from "@/components/NegotiationReplay";
import { money, ScoreRing, Spinner } from "@/components/ui";
import type { ReportData } from "@/lib/types";

/** The pipeline the report represents, shown while it is being assembled. */
const PROCESSING_STEPS = [
  "Transcript processed",
  "Negotiation moves detected",
  "Scoring dimensions evaluated",
  "Alternative strategies simulated",
];

/**
 * Staged progress while the report loads.
 *
 * A spinner for several seconds looks broken; naming the stages makes the delay
 * legible — and it is honest about what the report is made of.
 */
function ProcessingSteps() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setStep((s) => Math.min(s + 1, PROCESSING_STEPS.length - 1)), 1400);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="card space-y-3">
      <p className="font-semibold tracking-wide text-white/85">ANALYZING NEGOTIATION…</p>
      <ul className="space-y-2 text-sm">
        {PROCESSING_STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span className={i <= step ? "text-emerald-300" : "text-white/20"}>
              {i < step ? "✓" : i === step ? "•" : "○"}
            </span>
            <span className={i <= step ? "text-white/70" : "text-white/35"}>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface AttemptDetail {
  attempt: {
    id: string;
    scenario_id: string;
    status: string;
    outcome: string | null;
    final_offer: { base: number; sign_on: number | null; equity: number | null } | null;
    final_conditions: string[] | null;
    retry_mode: string | null;
  };
  scenario: { id: string; title: string; company: string; role: string };
  score: number | null;
  /** Score of the caller's previous attempt on this scenario (null if none). */
  previous_score: number | null;
}

const DIMENSION_LABELS: Record<string, string> = {
  anchoring: "Anchoring",
  leverage: "Leverage",
  information_control: "Information control",
  concession_management: "Concession management",
  outcome: "Outcome",
  // legacy dimensions (older reports) still render correctly
  information_gathering: "Information gathering",
  justification: "Justification & leverage",
  package_creativity: "Package creativity",
  composure: "Composure & rapport",
  outcome_vs_achievable: "Outcome vs. achievable",
};

interface ReportPayload extends ReportData {
  /** `server` | `client` | `server+client` — provenance of the scored transcript. */
  transcript_source?: string | null;
}

export default function ReportPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why the report is not here: "not scored yet" is a different message from
  // "the server failed". Either way the page must STOP pretending to analyze —
  // an indefinite "ANALYZING NEGOTIATION…" is the worst possible answer.
  const [reportError, setReportError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/attempts/${attemptId}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not load this attempt (${res.status})`);
        }
        const d = (await res.json()) as AttemptDetail;
        if (!alive) return;
        if (!d?.attempt) throw new Error("This attempt is not available.");
        setDetail(d);
      } catch (err) {
        if (alive) setError((err as Error).message);
        return;
      }
      try {
        const res = await fetch(`/api/attempts/${attemptId}/report`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(
            res.status === 404
              ? "This attempt has not been scored yet."
              : body.error ?? `Could not load the report (${res.status})`,
          );
        }
        const r = (await res.json()) as { report: ReportPayload };
        if (alive) setReport(r.report);
      } catch (err) {
        if (alive) setReportError((err as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
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
      const data = (await res.json()) as { attempt_id: string };
      router.push(
        `/scenario/${detail.attempt.scenario_id}/session?attempt=${encodeURIComponent(data.attempt_id)}`,
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

  // Real progress: the caller's PREVIOUS scored attempt on this scenario, not
  // this attempt's own score (which made every delta read +0).
  const prevScore = detail.previous_score;

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

      {!report && !reportError && <ProcessingSteps />}

      {!report && reportError && (
        <div className="card space-y-3">
          <p className="font-semibold text-amber-200">No scored report for this call</p>
          <p className="text-sm text-white/60">{reportError}</p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              onClick={() => {
                setReportError(null);
                router.refresh();
                window.location.reload();
              }}
            >
              Retry
            </button>
            <Link href="/history" className="btn btn-ghost">
              View history
            </Link>
          </div>
        </div>
      )}

      {report && (
        <>
          <div className="grid gap-6 md:grid-cols-[auto_1fr]">
            <div className="card flex flex-col items-center justify-center gap-2">
              <ScoreRing score={report.overall_score} />
              {prevScore != null && (
                <p
                  className={
                    report.overall_score >= prevScore
                      ? "text-sm font-semibold text-emerald-300"
                      : "text-sm font-semibold text-red-300"
                  }
                >
                  {prevScore} → {report.overall_score} ({
                    report.overall_score - prevScore >= 0 ? "+" : ""
                  }
                  {report.overall_score - prevScore} pts)
                </p>
              )}
              {/*
                The outcome is the ENGINE's, read from the attempt itself. It is
                deliberately not taken from the report payload: the scorer has no
                authority over whether a deal happened, so this line shows the
                server-decided result (or "scored" when none was reached).
              */}
              <p className="text-sm font-semibold">
                {detail.attempt.outcome ? detail.attempt.outcome.replace("_", " ") : "scored"}
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
            <p className="mt-1 text-xs text-white/40">
              Each score cites the moments behind it. The overall score is computed from these
              weighted dimensions — the coach cannot inflate it with opinion.
            </p>
            <div className="mt-4 space-y-4">
              {(report.rubric ?? []).map((dim) => (
                <div key={dim.dimension}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/70">
                      {DIMENSION_LABELS[dim.dimension] ?? dim.dimension}
                    </span>
                    <span className="font-mono">
                      {dim.score}/10
                      <span className="ml-2 text-xs text-white/35">w {dim.weight.toFixed(2)}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${(dim.score / 10) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-white/50">{dim.feedback}</p>
                  <EvidenceList items={dim.evidence ?? []} />
                  {(dim.event_seqs ?? []).length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] uppercase tracking-wide text-white/30">
                        Moves
                      </span>
                      {(dim.event_seqs ?? []).map((seq) => (
                        <a
                          key={seq}
                          href={`#ev-${seq}`}
                          className="rounded-md border border-violet-400/25 px-1.5 py-0.5 font-mono text-[11px] text-violet-200 hover:bg-violet-400/10"
                        >
                          #{seq}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h2 className="font-semibold">Replay the negotiation</h2>
            <p className="mt-1 text-xs text-white/40">
              Strong moves are green, risky moves amber. Every entry is what actually happened on
              the call, with the economic impact of each decision.
            </p>
            <div className="mt-5">
              <NegotiationReplay events={report.events ?? []} />
            </div>
          </section>

          <section className="card">
            <h2 className="font-semibold">What if you had done it differently?</h2>
            <p className="mt-1 text-xs text-white/40">
              Each alternative is replayed against this scenario&apos;s exact economics by the same
              engine that ran the live call.
            </p>
            <div className="mt-4">
              <CounterfactualPanel attemptId={attemptId} />
            </div>
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section className="card">
              <h2 className="font-semibold">Transcript</h2>
              {report.transcript_source === "client" && (
                <p className="mt-1 text-xs text-amber-200/80">
                  Recovered from this browser&apos;s own copy of the call — the voice service had no
                  recorded timeline for it, so this transcript is unverified.
                </p>
              )}
              {report.transcript_source === "server+client" && (
                <p className="mt-1 text-xs text-white/40">
                  The recorded call timeline, plus moments this browser saw that the service did not.
                </p>
              )}
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
              <h2 className="font-semibold">Communication</h2>
              <p className="mt-1 text-xs text-white/40">
                Qualitative only — this does not affect your score.
              </p>
              <dl className="mt-4 space-y-3 text-sm">
                {(
                  [
                    ["Clarity", report.communication?.clarity],
                    ["Confidence", report.communication?.confidence],
                    ["Composure", report.communication?.composure],
                    ["Rapport", report.communication?.rapport],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="font-medium text-white/70">{label}</dt>
                    <dd className="text-white/55">{value ?? "—"}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </>
      )}

      <section className="card flex flex-wrap items-center gap-3">
        <h2 className="w-full font-semibold">Run it again?</h2>
        <button className="btn btn-primary" disabled={retrying} onClick={() => void retry("reroll")}>
          {retrying ? <Spinner /> : "🔁"} Retry — same scenario, fresh conversation
        </button>
        <button
          className="btn btn-ghost"
          disabled={retrying}
          onClick={() => void retry("harder")}
        >
          🔥 Retry harder — same numbers, tougher recruiter
        </button>
        <Link href="/history" className="btn btn-ghost">
          View history
        </Link>
        {error && <p className="text-sm text-red-300">{error}</p>}
      </section>
    </div>
  );
}