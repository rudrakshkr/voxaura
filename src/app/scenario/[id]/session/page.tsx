"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import { VoiceSession } from "@/components/VoiceSession";
import { Spinner } from "@/components/ui";
import type { ScenarioPublic } from "@/lib/types";

interface AttemptDetail {
  attempt: {
    id: string;
    status: string;
    retry_mode: string | null;
    agent_mode: "stored" | "inline";
    agent_id: string | null;
    greeting?: string;
    /** Server-recorded start, so the call clock is absolute across reconnects. */
    started_at?: string;
  };
  /** Server-authoritative standing package (already stated aloud). */
  current_offer?: { base: number; sign_on?: number | null; equity?: number | null } | null;
  scenario: ScenarioPublic;
}

/**
 * The call screen.
 *
 * The URL carries only the attempt identifier. Agent mode and stored-agent binding
 * come from the server-side attempt row so the browser cannot override them with
 * query parameters. Inline mode fetches its prompt from an owner-checked endpoint
 * immediately before the call starts.
 */
export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const attemptId = params.get("attempt");

  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [inlineConfig, setInlineConfig] = useState<{
    systemPrompt: string;
    greeting: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!attemptId) {
      setError("Missing attempt reference");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/attempts/${attemptId}`);
        if (!res.ok) throw new Error("Attempt not found");
        const data = (await res.json()) as AttemptDetail;
        if (!alive) return;
        setDetail(data);

        if (data.attempt.agent_mode === "inline") {
          const cfgRes = await fetch(`/api/attempts/${attemptId}/agent-config`);
          if (!cfgRes.ok) {
            throw new Error(
              "This call's opponent configuration is unavailable. Start a fresh attempt from the prep page.",
            );
          }
          const cfg = (await cfgRes.json()) as { system_prompt?: string; greeting?: string };
          if (!cfg.system_prompt) throw new Error("Opponent configuration was empty.");
          if (!alive) return;
          setInlineConfig({
            systemPrompt: cfg.system_prompt,
            greeting:
              cfg.greeting ??
              data.attempt.greeting ??
              "Hi, thanks for taking my call — I want to walk through the offer with you. Ready when you are.",
          });
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
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

  if (!detail || !ready || (detail.attempt.agent_mode === "inline" && !inlineConfig)) {
    return (
      <div className="flex items-center gap-2 text-white/50">
        <Spinner /> Loading call…
      </div>
    );
  }

  const mode = detail.attempt.agent_mode;
  const agentId = detail.attempt.agent_id;
  const blocked =
    detail.attempt.status === "abandoned" ||
    (mode === "stored" && !agentId);

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

  return (
    <VoiceSession
      key={attemptId ?? "attempt"}
      attemptId={attemptId ?? ""}
      agentId={agentId}
      agentMode={mode}
      inlineConfig={inlineConfig}
      scenario={detail.scenario}
      retryMode={detail.attempt.retry_mode}
      initialOffer={detail.current_offer ?? null}
      startedAtMs={
        detail.attempt.started_at ? new Date(detail.attempt.started_at).getTime() : null
      }
    />
  );
}