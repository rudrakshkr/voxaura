import { ApiError, handle } from "@/lib/api";
import { agentPromptFor } from "@/lib/ai/generate";
import { buildGreeting } from "@/lib/ai/prompts";
import { getAttemptWithScenario, snapshotForAttempt } from "@/lib/db/queries";
import { hydrateAttempt } from "@/lib/negotiation";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";

export const dynamic = "force-dynamic";

/**
 * Inline session config, served to the browser that owns the attempt.
 *
 * Two independent gates, both deliberate:
 *  - mode: `AGENT_MODE`/`ALLOW_INLINE_AGENT` must actually put this deployment in
 *    inline mode. In stored mode nothing here is served, so the prompt has no
 *    route off the server at all.
 *  - ownership: the prompt is per-attempt material; only the attempt's owner may
 *    fetch it.
 *
 * The prompt contains no hidden economics (budget/floor/target never appear in
 * it), but it is still a server artifact and is treated as one. Note this is a
 * POST-free GET that the session page calls itself — the config is never placed
 * in a URL, where it would land in history, logs and referrers.
 */
export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ownerId = await readOwnerId();
    const { attempt, scenario } = await getAttemptWithScenario(id);
    // Read: the prompt carries no hidden economics, and it is already handed to
    // anyone who starts their own attempt on the scenario.
    assertAttemptAccess(attempt, ownerId, "read");
    if (attempt.agent_mode !== "inline") {
      throw new ApiError(403, "This attempt is not configured for inline mode.");
    }
    if (attempt.status !== "active") {
      throw new ApiError(409, "Attempt is no longer active.");
    }
    const { effectiveHidden } = hydrateAttempt(attempt, scenario);
    // The attempt's frozen snapshot, not the live row: the prompt must describe
    // the scenario this call was created with.
    const snapshot = snapshotForAttempt(attempt, scenario);
    return Response.json({
      system_prompt: agentPromptFor(effectiveHidden, {
        company: snapshot.company,
        role: snapshot.role,
        level: snapshot.level,
        context: snapshot.prep_pack?.context ?? null,
      }),
      greeting: buildGreeting(effectiveHidden, {
        company: snapshot.company,
        role: snapshot.role,
        level: snapshot.level,
      }),
    });
  },
);