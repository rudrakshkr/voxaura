"use client";

import { useState } from "react";

import { Spinner } from "./ui";

/**
 * Structured scenario builder.
 *
 * The old flow was one dropdown and one free-text box, which left the user
 * guessing what the generator would do with it. Every field here maps to a
 * concrete constraint the generator must honor, and anything left on "Any" is
 * left to the model.
 */

const INDUSTRIES = [
  "Any",
  "Big tech",
  "AI/ML startup",
  "Fintech",
  "Healthcare",
  "E-commerce",
  "Enterprise SaaS",
  "Gaming",
  "Consulting",
  "Nonprofit",
];

const SENIORITIES = [
  "Any",
  "Junior",
  "Mid-level",
  "Senior",
  "Staff",
  "Engineering Manager",
  "Director",
];

const STAGES = ["Any", "Seed", "Series A", "Series B", "Growth stage", "Public company"];

const STYLES = ["Any", "warm", "brisk", "poker-face", "combative", "avuncular"];

const LEVERAGE = [
  "Any",
  "None — no competing offer",
  "Strong track record but no competing offer",
  "A competing written offer",
  "Multiple competing offers",
];

const LEVERS = [
  "Base salary",
  "Equity",
  "Sign-on bonus",
  "Remote days",
  "Flexible start date",
  "Extra PTO",
];

interface FormState {
  role: string;
  seniority: string;
  industry: string;
  stage: string;
  persona_style: string;
  leverage: string;
  levers: string[];
  notes: string;
}

const EMPTY: FormState = {
  role: "",
  seniority: "Any",
  industry: "Any",
  stage: "Any",
  persona_style: "Any",
  leverage: "Any",
  levers: [],
  notes: "",
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function ScenarioBuilder({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function toggleLever(lever: string) {
    setForm((f) => ({
      ...f,
      levers: f.levers.includes(lever)
        ? f.levers.filter((l) => l !== lever)
        : [...f.levers, lever],
    }));
  }

  function surprise() {
    setForm({
      role: pick(["Backend Engineer", "Product Designer", "Data Scientist", "ML Engineer", "Engineering Manager", "DevOps Engineer", "Frontend Engineer", "Solutions Architect"]),
      seniority: pick(SENIORITIES.slice(1, 6)),
      industry: pick(INDUSTRIES.slice(1)),
      stage: pick(STAGES.slice(1)),
      persona_style: pick(STYLES.slice(1)),
      leverage: pick(LEVERAGE.slice(1)),
      levers: [pick(LEVERS), pick(LEVERS)].filter((v, i, a) => a.indexOf(v) === i),
      notes: "",
    });
    setError(null);
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    setLastCreated(null);
    try {
      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          difficulty,
          form: {
            role: form.role || undefined,
            seniority: form.seniority,
            industry: form.industry,
            stage: form.stage,
            persona_style: form.persona_style,
            leverage: form.leverage,
            levers: form.levers,
            notes: form.notes || undefined,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Generate failed (${res.status})`);
      }
      const data = (await res.json()) as { scenario?: { title?: string } };
      setLastCreated(data.scenario?.title ?? "New scenario");
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="card space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">Build a scenario</h2>
          <p className="mt-1 text-sm text-white/50">
            Every field becomes a real constraint the opponent must respect. Leave anything on{" "}
            <span className="text-white/70">Any</span> and the generator decides.
          </p>
        </div>
        <button className="btn btn-ghost shrink-0" onClick={surprise} disabled={generating}>
          🎲 Surprise me
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Role" hint="e.g. Backend Engineer, Product Designer">
          <input
            className="input"
            placeholder="Any role"
            value={form.role}
            maxLength={60}
            onChange={(e) => set("role", e.target.value)}
          />
        </Field>

        <Field label="Seniority">
          <select
            className="input"
            value={form.seniority}
            onChange={(e) => set("seniority", e.target.value)}
          >
            {SENIORITIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>

        <Field label="Industry">
          <select
            className="input"
            value={form.industry}
            onChange={(e) => set("industry", e.target.value)}
          >
            {INDUSTRIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>

        <Field label="Company stage">
          <select className="input" value={form.stage} onChange={(e) => set("stage", e.target.value)}>
            {STAGES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>

        <Field label="Recruiter personality">
          <select
            className="input"
            value={form.persona_style}
            onChange={(e) => set("persona_style", e.target.value)}
          >
            {STYLES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>

        <Field label="Your leverage">
          <select
            className="input"
            value={form.leverage}
            onChange={(e) => set("leverage", e.target.value)}
          >
            {LEVERAGE.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-white/40">
          Levers on the table
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {LEVERS.map((lever) => {
            const on = form.levers.includes(lever);
            return (
              <button
                key={lever}
                type="button"
                onClick={() => toggleLever(lever)}
                className={[
                  "rounded-full border px-3 py-1.5 text-xs transition",
                  on
                    ? "border-violet-400/60 bg-violet-500/20 text-violet-100"
                    : "border-white/15 text-white/60 hover:border-white/30",
                ].join(" ")}
              >
                {on ? "✓ " : ""}
                {lever}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-white/35">
          Anything you pick gets a real, non-zero range in the opponent&apos;s hidden band.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Anything else" hint="Optional scene-setting, e.g. “they&apos;re mid-reorg and the role is a backfill”">
          <input
            className="input"
            placeholder="Optional context"
            value={form.notes}
            maxLength={300}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/40">Difficulty</p>
          <div className="mt-2 flex gap-1 rounded-xl border border-white/10 p-1">
            {(["easy", "medium", "hard"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDifficulty(d)}
                className={[
                  "rounded-lg px-3 py-1.5 text-xs capitalize transition",
                  difficulty === d ? "bg-violet-500/30 text-white" : "text-white/50 hover:text-white/80",
                ].join(" ")}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
        <button className="btn btn-primary" disabled={generating} onClick={() => void generate()}>
          {generating ? (
            <>
              <Spinner /> Generating scenario…
            </>
          ) : (
            "Build this scenario"
          )}
        </button>
        <button className="btn btn-ghost" disabled={generating} onClick={() => setForm(EMPTY)}>
          Reset
        </button>
        {lastCreated && (
          <span className="text-sm text-emerald-300">Created “{lastCreated}”</span>
        )}
        {error && <span className="text-sm text-red-300">{error}</span>}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-white/40">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-white/30">{hint}</span>}
    </label>
  );
}
