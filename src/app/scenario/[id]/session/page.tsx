"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import { VoiceSession } from "@/components/VoiceSession";
import { Spinner } from "@/components/ui";
import type { ScenarioPublic } from "@/lib/types";

interface AttemptDetail {
  attempt: { id: string; status: string; retry_mode: string | null; greeting?: string };
  scenario: ScenarioPublic & { prep_pack: ScenarioPublic["prep_pack"] & { system_prompt?: string; greeting?: string } };
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const attemptId = params.get("attempt");
  const mode = (params.get("mode") ?? "stored") as "stored" | "inline";
  const agentIdParam = params.get("agent") || null;
  const promptParam = params.get("prompt") || null;
  const greetingParam = params.get("greeting") || null;

  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!attemptId) {
      setError("Missing attempt reference");
      return;
    }
    fetch(`/api/attempts/${attemptId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Attempt not found");
        const data = (await res.json()) as AttemptDetail;
        setDetail(data);
      })
      .catch((err) => setError((err as Error).message));
  }, [attemptId]);

  // Inline mode is always usable: it carries the prompt in the session
  // config, so no server-side stored agent is required. This is the fallback
  // path when stored-agent mode can't resolve the agent from the client IP.
  const blocked =
    !!detail &&
    (mode === "stored"
      ? !agentIdParam || detail.attempt.status === "abandoned"
      : !attemptId);

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-red-300">{error}</p>
        <Link href={`/scenario/${id}`} className="btn btn-ghost">
          ← Back to prep
        </Link>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center gap-2 text-white/50">
        <Spinner /> Loading call…
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          This attempt isn&apos;t ready for a live call. The opponent may have been deleted or the
          session link is stale — go back and start a fresh one.
        </div>
        <Link href={`/scenario/${id}`} className="btn btn-ghost">
          ← Back to prep
        </Link>
      </div>
    );
  }

  // Build inline config after the blocked check (detail is guaranteed non-null
  // here). The greeting is resolved from the attempt detail (server-derived from
  // the attempt's own hidden state), then the URL, then the scenario. An empty
  // greeting is never sent: the agent would stay silent and the user would be
  // left talking into a dead line.
  const greeting =
    detail.attempt.greeting ??
    greetingParam ??
    detail.scenario.prep_pack.greeting ??
    "Hi, thanks for taking my call — I want to walk through the offer with you. Ready when you are.";
  const inlineConfig =
    mode === "inline" && promptParam
      ? ({ systemPrompt: promptParam, greeting } as const)
      : null;

  return (
    <VoiceSession
      key={attemptId ?? "attempt"}
      attemptId={attemptId ?? ""}
      agentId={agentIdParam}
      agentMode={mode}
      inlineConfig={inlineConfig}
      scenario={detail.scenario}
      retryMode={detail.attempt.retry_mode}
    />
  );
}
