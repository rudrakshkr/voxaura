import { handle } from "@/lib/api";
import { buildGreeting } from "@/lib/ai/prompts";
import {
  getAttemptWithScenario,
  getReport,
  toPublicScenario,
} from "@/lib/db/queries";
import { hiddenOf } from "@/lib/negotiation";

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
    // The opening line is derived from the attempt's own hidden state, so the
    // session can rebuild it server-side. Without this, inline calls reached the
    // agent with an empty greeting and the recruiter never opened the
    // conversation. It contains only the persona's name — no confidential
    // numbers — so it is safe to send to the browser.
    const hidden = attempt.effective_hidden ?? hiddenOf(scenario);
    return Response.json({
      attempt: {
        id: attempt.id,
        scenario_id: attempt.scenario_id,
        status: attempt.status,
        outcome: attempt.outcome,
        final_offer: attempt.final_offer,
        retry_mode: attempt.retry_mode,
        greeting: buildGreeting(hidden),
        started_at: attempt.started_at.toISOString(),
        ended_at: attempt.ended_at?.toISOString() ?? null,
      },
      scenario: toPublicScenario(scenario),
      score,
    });
  },
);
