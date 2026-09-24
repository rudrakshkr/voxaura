"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { Spinner } from "@/components/ui";
import type { ScenarioPublic } from "@/lib/types";

interface AttemptResponse {
  attempt_id: string;
  agent_id: string | null;
  agent_mode: "stored" | "inline";
  greeting: string;
  system_prompt?: string;
}

export default function ScenarioPrepPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [scenario, setScenario] = useState<ScenarioPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetch(`/api/scenarios/${id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Scenario not found");
        const data = (await res.json()) as { scenario: ScenarioPublic };
        setScenario(data.scenario);
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_id: id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not start (${res.status})`);
      }
      const data = (await res.json()) as AttemptResponse;
      // agent_id is not secret (the prompt is); passing it here lets the
      // session bind to this attempt's stored opponent directly. When the
      // mode is inline, the system_prompt is also passed for the session page
      // to forward to the client-side voice config.
      const params = new URLSearchParams();
      params.set("attempt", data.attempt_id);
      params.set("mode", data.agent_mode);
      if (data.agent_id) params.set("agent", data.agent_id);
      if (data.system_prompt) params.set("prompt", data.system_prompt);
      if (data.greeting) params.set("greeting", data.greeting);
      router.push(`/scenario/${id}/session?${params.toString()}`);
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }, [id, router]);

  if (error && !scenario) {
    return (
      <div className="space-y-4">
        <p className="text-red-300">{error}</p>
        <Link href="/" className="btn btn-ghost">
          ← Back
        </Link>
      </div>
    );
  }

  if (!scenario) {
    return (
      <div className="flex items-center gap-2 text-white/50">
        <Spinner /> Loading scenario…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-white/40 underline-offset-2 hover:underline">
          ← All scenarios
        </Link>
        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{scenario.title}</h1>
            <p className="mt-1 text-white/50">
              {scenario.company} · {scenario.role} · {scenario.level}
            </p>
          </div>
          <span className="badge">{scenario.difficulty}</span>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="card space-y-3">
            <h2 className="font-semibold">The situation</h2>
            <p className="text-white/70">{scenario.prep_pack.context}</p>
          </section>

          <section className="card space-y-3">
            <h2 className="font-semibold">Compensation components</h2>
            <ul className="list-disc space-y-1 pl-5 text-white/70">
              {scenario.prep_pack.comp_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>

          <section className="card space-y-3 border-violet-500/30 bg-violet-500/5">
            <h2 className="font-semibold">Your briefing</h2>
            <p className="text-white/70">{scenario.prep_pack.coaching_objective}</p>
            {scenario.prep_pack.your_target != null && (
              <div className="flex gap-8 pt-1">
                <div>
                  <p className="text-xs uppercase tracking-wide text-white/40">Your target</p>
                  <p className="font-mono text-lg text-violet-300">
                    {scenario.prep_pack.your_target.toLocaleString("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    })}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-white/40">Walk away below</p>
                  <p className="font-mono text-lg text-white/80">
                    {scenario.prep_pack.your_reservation?.toLocaleString("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    })}
                  </p>
                </div>
              </div>
            )}
            <p className="text-xs text-white/35">
              These are your goals — the recruiter has their own, and they won&apos;t share them.
            </p>
          </section>
        </div>

        <div className="space-y-4">
          <div className="card space-y-4">
            <h2 className="font-semibold">Ready?</h2>
            <ul className="space-y-2 text-sm text-white/60">
              <li>🎧 Use headphones — prevents echo</li>
              <li>🎤 Your mic opens when the call starts</li>
              <li>⏱️ Sessions cap at 10 minutes</li>
              <li>🔒 The recruiter&apos;s budget is hidden — even from this page</li>
            </ul>
            <button className="btn btn-primary w-full" disabled={starting} onClick={() => void start()}>
              {starting ? (
                <>
                  <Spinner /> Preparing opponent…
                </>
              ) : (
                "Start the call"
              )}
            </button>
            {error && <p className="text-sm text-red-300">{error}</p>}
            <p className="text-xs text-white/40">
              Starting mints a fresh AI recruiter with secret numbers for this attempt only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
