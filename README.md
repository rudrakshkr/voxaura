# Voxaura

Practice salary negotiation against a realistic AI recruiter over live voice — then get a scored coaching report and run it again, harder.

Built on the **AssemblyAI Voice Agent API** (single WebSocket: STT → LLM → TTS, turn detection, barge-in, tool calling), with an LLM generating hidden opponent state and post-call scoring.

**LLM providers:** OpenAI (`gpt-4o-mini`) is primary; if it's missing or out of credits, calls automatically fall back to **Groq's free tier** (`openai/gpt-oss-120b` — get a key at [console.groq.com](https://console.groq.com), no card needed). Pin a provider with `LLM_PROVIDER=groq`. AI features return an actionable 503 if no provider is configured.

## How it works

1. **Generate a scenario** — an LLM invents a company, role, and the recruiter's *hidden* state: budget ceiling, walk-away floor, target, opening anchor, flex levers (sign-on, equity, remote days, start date), and a persona.
2. **Prep** — you see only the visible prep pack. The hidden numbers are baked into a per-attempt **stored agent** (Agents REST API) that the browser binds to by opaque `agent_id`. The prompt never reaches the client.
3. **Live call** — the browser streams 24 kHz PCM16 mic audio straight to `wss://agents.assemblyai.com/v1/ws` with a single-use temp token. The recruiter opens with an anchor, concedes slowly, trades instead of donating, and calls client-side tools (`offer_to_candidate`, `accept_user_offer`, `log_user_move`) that drive the live offer panel and event log.
4. **Report** — a scorer LLM re-reads the full transcript (plus live events and the hidden state) and returns dimension scores (anchoring, information gathering, justification, concession management, package creativity, composure, information control, outcome), strengths, and improvements.
5. **Retry** — fresh numbers, or a harder recruiter (higher firmness, higher floor). History tracks score deltas across attempts.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, ASSEMBLYAI_API_KEY, OPENAI_API_KEY
npm run db:push        # create tables (Neon Postgres or any Postgres)
npm run seed           # generate 3 demo scenarios
npm run dev            # http://localhost:3000
```

- Mic access requires a secure origin: `http://localhost` works, deployment needs HTTPS.
- `AI_DEBUG=1` generates deterministic scenarios and reports without any LLM/Voice Agent calls (UI development only — the call itself still needs `ASSEMBLYAI_API_KEY`).
- `ALLOW_INLINE_AGENT=1` enables a debug path that sends the system prompt inline to the browser instead of a stored agent. Off by default.

## Architecture notes

- **Latency path:** mic → AudioWorklet (Int16 PCM, 24 kHz) → WebSocket → AssemblyAI (STT+LLM+TTS server-side) → `reply.audio` → scheduled playback with a time cursor. Next.js never proxies audio.
- **Barge-in:** on `reply.done` with `status:"interrupted"` the client flushes all scheduled audio and pending tool results.
- **Reconnect:** one auto-resume via `session.resume` (fresh temp token) inside the server's 30 s grace window; `session.end` is always sent to stop billing immediately.
- **Events:** client-side tools emit negotiation events, batched to Postgres; after the call the scorer re-extracts and merges a canonical event list (self-healing against tool under-logging).
- **Transcript fallback:** if the tab dies mid-call, the recorded session timeline artifact (`GET /v1/sessions/{id}`) is used for scoring.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind v4 · Drizzle ORM · Neon Postgres · OpenAI `gpt-4o-mini` · AssemblyAI Voice Agent API
