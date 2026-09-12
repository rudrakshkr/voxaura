import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { getAttempt, insertEvents, listEvents } from "@/lib/db/queries";
import { MoveTypeEnum } from "@/lib/db/schema";
import { BatchedEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  session_id: z.string().min(1).nullish(),
  events: z.array(BatchedEvent).max(200),
});

export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid events payload");

    const attempt = await getAttempt(id);
    if (attempt.status !== "active") {
      throw new ApiError(409, "Attempt is no longer active");
    }

    if (body.data.session_id) {
      const { setAttemptSession } = await import("@/lib/db/queries");
      await setAttemptSession(id, body.data.session_id);
    }

    const inserted = await insertEvents(id, body.data.events);
    return Response.json({ inserted });
  },
);

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await getAttempt(id);
    const events = await listEvents(id);
    return Response.json({
      events: events.map((e) => ({
        type: e.type as (typeof MoveTypeEnum)[number],
        actor: e.actor,
        source: e.source,
        payload: e.payload,
        at_ms: e.at_ms,
        seq: e.seq,
      })),
    });
  },
);
