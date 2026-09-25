import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  countScenarioAttempts,
  deleteScenario,
  getScenario,
  toPublicScenario,
  updateScenario,
} from "@/lib/db/queries";
import { Difficulty } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const row = await getScenario(id);
    const attempt_count = await countScenarioAttempts(id);
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

export const PATCH = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid scenario update");
    if (
      body.data.prep_pack?.your_target != null &&
      body.data.prep_pack?.your_reservation != null &&
      body.data.prep_pack.your_reservation >= body.data.prep_pack.your_target
    ) {
      throw new ApiError(400, "Walk-away number must be below your target");
    }
    const row = await updateScenario(id, body.data);
    return Response.json({ scenario: toPublicScenario(row) });
  },
);

export const DELETE = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const removed = await deleteScenario(id);
    if (removed === 0) throw new ApiError(404, "Scenario not found");
    return Response.json({ deleted: true });
  },
);
