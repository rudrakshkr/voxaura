import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { OPPONENT_TOOLS } from "@/lib/ai/tools";
import { agentPromptFor, deriveVariant } from "@/lib/ai/generate";
import { buildGreeting } from "@/lib/ai/prompts";
import { createAgent, deleteAgent } from "@/lib/assemblyai/agents";
import { createAttempt, getScenario } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { hiddenOf } from "@/lib/negotiation";
import { Difficulty } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  scenario_id: z.string().uuid(),
  retry_mode: z.enum(["harder", "reroll"]).nullish(),
});

export const POST = handle(async (req: Request) => {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "scenario_id and optional retry_mode required");

  const scenario = await getScenario(body.data.scenario_id);
  const base = hiddenOf(scenario);
  const effectiveHidden = body.data.retry_mode
    ? deriveVariant(base, { harder: body.data.retry_mode === "harder", reRoll: body.data.retry_mode === "reroll" })
    : base;

  const attempt = await createAttempt(scenario.id, {
    effectiveHidden,
    retryMode: body.data.retry_mode ?? null,
  });

  let agentId: string | null = null;
  let agentMode: "stored" | "inline" = "stored";

  try {
    if (env().ALLOW_INLINE_AGENT) {
      // Debug path: send the prompt inline (visible in the browser session config).
      agentMode = "inline";
    } else if (env().ASSEMBLYAI_API_KEY) {
      agentId = await createAgent({
        name: `voxaura-${scenario.id.slice(0, 8)}-${attempt.id.slice(0, 8)}`,
        system_prompt: agentPromptFor(effectiveHidden),
        greeting: buildGreeting(effectiveHidden),
        voice: { voice_id: "anna" },
        tools: OPPONENT_TOOLS,
        input: {
          keyterms: [
            "base salary",
            "sign-on bonus",
            "sign-on",
            "equity",
            "RSUs",
            "stock options",
            "401k",
            "remote days",
            "start date",
          ],
          turn_detection: {
            min_silence: 700,
            max_silence: 1600,
            interrupt_response: true,
          },
        },
      });
    } else if (env().AI_DEBUG) {
      // Debug: stub the agent so the full API/UI flow works without keys.
      // The WebSocket connect step will surface a clear error to the user.
      agentId = "debug-agent";
    } else {
      throw new ApiError(
        503,
        "ASSEMBLYAI_API_KEY missing — cannot create opponent agent. Set AI_DEBUG=1 to preview UI without voice.",
      );
    }
  } catch (err) {
    // Roll back the orphan attempt row so we never accumulate dead attempts.
    await markAbandonedSafe(attempt.id);
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, `Failed to create opponent agent: ${(err as Error).message}`);
  }

  const patch = await import("@/lib/db/queries");
  await patch.setAttemptAgent(attempt.id, agentId ?? "inline", agentMode);

  return Response.json(
    {
      attempt_id: attempt.id,
      agent_id: agentId,
      agent_mode: agentMode,
      greeting: buildGreeting(effectiveHidden),
    },
    { status: 201 },
  );
});

async function markAbandonedSafe(attemptId: string) {
  try {
    const { markAbandoned } = await import("@/lib/db/queries");
    await markAbandoned(attemptId);
  } catch {
    // ignore
  }
}
