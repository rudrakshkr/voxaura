import { handle } from "@/lib/api";
import { listHistory } from "@/lib/db/queries";
import { scheduleStaleAttemptReclaim } from "@/lib/db/reclaim";
import { readOwnerId } from "@/lib/ownership";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  // Retire attempts whose tab was closed mid-call. Throttled and best-effort —
  // a sweep failure must never break the history page.
  scheduleStaleAttemptReclaim();
  // Scoped to the caller: a shared link or a guessed id must not expose another
  // visitor's attempts, scores or scenario history.
  const rows = await listHistory(await readOwnerId());
  return Response.json({
    history: rows.map((r) => ({
      attempt_id: r.attempt.id,
      scenario_title: r.scenarioTitle,
      scenario_id: r.attempt.scenario_id,
      status: r.attempt.status,
      outcome: r.attempt.outcome,
      retry_mode: r.attempt.retry_mode,
      final_base: r.attempt.final_offer?.base ?? null,
      score: r.score,
      previous_score: r.previousScore,
      /** Public sample-library row, shown labeled rather than as the user's own. */
      is_demo: r.isDemo,
      started_at: r.attempt.started_at.toISOString(),
    })),
  });
});
