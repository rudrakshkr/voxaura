import { handle } from "@/lib/api";
import { getScenario, toPublicScenario } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const row = await getScenario(id);
    return Response.json({ scenario: toPublicScenario(row) });
  },
);
