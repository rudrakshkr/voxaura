import { ApiError, handle } from "@/lib/api";
import { agentPromptFor } from "@/lib/ai/generate";
import { buildGreeting } from "@/lib/ai/prompts";
import { getAttemptWithScenario } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { hydrateAttempt } from "@/lib/negotiation";

export const dynamic = "force-dynamic";

/**
 * Debug path only (ALLOW_INLINE_AGENT=1): returns the inline session config.
 * In the default stored-agent mode the prompt never leaves the server and this
 * route refuses to serve anything.
 */
export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    if (!env().ALLOW_INLINE_AGENT) {
      throw new ApiError(403, "Inline agent mode is disabled");
    }
    const { id } = await ctx.params;
    const { attempt, scenario } = await getAttemptWithScenario(id);
    const { effectiveHidden } = hydrateAttempt(attempt, scenario);
    return Response.json({
      system_prompt: agentPromptFor(effectiveHidden, {
        company: scenario.company,
        role: scenario.role,
        level: scenario.level,
        context: (scenario.prep_pack as { context?: string }).context ?? null,
      }),
      greeting: buildGreeting(effectiveHidden, {
        company: scenario.company,
        role: scenario.role,
        level: scenario.level,
      }),
    });
  },
);
