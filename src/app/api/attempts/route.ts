import { z } from "zod";

import { assertModeServable, resolveAgentMode } from "@/lib/agent-mode";
import { ApiError, handle } from "@/lib/api";
import { agentPromptFor, deriveVariant } from "@/lib/ai/generate";
import { buildGreeting } from "@/lib/ai/prompts";
import { OPPONENT_TOOLS } from "@/lib/ai/tools";
import { createAgent } from "@/lib/assemblyai/agents";
import { discardAgent } from "@/lib/agent-lifecycle";
import {
  createAttempt,
  deleteAttempt,
  getScenario,
  scenarioSnapshotOf,
  setAttemptAgent,
  markAbandoned,
} from "@/lib/db/queries";
import { scheduleStaleAttemptReclaim } from "@/lib/db/reclaim";
import { env } from "@/lib/env";
import { hiddenOf } from "@/lib/negotiation";
import { assertScenarioAccess, ensureOwnerId } from "@/lib/ownership";
import { takeAttemptSlot } from "@/lib/rate-limit";
import { normalizeHidden } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  scenario_id: z.string().uuid(),
  retry_mode: z.enum(["harder", "reroll"]).nullish(),
});

export const POST = handle(async (req: Request) => {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "scenario_id and optional retry_mode required");

  const ownerId = await ensureOwnerId();
  // Opportunistically retire attempts whose tab was closed mid-call. Throttled
  // and best-effort — see lib/db/reclaim.ts.
  scheduleStaleAttemptReclaim();

  const scenario = await getScenario(body.data.scenario_id);
  // Ownership before anything is produced for this attempt. A scenario id is not
  // a credential: without this check, any caller could start an attempt against
  // someone else's custom scenario — and in inline mode the response carries the
  // system prompt, which is built from that scenario's prep material (their
  // context and coaching objective). Sample scenarios are public, so they pass
  // for everyone; a foreign custom scenario 404s.
  assertScenarioAccess(scenario, ownerId, "read");

  if (!takeAttemptSlot(ownerId)) {
    throw new ApiError(429, "Too many calls started in a row — give it a few seconds.");
  }

  const base = hiddenOf(scenario);
  const effectiveHidden = normalizeHidden(
    body.data.retry_mode
      ? deriveVariant(base, { harder: body.data.retry_mode === "harder", reRoll: body.data.retry_mode === "reroll" })
      : base,
  );

  const attempt = await createAttempt(scenario.id, {
    effectiveHidden,
    retryMode: body.data.retry_mode ?? null,
    ownerId,
    // Freeze the candidate-facing material: scoring, the report and the
    // counterfactuals must describe the scenario the call was actually run with,
    // even if the scenario is edited afterwards.
    snapshot: scenarioSnapshotOf(scenario),
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

  // Resolve the mode BEFORE touching AssemblyAI, and only create a stored agent
  // when stored mode is genuinely in force. A stored agent costs a resource that
  // nothing would ever bind to in inline mode — which is the default — so
  // creating one 'just in case' was pure waste.
  //
  // (auto never depends on whether the agent id exists: AssemblyAI agents created
  // from serverless infrastructure are not resolvable from a browser IP, which
  // produces a 1008 close, so the inline path is what actually works on Vercel.)
  //
  // Everything from here is fallible, and it is fallible AFTER two resources
  // exist: the attempt row and (possibly) a stored agent. Both are released on
  // failure — an attempt nothing could ever call must not appear in history as a
  // broken active call, and an agent with no binding leaks for good.
  const preliminary = resolveAgentMode(false);
  let agentId: string | null = null;
  try {
    if (preliminary.mode === "stored" && env().ASSEMBLYAI_API_KEY) {
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
      } catch (err) {
        console.warn("[attempts] stored agent creation failed:", err);
      }
    }

    const decision = resolveAgentMode(Boolean(agentId));
    assertModeServable(decision, Boolean(agentId));
    if (decision.mode === "inline" && preliminary.mode === "stored") {
      throw new ApiError(
        503,
        "A stored opponent agent could not be created and inline mode is not available. " +
          "Set AGENT_MODE=inline (or ALLOW_INLINE_AGENT=1) to use the inline session path.",
      );
    }
    console.info(
      `[attempts] agent mode: ${decision.mode} (${decision.reason}) attempt=${attempt.id}`,
    );

    await setAttemptAgent(attempt.id, agentId ?? "inline", decision.mode);

    return Response.json(
      {
        attempt_id: attempt.id,
        agent_mode: decision.mode,
        agent_mode_reason: decision.reason,
        // The stored agent id is not a secret (the prompt is), and it is only
        // meaningful in stored mode. In inline mode the browser never needs one.
        agent_id: decision.mode === "stored" ? agentId : null,
        retry_mode: attempt.retry_mode,
        greeting,
        // The prompt only ever leaves the server in the explicit inline mode. In
        // stored mode the browser binds to the agent by id alone, so a client
        // reading hidden state from the network is impossible by construction.
        ...(decision.promptMayReachClient ? { system_prompt: systemPrompt } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    const agentCleaned = await discardAgent(agentId);

    if (agentId && !agentCleaned) {
      // The remote agent still exists. Keep its id durably attached to a terminal
      // attempt so the normal release/sweep path can retry deletion later.
      await setAttemptAgent(attempt.id, agentId, "stored").catch((persistErr) =>
        console.warn("[attempts] could not preserve orphaned agent id:", persistErr),
      );
      await markAbandoned(attempt.id).catch((markErr) =>
        console.warn("[attempts] could not mark setup attempt abandoned:", markErr),
      );
    } else {
      await deleteAttempt(attempt.id).catch((cleanupErr) =>
        console.warn("[attempts] could not roll back an unusable attempt:", cleanupErr),
      );
    }

    throw err;
  }
});