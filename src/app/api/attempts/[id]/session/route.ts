import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  bindAttemptSessionTx,
  findAttemptIdBySessionTx,
  loadAttemptWithScenarioTx,
  withAttemptLock,
} from "@/lib/db/queries";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";
import { decideSessionBinding } from "@/lib/session-binding";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  session_id: z.string().min(1).max(200),
  /**
   * The session this attempt is CURRENTLY bound to. Required to reconnect to a
   * new session, and it is what makes the rebind intentional rather than
   * "whatever the browser sent": a caller can only move the binding if it knows
   * the one it is moving away from.
   */
  previous_session_id: z.string().min(1).max(200).nullish(),
});

/**
 * Bind (or deliberately re-bind) the attempt's recorded voice session.
 *
 * The client calls this the moment the voice service reports `session.ready`.
 * `/events` can also establish the first bind, but only this endpoint may move
 * an existing binding, and only with proof of the current one.
 */
export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid session payload");

    const ownerId = await readOwnerId();

    const result = await withAttemptLock(id, async (tx) => {
      const { attempt } = await loadAttemptWithScenarioTx(tx, id);
      assertAttemptAccess(attempt, ownerId, "write");
      if (attempt.status !== "active") {
        throw new ApiError(409, "Attempt is no longer active");
      }

      const ownerOfRequested =
        attempt.session_id === body.data.session_id
          ? id
          : await findAttemptIdBySessionTx(tx, body.data.session_id);
      const decision = decideSessionBinding({
        attemptId: id,
        stored: attempt.session_id,
        requested: body.data.session_id,
        ownerOfRequested,
        allowRebind: true,
        previousSessionId: body.data.previous_session_id ?? null,
      });
      if (decision.kind === "conflict") throw new ApiError(409, decision.message);
      if (decision.kind === "bind") await bindAttemptSessionTx(tx, id, decision.sessionId);
      return { session_id: body.data.session_id, bound: decision.kind === "bind" };
    });

    return Response.json(result);
  },
);