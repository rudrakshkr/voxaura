"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Spinner } from "@/components/ui";
import type { ScenarioPublic } from "@/lib/types";

export default function Home() {
  const [scenarios, setScenarios] = useState<ScenarioPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [brief, setBrief] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/scenarios");
      const data = (await res.json()) as { scenarios?: ScenarioPublic[] };
      setScenarios(data.scenarios ?? []);
    } catch {
      setError("Could not load scenarios — is the database configured?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty, brief: brief || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Generate failed (${res.status})`);
      }
      setBrief("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

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
          A realistic AI recruiter calls you with an offer and hidden constraints. Negotiate out
          loud, in real time. When it ends, get a scored report on your anchoring, concessions, and
          composure — then run it again, harder.
        </p>
      </header>

      <section className="card space-y-4">
        <h2 className="font-semibold">Generate a new scenario</h2>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="input max-w-[180px]"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
          <input
            className="input max-w-md flex-1"
            placeholder="Optional steer: e.g. 'nonprofit, first job, pushy recruiter'"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={500}
          />
          <button
            className="btn btn-primary"
            disabled={generating}
            onClick={() => void generate()}
          >
            {generating ? (
              <>
                <Spinner /> Generating…
              </>
            ) : (
              "Generate scenario"
            )}
          </button>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Scenarios</h2>
          <Link href="/history" className="text-sm text-white/50 underline-offset-2 hover:underline">
            View attempt history →
          </Link>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-white/50">
            <Spinner /> Loading…
          </div>
        )}

        {!loading && scenarios.length === 0 && (
          <p className="text-sm text-white/40">
            No scenarios yet — generate your first one above, or run{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5">npm run seed</code>.
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {scenarios.map((s) => (
            <Link key={s.id} href={`/scenario/${s.id}`} className="card hover:border-violet-500/40">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-white/50">
                    {s.company} · {s.role} · {s.level}
                  </p>
                </div>
                <span className="badge">{s.difficulty}</span>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-white/60">{s.prep_pack.context}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
