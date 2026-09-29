import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  bindAttemptSessionTx,
  findAttemptIdBySessionTx,
  getAttempt,
  insertEventsTx,
  listEvents,
  loadAttemptWithScenarioTx,
  withAttemptLock,
} from "@/lib/db/queries";
import { CLIENT_REPORTABLE_EVENTS, MoveTypeEnum } from "@/lib/db/schema";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";
import { decideSessionBinding } from "@/lib/session-binding";
import {
  BatchedEvent,
  capEventPayload,
  MAX_EVENT_BATCH_CHARS,
  MAX_EVENTS_PER_REQUEST,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  session_id: z.string().min(1).max(200).nullish(),
  events: z.array(BatchedEvent).max(MAX_EVENTS_PER_REQUEST),
});

const CLIENT_REPORTABLE = new Set<string>(CLIENT_REPORTABLE_EVENTS);

/**
 * Append client-observed negotiation events.
 *
 * This used to accept any event in the taxonomy, from any actor, with any
 * source — so a browser could POST an `opponent_offer` the panel then displayed
 * as fact, or an `acceptance` that made an agreed deal out of nothing, or an
 * `llm_extract` event the scorer treated as recovered evidence.
 *
 * Now the client may only report what it legitimately observed — the
 * CANDIDATE's own moves — with the actor forced to `user` and the source forced
 * to `tool`. Everything about the opponent is written by the server, in the
 * route that owns that economics.
 *
 * The whole decision runs INSIDE the per-attempt lock, status check included.
 * Reading the status outside it left a real window: a late batch could see
 * `active`, wait while a concurrent `/complete` took the completion barrier and
 * wrote its report, and then append to a call that had already been scored —
 * leaving the report and the replay disagreeing about the same conversation.
 *
 * These events are stored with `authoritative: false`: what the candidate did is
 * recorded canonically by `/turn` (the server classifier), so a client
 * annotation is UI/replay material and never independent scoring evidence. A
 * fabricated `log_user_move` therefore cannot move the score.
 */
export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid events payload");

    // Bound the TOTAL payload, not just each item: 200 events inside the
    // per-field caps can still be megabytes, and that blob would be persisted
    // and rendered.
    const batchChars = JSON.stringify(body.data.events).length;
    if (batchChars > MAX_EVENT_BATCH_CHARS) {
      throw new ApiError(413, "Event batch too large");
    }

    const ownerId = await readOwnerId();

    const accepted: typeof body.data.events = [];
    const rejected: string[] = [];
    for (const e of body.data.events) {
      // A client may report what the CANDIDATE did — nothing else. An event
      // claiming actor "opponent" is an assertion about the other side, which
      // only the server may make (it owns that economics); rewriting it to
      // "user" instead of refusing would store a claim the client never made and
      // log a concession by the wrong party.
      if (e.actor !== "user") {
        rejected.push(`${e.type}(actor=${e.actor})`);
        continue;
      }
      if (!CLIENT_REPORTABLE.has(e.type) || !MoveTypeEnum.includes(e.type)) {
        rejected.push(e.type);
        continue;
      }
      // Payload is client-supplied, so it is bounded like any other untrusted
      // input: without this a single POST could write an arbitrarily large blob
      // into the durable event log (and into the report that renders it).
      // `source` is forced to "tool": `llm_extract` is a server-only provenance
      // marker for evidence the scorer recovered, and a client must not be able
      // to claim it.
      accepted.push({ ...e, source: "tool", payload: capEventPayload(e.payload) });
    }

    const inserted = await withAttemptLock(id, async (tx) => {
      const { attempt } = await loadAttemptWithScenarioTx(tx, id);
      // Writing: a sample attempt is readable by anyone and writable by no one.
      assertAttemptAccess(attempt, ownerId, "write");
      if (attempt.status !== "active") {
        throw new ApiError(409, "Attempt is no longer active");
      }
      if (body.data.session_id) {
        // A batch may establish the FIRST session bind, but it may never swap
        // one: the transcript `/complete` fetches comes from whatever session is
        // recorded here. Reconnects go through the explicit `/session`
        // endpoint, which must know the current session id.
        const ownerOfRequested =
          attempt.session_id === body.data.session_id
            ? id
            : await findAttemptIdBySessionTx(tx, body.data.session_id);
        const decision = decideSessionBinding({
          attemptId: id,
          stored: attempt.session_id,
          requested: body.data.session_id,
          ownerOfRequested,
          allowRebind: false,
        });
        if (decision.kind === "conflict") throw new ApiError(409, decision.message);
        if (decision.kind === "bind") await bindAttemptSessionTx(tx, id, decision.sessionId);
      }
      // `dedupe` is what makes a retry safe: the client re-sends a batch whose
      // response was lost, and the server must not record the same move twice.
      // Not authoritative: `/turn` owns the canonical record of candidate moves.
      return accepted.length > 0
        ? insertEventsTx(tx, id, accepted, { dedupe: true, authoritative: false })
        : 0;
    });

    if (rejected.length > 0) {
      console.warn(
        `[events] rejected ${rejected.length} non-client-reportable event(s) for attempt ${id}:`,
        [...new Set(rejected)].join(", "),
      );
    }

    return Response.json({
      inserted,
      rejected: rejected.length,
      duplicates: accepted.length - inserted,
      authoritative: false,
    });
  },
);

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ownerId = await readOwnerId();
    const attempt = await getAttempt(id);
    assertAttemptAccess(attempt, ownerId, "read");
    const events = await listEvents(id);
    return Response.json({
      events: events.map((e) => ({
        type: e.type as (typeof MoveTypeEnum)[number],
        actor: e.actor,
        source: e.source,
        impact: e.impact,
        payload: e.payload,
        at_ms: e.at_ms,
        seq: e.seq,
        /** True for server-classified moves; false for client annotations. */
        authoritative: e.authoritative,
      })),
    });
  },
);