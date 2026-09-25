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

  const systemPrompt = agentPromptFor(effectiveHidden, {
    company: scenario.company,
    role: scenario.role,
    level: scenario.level,
    context: (scenario.prep_pack as { context?: string }).context ?? null,
  });
  const greeting = buildGreeting(effectiveHidden, {
    company: scenario.company,
    role: scenario.role,
    level: scenario.level,
  });
  let agentId: string | null = null;
  let agentMode: "stored" | "inline" = "stored";

  // AssemblyAI's Voice Agent API has an IP visibility quirk: agents created
  // from Vercel's serverless infrastructure are NOT resolvable from external
  // client IPs (the browser). Using stored-agent mode therefore produces a
  // valid agent_id that the WebSocket session.update can't bind, resulting in
  // a 1008 Connection Closed. The reliable path is inline mode — the prompt
  // travels in the session config and the WS server creates a transient session
  // without needing a pre-stored agent. We keep the stored-agent create call as
  // a best-effort side effect (so the agent exists server-side for any future
  // tooling), but always ship inline mode to the client.
  if (env().ASSEMBLYAI_API_KEY) {
    // Best-effort: create a stored agent server-side (may or may not be
    // resolvable from the client — we don't depend on it).
    try {
      agentId = await createAgent({
        name: `voxaura-${scenario.id.slice(0, 8)}-${attempt.id.slice(0, 8)}`,
        system_prompt: systemPrompt,
        greeting,
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
    } catch {
      // Non-fatal: inline mode will carry the prompt regardless.
    }
    // Always use inline mode so the client can start a call regardless of
    // whether the stored agent is resolvable from its IP.
    agentMode = "inline";
  } else if (env().AI_DEBUG) {
    agentMode = "inline";
  } else {
    throw new ApiError(
      503,
      "ASSEMBLYAI_API_KEY missing — cannot create opponent agent.",
    );
  }

  const patch = await import("@/lib/db/queries");
  await patch.setAttemptAgent(attempt.id, agentId ?? "inline", agentMode);

  return Response.json(
    {
      attempt_id: attempt.id,
      agent_id: agentId,
      agent_mode: agentMode,
      retry_mode: attempt.retry_mode,
      system_prompt: systemPrompt,
      greeting,
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
