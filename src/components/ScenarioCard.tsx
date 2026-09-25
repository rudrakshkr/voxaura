"use client";

import { useState } from "react";
import Link from "next/link";

import { Spinner } from "./ui";
import type { Difficulty, ScenarioPublic } from "@/lib/types";

interface Draft {
  title: string;
  company: string;
  role: string;
  level: string;
  difficulty: Difficulty;
  context: string;
  coaching_objective: string;
  comp_notes: string;
  your_target: number;
  your_reservation: number;
}

function toDraft(s: ScenarioPublic): Draft {
  return {
    title: s.title,
    company: s.company,
    role: s.role,
    level: s.level,
    difficulty: s.difficulty,
    context: s.prep_pack.context,
    coaching_objective: s.prep_pack.coaching_objective,
    comp_notes: s.prep_pack.comp_notes.join("\n"),
    your_target: s.prep_pack.your_target,
    your_reservation: s.prep_pack.your_reservation,
  };
}

/**
 * A scenario in the library, with the actions the owner actually needs:
 * fix a detail or remove it. Deleting cascades to its attempts and reports, so
 * the confirm step says how many go with it.
 */
export function ScenarioCard({
  scenario,
  attemptCount,
  onChanged,
}: {
  scenario: ScenarioPublic;
  /** Only known after the edit panel is opened; shown in the delete warning. */
  attemptCount?: number | null;
  onChanged: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(scenario));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (draft.your_reservation >= draft.your_target) {
        throw new Error("Walk-away number must be below your target");
      }
      const res = await fetch(`/api/scenarios/${scenario.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          company: draft.company,
          role: draft.role,
          level: draft.level,
          difficulty: draft.difficulty,
          prep_pack: {
            context: draft.context,
            coaching_objective: draft.coaching_objective,
            comp_notes: draft.comp_notes
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            your_target: draft.your_target,
            your_reservation: draft.your_reservation,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenarios/${scenario.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Delete failed (${res.status})`);
      }
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3">
      <Link href={`/scenario/${scenario.id}`} className="group">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold group-hover:text-violet-200">{scenario.title}</h3>
            <p className="mt-1 text-sm text-white/50">
              {scenario.company} · {scenario.role} · {scenario.level}
            </p>
          </div>
          <span className="badge">{scenario.difficulty}</span>
        </div>
        <p className="mt-3 line-clamp-2 text-sm text-white/60">{scenario.prep_pack.context}</p>
      </Link>

      <div className="mt-auto flex items-center gap-2 border-t border-white/10 pt-3">
        <Link href={`/scenario/${scenario.id}`} className="btn btn-primary flex-1 text-sm">
          Start call
        </Link>
        <button
          className="btn btn-ghost text-sm"
          disabled={busy}
          onClick={() => {
            setDraft(toDraft(scenario));
            setError(null);
            setEditing(true);
          }}
        >
          Edit
        </button>
        <button
          className="btn btn-ghost text-sm text-red-300"
          disabled={busy}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Delete
        </button>
      </div>

      {error && !editing && <p className="text-xs text-red-300">{error}</p>}

      {confirming && (
        <Modal title="Delete this scenario?" onClose={() => setConfirming(false)}>
          <p className="text-sm text-white/70">
            <span className="font-semibold text-white">{scenario.title}</span> will be removed from
            your library
            {attemptCount != null && attemptCount > 0
              ? `, along with ${attemptCount} attempt${attemptCount === 1 ? "" : "s"} and ${attemptCount === 1 ? "its report" : "their reports"}`
              : ""}
            . This cannot be undone.
          </p>
          {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
              {busy ? <Spinner /> : "Delete scenario"}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="Edit scenario" onClose={() => setEditing(false)} wide>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <input
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </Field>
            <Field label="Company">
              <input
                className="input"
                value={draft.company}
                onChange={(e) => setDraft({ ...draft, company: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <input
                className="input"
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              />
            </Field>
            <Field label="Level">
              <input
                className="input"
                value={draft.level}
                onChange={(e) => setDraft({ ...draft, level: e.target.value })}
              />
            </Field>
            <Field label="Difficulty">
              <select
                className="input"
                value={draft.difficulty}
                onChange={(e) => setDraft({ ...draft, difficulty: e.target.value as Difficulty })}
              >
                <option value="easy">easy</option>
                <option value="medium">medium</option>
                <option value="hard">hard</option>
              </select>
            </Field>
            <Field label="Your target (USD)">
              <input
                className="input"
                type="number"
                value={draft.your_target}
                onChange={(e) => setDraft({ ...draft, your_target: Number(e.target.value) })}
              />
            </Field>
            <Field label="Walk away below (USD)">
              <input
                className="input"
                type="number"
                value={draft.your_reservation}
                onChange={(e) => setDraft({ ...draft, your_reservation: Number(e.target.value) })}
              />
            </Field>
          </div>

          <Field label="The situation" className="mt-4">
            <textarea
              className="input min-h-[80px]"
              value={draft.context}
              onChange={(e) => setDraft({ ...draft, context: e.target.value })}
            />
          </Field>
          <Field label="Coaching objective" className="mt-4">
            <textarea
              className="input min-h-[70px]"
              value={draft.coaching_objective}
              onChange={(e) => setDraft({ ...draft, coaching_objective: e.target.value })}
            />
          </Field>
          <Field label="Compensation components" hint="One per line" className="mt-4">
            <textarea
              className="input min-h-[90px]"
              value={draft.comp_notes}
              onChange={(e) => setDraft({ ...draft, comp_notes: e.target.value })}
            />
          </Field>

          <p className="mt-3 text-xs text-white/35">
            The recruiter&apos;s budget, floor and target are not editable here — they never leave
            the server, which is what keeps the scenario honest.
          </p>

          {error && <p className="mt-2 text-sm text-red-300">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? <Spinner /> : "Save changes"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 py-10">
      <div
        className={[
          "card w-full space-y-3",
          wide ? "max-w-2xl" : "max-w-md",
        ].join(" ")}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{title}</h3>
          <button className="text-white/40 hover:text-white" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={["block", className ?? ""].join(" ")}>
      <span className="text-xs font-semibold uppercase tracking-wide text-white/40">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-white/30">{hint}</span>}
    </label>
  );
}
