import { handle } from "@/lib/api";
import { getReport, listEvents } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const report = await getReport(id);
    const events = await listEvents(id);
    return Response.json({
      report: {
        overall_score: report.overall_score,
        rubric: report.rubric ?? [],
        strengths: report.strengths ?? [],
        improvements: report.improvements ?? [],
        summary: report.summary,
        transcript: report.transcript ?? [],
        events: events.map((e) => ({
          type: e.type,
          actor: e.actor,
          source: e.source,
          payload: e.payload,
          at_ms: e.at_ms,
          seq: e.seq,
        })),
      },
    });
  },
);
