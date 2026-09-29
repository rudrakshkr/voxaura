import { ApiError } from "./api";
import { env, inlineAgentFlag } from "./env";

/**
 * Where the opponent agent's system prompt is allowed to live.
 *
 * The product rule is that hidden negotiation state stays server-side. Two
 * things make that subtle in practice:
 *
 * 1. The opponent prompt contains no hidden economics — no budget, floor or
 *    target — only the (already spoken) opening anchor and the persona. It is
 *    still a server artifact, so its exposure has to be a deliberate mode, not
 *    a side effect of "AssemblyAI happens to be configured".
 * 2. AssemblyAI agents created from serverless infrastructure are not
 *    resolvable from a browser IP, so stored-agent mode can 1008 on Vercel.
 *    Inline mode (prompt shipped to the session client) is therefore the
 *    default that actually works — but it is a *named* mode with a documented
 *    reason, and `ALLOW_INLINE_AGENT=0` turns it off.
 *
 * This module is the single decision point, so the attempt route, the
 * agent-config route and the session page can never disagree about which mode
 * is in force.
 */
export type AgentMode = "stored" | "inline";

export interface AgentModeDecision {
  mode: AgentMode;
  /** True only in inline mode: the prompt must be served to the session client. */
  promptMayReachClient: boolean;
  /** Operator-facing explanation, logged and echoed in API responses. */
  reason: string;
}

export interface AgentModeInputs {
  requested: "auto" | "stored" | "inline";
  inlineFlag: "on" | "off" | "unset";
  /** Whether a stored agent was successfully created for this attempt. */
  hasStoredAgentId: boolean;
  assemblyaiConfigured: boolean;
}

/**
 * Pure resolution — no env access, so it is directly testable.
 * Precedence: explicit AGENT_MODE (stored/inline) → explicit ALLOW_INLINE_AGENT=0
 * → auto (inline).
 */
export function decideAgentMode(inputs: AgentModeInputs): AgentModeDecision {
  const { requested, inlineFlag, hasStoredAgentId, assemblyaiConfigured } = inputs;
  if (!assemblyaiConfigured) {
    return {
      mode: "inline",
      promptMayReachClient: false,
      reason: "ASSEMBLYAI_API_KEY is not configured",
    };
  }
  if (requested === "stored") {
    return {
      mode: "stored",
      promptMayReachClient: false,
      reason: "AGENT_MODE=stored — the prompt stays server-side",
    };
  }
  if (requested === "inline") {
    if (inlineFlag === "off") {
      return {
        mode: "stored",
        promptMayReachClient: false,
        reason:
          "AGENT_MODE=inline but ALLOW_INLINE_AGENT=0 — falling back to a stored agent rather than shipping the prompt",
      };
    }
    return {
      mode: "inline",
      promptMayReachClient: true,
      reason: "AGENT_MODE=inline",
    };
  }
  // auto
  if (inlineFlag === "off") {
    return {
      mode: "stored",
      promptMayReachClient: false,
      reason: "ALLOW_INLINE_AGENT=0 — stored agent only",
    };
  }
  if (inlineFlag === "on") {
    return {
      mode: "inline",
      promptMayReachClient: true,
      reason: "ALLOW_INLINE_AGENT=1",
    };
  }
  return {
    mode: "inline",
    promptMayReachClient: true,
    reason: hasStoredAgentId
      ? "auto: inline session config (agents created from serverless IPs are not client-resolvable)"
      : "auto: inline session config",
  };
}

/** Resolve the mode for the current process/attempt. */
export function resolveAgentMode(hasStoredAgentId: boolean): AgentModeDecision {
  return decideAgentMode({
    requested: env().AGENT_MODE,
    inlineFlag: inlineAgentFlag(),
    hasStoredAgentId,
    assemblyaiConfigured: Boolean(env().ASSEMBLYAI_API_KEY) || env().AI_DEBUG,
  });
}

/**
 * The gate for any endpoint that can hand the opponent prompt to a browser.
 * Ownership still applies on top; this only answers "is inline mode in force?".
 */
export function inlinePromptAllowed(): boolean {
  return resolveAgentMode(true).promptMayReachClient;
}

/** Fail an attempt creation that cannot be served in the requested mode. */
export function assertModeServable(decision: AgentModeDecision, hasStoredAgentId: boolean): void {
  if (decision.mode === "stored" && !hasStoredAgentId) {
    throw new ApiError(
      503,
      "AGENT_MODE/ALLOW_INLINE_AGENT forbids inline mode, but no stored opponent agent could be created. " +
        "Set AGENT_MODE=inline (or ALLOW_INLINE_AGENT=1) to use the inline session path.",
    );
  }
}
