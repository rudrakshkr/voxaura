import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { getTemporaryToken } from "@/lib/assemblyai/token";
import { getAttempt } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";
import { takeAttemptTokenSlot } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const SESSION_TTL_SECONDS = 300;

/**
 * Mint a short-lived AssemblyAI temp token for the browser's WebSocket.
 *
 * This used to require nothing but an owner cookie, which made it a free
 * credential mint: any visitor could open voice sessions with no attempt behind
 * them — each one billable, none of them tied to a call the product could show,
 * score or clean up.
 *
 * It is now bound to an ATTEMPT, and every check that matters is enforced before
 * the token is minted: the attempt must exist, belong to the caller, still be
 * `active`, and actually be servable in its resolved agent mode (a stored-mode
 * attempt whose agent could not be created must fail here rather than hand out a
 * token for a call that cannot start). Throttling is per owner AND attempt, so
 * one attempt cannot be used to churn tokens.
 */
export const GET = handle(async (req: Request) => {
  const rawAttemptId = new URL(req.url).searchParams.get("attempt_id");
  const parsed = z.string().uuid().safeParse(rawAttemptId);
  if (!parsed.success) throw new ApiError(400, "attempt_id is required");

  const attemptId = parsed.data;
  const ownerId = await readOwnerId();
  const attempt = await getAttempt(attemptId);
  // Writing: a token starts a live call for an attempt, so it is a write-scoped
  // capability. A sample attempt is refused like every other write.
  assertAttemptAccess(attempt, ownerId, "write");
  if (attempt.status !== "active") {
    throw new ApiError(409, "That call is already finished — start a new attempt.");
  }
  const agentMode = attempt.agent_mode as "stored" | "inline";
  if (agentMode !== "stored" && agentMode !== "inline") {
    throw new ApiError(500, "This attempt has an invalid agent mode.");
  }
  if (agentMode === "stored" && !attempt.agent_id) {
    throw new ApiError(503, "This attempt's stored opponent agent is unavailable. Start a new attempt.");
  }

  if (!takeAttemptTokenSlot(ownerId ?? "anonymous", attemptId)) {
    throw new ApiError(429, "Too many call setups in a row — give it a few seconds.");
  }

  // Debug mode still runs every authorization check above; it only skips the
  // billable round-trip, so this endpoint can be exercised in tests and local
  // runs without an AssemblyAI key.
  const token = env().AI_DEBUG ? "debug-token" : await getTemporaryToken(SESSION_TTL_SECONDS);
  return Response.json({ token, session_ttl_seconds: SESSION_TTL_SECONDS });
});