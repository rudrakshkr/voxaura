import { requireAssemblyAIKey } from "../env";

const BASE = "https://agents.assemblyai.com";

export interface OpponentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeout_seconds?: number;
  execution_mode?: "interactive" | "hold";
}

export interface CreateAgentBody {
  name: string;
  system_prompt: string;
  greeting: string;
  voice?: { voice_id: string };
  tools?: OpponentToolDef[];
  input?: {
    keyterms?: string[];
    turn_detection?: Record<string, unknown>;
  };
}

/**
 * Create a stored agent (leak-resistant hidden state): the system prompt lives
 * server-side; the browser only ever receives the agent_id.
 */
export async function createAgent(body: CreateAgentBody): Promise<string> {
  const res = await fetch(`${BASE}/v1/agents`, {
    method: "POST",
    headers: {
      Authorization: requireAssemblyAIKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent create failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Agent create response missing id");
  return data.id;
}

export async function updateAgent(id: string, body: Partial<CreateAgentBody>): Promise<void> {
  const res = await fetch(`${BASE}/v1/agents/${id}`, {
    method: "PUT",
    headers: {
      Authorization: requireAssemblyAIKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent update failed (${res.status}): ${text}`);
  }
}

/** Best-effort cleanup — never throws. */
export async function deleteAgent(id: string | null | undefined): Promise<void> {
  if (!id) return;
  try {
    await fetch(`${BASE}/v1/agents/${id}`, {
      method: "DELETE",
      headers: { Authorization: requireAssemblyAIKey() },
    });
  } catch {
    // ignore cleanup failures
  }
}
