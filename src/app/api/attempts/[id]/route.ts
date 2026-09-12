import { handle } from "@/lib/api";
import {
  getAttemptWithScenario,
  getReport,
  toPublicScenario,
} from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { attempt, scenario } = await getAttemptWithScenario(id);
    let score: number | null = null;
    try {
      const report = await getReport(id);
      score = report.overall_score;
    } catch {
      score = null;
    }
    return Response.json({
      attempt: {
        id: attempt.id,
        scenario_id: attempt.scenario_id,
        status: attempt.status,
        outcome: attempt.outcome,
        final_offer: attempt.final_offer,
        retry_mode: attempt.retry_mode,
        started_at: attempt.started_at.toISOString(),
        ended_at: attempt.ended_at?.toISOString() ?? null,
      },
      scenario: toPublicScenario(scenario),
      score,
    });
  },
);
