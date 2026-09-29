import { handle } from "@/lib/api";
import { getAttempt, getReport, listEvents } from "@/lib/db/queries";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";

export const dynamic = "force-dynamic";

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ownerId = await readOwnerId();
    assertAttemptAccess(await getAttempt(id), ownerId, "read");
    const report = await getReport(id);
    const events = await listEvents(id);
    return Response.json({
      report: {
        overall_score: report.overall_score,
        rubric: report.rubric ?? [],
        strengths: report.strengths ?? [],
        improvements: report.improvements ?? [],
        summary: report.summary,
        communication: report.communication ?? null,
        // Provenance of the scored transcript: the report page labels a
        // client-only recovery instead of presenting it as the recorded call.
        transcript_source: report.transcript_source ?? null,
        transcript: report.transcript ?? [],
        events: events.map((e) => ({
          type: e.type,
          actor: e.actor,
          source: e.source,
          impact: e.impact,
          payload: e.payload,
          at_ms: e.at_ms,
          seq: e.seq,
          /**
           * True for moves a SERVER rule classified (the canonical record);
           * false for client annotations and scorer-recovered duplicates, which
           * are shown but are not scoring evidence.
           */
          authoritative: e.authoritative,
        })),
      },
    });
  },
);
