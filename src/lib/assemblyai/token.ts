import { requireAssemblyAIKey } from "../env";

const BASE = "https://agents.assemblyai.com";

/** Mint a single-use temporary token for browser WebSocket connections. */
export async function getTemporaryToken(expiresInSeconds = 300): Promise<string> {
  const res = await fetch(`${BASE}/v1/token?expires_in_seconds=${expiresInSeconds}`, {
    headers: { Authorization: requireAssemblyAIKey() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token mint failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Token mint response missing token field");
  return data.token;
}
