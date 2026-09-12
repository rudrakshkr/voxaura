"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import { VoiceSession } from "@/components/VoiceSession";
import { Spinner } from "@/components/ui";
import type { ScenarioPublic } from "@/lib/types";

interface AttemptDetail {
  attempt: { id: string; status: string; retry_mode: string | null };
  scenario: ScenarioPublic;
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const attemptId = params.get("attempt");
  const mode = (params.get("mode") ?? "stored") as "stored" | "inline";
  const agentIdParam = params.get("agent") || null;

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

  return (
    <VoiceSession
      key={attemptId ?? "attempt"}
      attemptId={attemptId ?? ""}
      // The stored agent_id is an opaque reference — the hidden prompt lives
      // server-side and never reaches the browser. Inline mode fetches config
      // from the debug endpoint and is disabled unless ALLOW_INLINE_AGENT=1.
      agentId={agentIdParam}
      agentMode={mode}
      scenario={detail.scenario}
      retryMode={detail.attempt.retry_mode}
    />
  );
}
