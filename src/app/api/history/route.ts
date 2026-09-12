import { handle } from "@/lib/api";
import { listHistory } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const rows = await listHistory();
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
      started_at: r.attempt.started_at.toISOString(),
    })),
  });
});
