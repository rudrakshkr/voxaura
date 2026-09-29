"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ScenarioBuilder } from "@/components/ScenarioBuilder";
import { ScenarioCard } from "@/components/ScenarioCard";
import { Spinner } from "@/components/ui";
import type { ScenarioPublic } from "@/lib/types";

type ScenarioListItem = ScenarioPublic & { attempt_count?: number };

export default function Home() {
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scenarios");
      // A non-2xx body is NOT an empty library. Rendering "No scenarios yet" for
      // a 500 told the user their data was gone when the server was simply down.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not load scenarios (${res.status})`);
      }
      const data = (await res.json()) as { scenarios?: ScenarioListItem[] };
      setScenarios(data.scenarios ?? []);
    } catch (err) {
      setError((err as Error).message || "Could not load scenarios — is the database configured?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-400">
          Voxaura
        </p>
        <h1 className="text-4xl font-bold leading-tight">
          Practice salary negotiation
          <br />
          against a voice that talks back.
        </h1>
        <p className="max-w-2xl text-white/60">
          Speak naturally with an adaptive recruiter who has a private budget, a real personality,
          and instructions to protect it. Push too hard and they hold firm. Bring real leverage and
          they counter. Then get evidence-based coaching on every move you made — and retry the
          same negotiation until you win it.
        </p>
      </header>

      <ScenarioBuilder onCreated={load} />

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            Your scenarios{" "}
            {scenarios.length > 0 && <span className="text-white/40">({scenarios.length})</span>}
          </h2>
          <Link href="/history" className="text-sm text-white/50 underline-offset-2 hover:underline">
            View attempt history →
          </Link>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-white/50">
            <Spinner /> Loading…
          </div>
        )}

        {error && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <span>{error}</span>
            <button className="btn btn-ghost" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && scenarios.length === 0 && (
          <p className="text-sm text-white/40">
            No scenarios yet — build your first one above, or run{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5">npm run seed</code>.
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {scenarios.map((s) => (
            <ScenarioCard
              key={s.id}
              scenario={s}
              attemptCount={s.attempt_count ?? null}
              onChanged={load}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
