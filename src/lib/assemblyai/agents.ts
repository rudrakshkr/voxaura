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
  const key = requireAssemblyAIKey();
  const res = await fetch(`${BASE}/v1/agents`, {
    method: "POST",
    headers: {
      Authorization: key,
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
  const key = requireAssemblyAIKey();
  const res = await fetch(`${BASE}/v1/agents/${id}`, {
    method: "PUT",
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent update failed (${res.status}): ${text}`);
  }
}

/** Best-effort cleanup; returns whether the remote resource is gone. */
export async function deleteAgent(id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  try {
    const key = requireAssemblyAIKey();
    const res = await fetch(`${BASE}/v1/agents/${id}`, {
      method: "DELETE",
      headers: { Authorization: key },
    });
    if (res.ok || res.status === 404) return true;
    const text = await res.text().catch(() => "");
    console.warn(`[agents] delete failed (${res.status}): ${text}`);
    return false;
  } catch (err) {
    console.warn("[agents] delete failed:", err);
    return false;
  }
}