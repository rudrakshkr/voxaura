import { deleteAgent } from "./assemblyai/agents";
import { db } from "./db/client";
import { attempts } from "./db/schema";
import type { AttemptStatus } from "./types";
import { and, eq } from "drizzle-orm";

/**
 * The literal `agent_id` recorded for an attempt served by the INLINE path.
 *
 * `agent_id` is really an agent *binding*: a stored AssemblyAI agent id, or this
 * sentinel meaning "this attempt runs on the inline session config, there is
 * nothing stored to bind to". The distinction matters, because the lifecycle
 * below deletes what it reads: without it, finishing any inline call sent
 * `DELETE /v1/agents/inline` to the voice service.
 */
export const INLINE_AGENT_SENTINEL = "inline";

/** True only for a genuine stored agent id — never for the inline sentinel. */
export function isStoredAgentId(agentId: string | null | undefined): agentId is string {
  return Boolean(agentId) && agentId !== INLINE_AGENT_SENTINEL;
}

/**
 * Whether an attempt in this state may have its agent released.
 *
 * An `active` or `finalizing` attempt could still be using it — a live call, or
 * a call being scored — so its agent stays. Only terminal states release.
 */
export function agentReleaseAllowed(status: AttemptStatus): boolean {
  return status !== "active" && status !== "finalizing";
}

/**
 * Stored-agent lifecycle.
 *
 * `deleteAgent()` existed with no caller, so every attempt that ever created an
 * AssemblyAI agent leaked it: an orphaned resource billed to the account that
 * nothing could ever bind to again. The rules here are deliberately narrow:
 *
 *  - **Ephemeral by design.** An agent is provisioned for exactly one attempt and
 *    is useless once the call is over, so it is deleted when the attempt reaches
 *    a terminal state. (There is no retention policy to document because there is
 *    no retention.)
 *  - **Never while a call could still use it.** An `active` or `finalizing`
 *    attempt keeps its agent; only `completed` and `abandoned` are released.
 *  - **Only real agents are deleted.** The inline sentinel is cleared from the
 *    row but never sent to the voice service as an agent id.
 *  - **Best-effort.** Cleanup never throws: a failed delete must not fail the
 *    request that triggered it, and the next sweep will try again.
 *
 * The remote delete happens BEFORE clearing `agent_id`. If deletion fails, the
 * row keeps the id so the stale-attempt sweep can retry cleanup later.
 */
export async function releaseAttemptAgent(attemptId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ agentId: attempts.agent_id, status: attempts.status })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .limit(1);
    if (!row?.agentId) return;
    if (!agentReleaseAllowed(row.status)) return;

    if (isStoredAgentId(row.agentId)) {
      const deleted = await deleteAgent(row.agentId);
      if (!deleted) return;
    }

    await db
      .update(attempts)
      .set({ agent_id: null })
      .where(and(eq(attempts.id, attemptId), eq(attempts.agent_id, row.agentId)));
  } catch (err) {
    console.warn(`[agent-lifecycle] could not release the agent for ${attemptId}:`, err);
  }
}

/** Best-effort cleanup for an agent that was just created but can no longer be used. */
export async function discardAgent(agentId: string | null | undefined): Promise<boolean> {
  if (!isStoredAgentId(agentId)) return true;
  return deleteAgent(agentId);
}