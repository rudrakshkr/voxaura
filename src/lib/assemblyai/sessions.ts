import { requireAssemblyAIKey } from "../env";

const BASE = "https://agents.assemblyai.com";

export interface TimelineTurn {
  user_transcript?: string;
  agent_text?: string;
  [key: string]: unknown;
}

/**
 * Fetch the recorded session timeline (fallback transcript if the tab died
 * mid-call). Artifact URLs are pre-signed and need no auth header.
 *
 * Bounded on purpose: `/complete` runs the whole scoring inside one time budget,
 * and an unreachable voice service must cost its slice of that budget rather
 * than the entire route. On timeout this returns null and the report falls back
 * to the client transcript, labeled as such.
 */
export async function getSessionTimeline(
  sessionId: string,
  timeoutMs = 10_000,
): Promise<TimelineTurn[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(`${BASE}/v1/sessions/${sessionId}`, {
      headers: { Authorization: requireAssemblyAIKey() },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      artifacts?: Array<{ type: string; url: string }>;
    };
    const timeline = data.artifacts?.find((a) => a.type === "timeline");
    if (!timeline?.url) return null;
    const artifact = await fetch(timeline.url, { signal: controller.signal });
    if (!artifact.ok) return null;
    const parsed = (await artifact.json()) as unknown;
    if (Array.isArray(parsed)) return parsed as TimelineTurn[];
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
