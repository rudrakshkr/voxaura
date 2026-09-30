import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  countActiveAttemptsForScenario,
  countScenarioAttempts,
  deleteScenario,
  getScenario,
  toPublicScenario,
  updateScenario,
} from "@/lib/db/queries";
import { assertScenarioAccess, readOwnerId } from "@/lib/ownership";
import { takeScenarioMutationSlot } from "@/lib/rate-limit";
import { mergePrepPack, prepPackError } from "@/lib/scenario-prep";
import { Difficulty } from "@/lib/types";
import type { PrepPack } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * One scenario.
 *
 * Owner-scoped, like every other row in the product: a custom scenario belongs
 * to its creator and a foreign id 404s rather than confirming that it exists.
 * The sample library is the public exception — readable by anyone, and (since it
 * is the material the product ships with) editable and deletable by anyone too.
 * Without this scoping the id was the whole permission — anyone who could list
 * the library could read any scenario's prep pack (`context`, the coaching
 * objective, the candidate's own target and walk-away number).
 */
export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ownerId = await readOwnerId();
    const row = await getScenario(id);
    assertScenarioAccess(row, ownerId, "read");
    const attempt_count = await countScenarioAttempts(id, ownerId);
    return Response.json({ scenario: toPublicScenario(row), attempt_count });
  },
);

/**
 * Only the candidate-facing material is editable. The company's budget,
 * floor and target stay server-side — editing them from a browser would put
 * the hidden state in the client, which is the one thing this product must
 * never do.
 */
const PatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  company: z.string().min(1).max(80).optional(),
  role: z.string().min(1).max(80).optional(),
  level: z.string().min(1).max(40).optional(),
  difficulty: Difficulty.optional(),
  prep_pack: z
    .object({
      context: z.string().min(1).max(800),
      coaching_objective: z.string().min(1).max(500),
      comp_notes: z.array(z.string().min(1).max(200)).min(1).max(8),
      your_target: z.number().int().min(60000).max(900000),
      your_reservation: z.number().int().min(60000).max(900000),
    })
    .partial()
    .optional(),
});

/**
 * Partial edit of the candidate-facing material.
 *
 * Access is decided FIRST (so a foreign id 404s whether or not the payload is
 * valid), and validation runs against the MERGED result rather than against the
 * fields present in the request: a partial write that leaves the stored row
 * invalid is refused, not persisted. Fixing only the field-by-field check left
 * `PATCH {your_target: 100000}` on a row whose `your_reservation` was 150000
 * happily stored a walk-away floor above the goal.
 */
export const PATCH = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid scenario update");

    const ownerId = await readOwnerId();
    const current = await getScenario(id);
    assertScenarioAccess(current, ownerId, "write");
    if (!takeScenarioMutationSlot(ownerId ?? "anonymous")) {
      throw new ApiError(429, "Too many scenario edits in a row.");
    }

    if (body.data.prep_pack) {
      // Validate the state the row would END in, not the fragment that arrived.
      const merged = mergePrepPack(current.prep_pack as PrepPack, body.data.prep_pack);
      const problem = prepPackError(merged);
      if (problem) throw new ApiError(400, problem);
    }

    const row = await updateScenario(id, body.data);
    return Response.json({ scenario: toPublicScenario(row) });
  },
);

export const DELETE = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // Deleting a scenario cascades to its attempts, events and reports, so it is
    // owner-only. Without this, any anonymous visitor could wipe the library
    // (and with it every recorded negotiation) just by listing ids.
    const ownerId = await readOwnerId();
    assertScenarioAccess(await getScenario(id), ownerId);
    if (!takeScenarioMutationSlot(ownerId ?? "anonymous")) {
      throw new ApiError(429, "Too many scenario changes in a row.");
    }
    // A live call holds a foreign key to this scenario and the delete cascades
    // to its attempts, events and reports. Deleting mid-call would destroy the
    // call in progress and the history it belongs to, so it is refused with a
    // message that says why — the user can finish or abandon the call first.
    const live = await countActiveAttemptsForScenario(id);
    if (live > 0) {
      throw new ApiError(
        409,
        `This scenario has ${live} call${live === 1 ? "" : "s"} in progress. Finish or abandon ${live === 1 ? "it" : "them"} before deleting the scenario.`,
      );
    }
    const removed = await deleteScenario(id);
    if (removed === 0) throw new ApiError(404, "Scenario not found");
    return Response.json({ deleted: true });
  },
);
