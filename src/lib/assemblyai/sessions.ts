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
 */
export async function getSessionTimeline(sessionId: string): Promise<TimelineTurn[] | null> {
  try {
    const res = await fetch(`${BASE}/v1/sessions/${sessionId}`, {
      headers: { Authorization: requireAssemblyAIKey() },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      artifacts?: Array<{ type: string; url: string }>;
    };
    const timeline = data.artifacts?.find((a) => a.type === "timeline");
    if (!timeline?.url) return null;
    const artifact = await fetch(timeline.url);
    if (!artifact.ok) return null;
    const parsed = (await artifact.json()) as unknown;
    if (Array.isArray(parsed)) return parsed as TimelineTurn[];
    return null;
  } catch {
    return null;
  }
}
