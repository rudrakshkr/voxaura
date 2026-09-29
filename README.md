# Voxaura

Practice a real salary negotiation against a realistic AI recruiter, over live voice — then get a
scored coaching report you can replay decision by decision, and simulate what would have happened if
you had negotiated differently.

Built on the **AssemblyAI Voice Agent API** (one WebSocket: STT → LLM → TTS, turn detection,
barge-in, tool calling). Deterministic TypeScript owns the economics; an LLM owns the language.

> **The LLM speaks. The engine decides.**

## Why it's built this way

A voice negotiation demo is easy to fake and hard to make trustworthy. Three rules carry the project:

1. **The deterministic engine is the single source of truth for economics and state.** Budget,
   reservation, target, concession limits, acceptance, the final package and the outcome are
   computed in `src/lib/negotiation-engine.ts` and persisted server-side. The model cannot set any
   of them. Each turn the engine issues a *directive*: a verdict, the exact figures the recruiter may
   speak, and the rules that bind the turn. The model is a mouth, not a wallet.
2. **Hidden state never reaches the browser.** The recruiter's budget, floor and target are columns
   on `scenarios`, baked into the opponent prompt server-side, and never serialized to a client, a
   URL, a log line, or a public API response. The prompt itself contains no hidden economics — and
   where it does travel to the session client (inline mode, see below), it is fetched from an
   owner-checked endpoint, never passed as a query parameter.
3. **Every claim is traceable.** Moves are written to a durable `negotiation_events` log with
   monotonic sequence numbers. Scores cite evidence and the `seq` numbers behind them; replays and
   counterfactuals are recomputed from the same numbers.

## The three layers

1. **Live voice roleplay** — real-time recruiter with a persona, a hidden band and no off-screen
   team. Deterministic concessions, verified leverage, deadlock detection, and a call that closes
   itself once the negotiation is genuinely over.
2. **Evidence-based analysis** — the coach model returns a rubric *plus evidence* (quotes and event
   seq numbers). The headline score is computed server-side as a weighted mean of those dimensions,
   so the model cannot inflate it.
3. **Counterfactual simulation** — `src/lib/counterfactual.ts` replays alternative strategies
   ("anchor $10k higher", "lead with real leverage", "walk away at the first hold") against the same
   hidden economics *using the same engine rules*. No LLM is involved, so the answer is a
   measurement rather than a story.

## Setup

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL, ASSEMBLYAI_API_KEY, and OPENAI_API_KEY (or GROQ_API_KEY)
npm run db:push          # create/update tables (Neon Postgres or any Postgres)
npm run seed             # upsert the 3 demo scenarios (idempotent — safe to re-run)
npm run dev              # http://localhost:3000
```

- Microphone access requires a secure origin: `http://localhost` works; a deployment needs HTTPS.
- `AI_DEBUG=1` generates deterministic scenarios and reports with **no** LLM calls (the live call
  still needs `ASSEMBLYAI_API_KEY`). Never enable it in production.
- `AGENT_MODE=stored` keeps the opponent prompt entirely server-side (bind by opaque `agent_id`).
  The default, `auto`, uses the inline session config because AssemblyAI agents created from
  serverless infrastructure are not resolvable from a browser IP, so `auto` needs no configuration on
  Vercel. `ALLOW_INLINE_AGENT=0` forbids the inline path outright; start-the-call then fails with an
  actionable 503 instead of silently shipping a prompt.

## Quality checks

```bash
npm run db:push        # after pulling schema changes (additive; see "Database" below)
npm run typecheck      # tsc --noEmit
npm run test           # engine + money-parsing + counterfactual suite, the hostile-LLM suite, then
                       # the voice/data-integrity logic suite
npm run check          # typecheck + tests (the pre-demo gate; exits non-zero on any failure)
npm run check:release  # check + production build
npm run test:integration  # route + database tests: builds on top of the above (needs `npm run build`
                          # and DATABASE_URL; spawns a real `next start`, then cleans up after itself)
```

The test suite is plain assertions with a non-zero exit code on failure — no `|| true`, no silent
catches. It covers anchoring, concession limits, budget/envelope boundaries, acceptance semantics,
money parsing (including `2024`, phone numbers, `2 weeks` and `10/10`), event ordering, transcript
dedupe, idempotent turns, and the counterfactual simulator. `scripts/hostile-llm-test.ts`
stubs the provider's `fetch` and runs a malicious completion through the real scoring pipeline
(no network, no API key), asserting that it cannot set the score, the outcome, the final package,
or write a settlement into the event log — including transcripts that try to instruct the scorer.
`scripts/voice-logic-test.ts` covers the pieces that decide *what* gets scored, with no server and no
database: transcript reconciliation (an appended client turn is never adopted as evidence, a
corroborated insertion is), the recovered timeline's aggregate caps, session-binding rules,
directive delivery across a dropped socket, the bounded final flush, the attempt clock surviving a
reconnect, and the generator's bounds and cross-field repair.

`scripts/integration-test.ts` is the adversarial half: against the real database it proves a stale
completion can never downgrade an accepted deal, that two completions cannot publish two
scores, that a barrier reclaimed by the stale sweep cannot be written through by the finalizer that
lost it, that an abandoned tab is reclaimed with its agent released, and that an attempt keeps the
scenario it was actually run with; and against a real server (cookie jars, no mocks) that a foreign
owner cannot read, edit, delete or start a call on someone else's scenario, that a partial edit
cannot leave the prep pack invalid, that an `offer`/`accept` without a server-issued authorization is
refused, that a session cannot be swapped under an attempt, and that `{base: 999999}` can never
become an accepted attempt — including six runs of `/complete` racing a final `/turn`.

## Database

The schema is additive — `attempts.owner_id` and `scenarios.owner_id` (both **NOT NULL**),
`scenarios.seed_key` (nullable), plus the `attempt_turns` idempotency table and the completion
barrier (`attempt_status` gains `finalizing`, `attempts` gains `finalizing_at`; migration
`drizzle/0003_finalization_barrier.sql`, re-runnable). `drizzle/0004_release_hardening.sql` adds the
server-issued action authorizations (`attempt_authorizations`), the event provenance flag
(`negotiation_events.authoritative`), the barrier's ownership token (`attempts.finalization_token`),
the frozen candidate-facing scenario (`attempts.scenario_snapshot`) and the report's transcript
provenance (`reports.transcript_source`) — all additive, with the existing history backfilled. Apply
them with `npm run db:push` before running the app, or the routes will fail on the missing columns.

**Ownership is never ambiguous.** `owner_id` is either the visitor's anonymous cookie id or the
`demo:sample-library` sentinel (`src/lib/access.ts`). Rows that predate ownership — and the built-in
seeds — carry the sentinel, so "public sample data" is explicit rather than an accident of a NULL:

- a cookie-less visitor sees **only** sample rows, never another visitor's attempts;
- sample rows are readable by everyone and writable by no one (the library UI labels them and offers
  no edit/delete), so the samples cannot be destroyed and cannot be mistaken for your history;
- a real owner sees their own attempts plus the labeled samples, and their `score → previous score`
  progress is computed only within their own attempts.

`drizzle/0002_ownership_required.sql` performs the backfill and then sets the constraint. It is
re-runnable: the adds are `IF NOT EXISTS`, and the `UPDATE ... WHERE owner_id IS NULL` before each
`SET NOT NULL` means the constraint can never fail on existing history.

## Architecture

```
mic ──AudioWorklet(24kHz PCM16)──> wss://agents.assemblyai.com ──> STT → LLM → TTS
                                                   │
                        user speech ───────────────┘
                              │
                    POST /api/attempts/:id/turn        (advisory-locked transaction)
                              │
                  deterministic engine (economy, state, verdict)
                              │
                    directive ─┴─> spoken by the model, mirrored to the panel
```

**Server layout**

| Route | Responsibility |
| --- | --- |
| `POST /api/attempts` | Mint an attempt + opponent; resolve the agent mode explicitly; rate-limited |
| `GET /api/attempts/:id` | Attempt detail, standing package, previous score — owner only |
| `POST /api/attempts/:id/turn` | **The negotiation step.** Lock, load state, classify, decide, persist, issue at most one action authorization |
| `POST /api/attempts/:id/offer` | Record a spoken/tool package and apply an acceptance — **only** with the authorization `/turn` issued for it |
| `POST /api/attempts/:id/session` | Bind the attempt to its voice session (first bind, or an explicit reconnect) |
| `POST /api/attempts/:id/events` | Client-observed *candidate* events only (allowlisted, stored as non-authoritative) |
| `POST /api/attempts/:id/complete` | Idempotent scoring; engine-authoritative outcome |
| `GET /api/attempts/:id/report` | Report + canonical event log |
| `GET /api/attempts/:id/counterfactual` | Modeled alternative strategies — available only once the attempt is scored |

**Concurrency and durability**

- Every mutation of one attempt's state runs in a single transaction holding
  `pg_advisory_xact_lock(hashtext(attempt_id))`. Two concurrent turns serialise: the second waits,
  re-reads the committed state and processes against it. Event sequence numbers are allocated inside
  that same lock, so `(attempt_id, seq)` can never collide.
- `POST /turn` accepts a `turn_id`. A repeated id returns the stored response instead of negotiating
  the same sentence twice — voice clients retry on timeout, and a timeout-then-retry pair must be
  processed exactly once.
- `/turn` is the only source of recruiter decisions. When the engine rules that the recruiter should
  act on a package, the turn response carries a short-lived, single-use authorization bound to the
  attempt, the turn, the action and the exact package. `/offer` consumes it (inside the attempt lock)
  before it may mutate the engine state or settle a deal, so a browser can no longer manufacture a
  recruiter action or an acceptance. Authorizations expire and are purged; a replay, a transfer to
  another attempt or a second use of the same token fails closed.
- The voice session is bound to the attempt server-side (`/session`, and on the first `/events`
  batch). Completion resolves the attempt's OWN session; a request cannot substitute another.
- `POST /complete` is idempotent; `POST /events` keeps failed batches queued client-side and retries
  with server-side de-duplication, so a lost response cannot record the same move twice. The call
  screen shows `Engine synced` / `N events pending` / `Reconnecting` so a demo never silently loses
  its history.
- A recorder directive is queued by turn id and drained on reconnection, so a directive the engine
  decided while the socket was down is delivered exactly once instead of being lost (or re-run). The
  attempt's clock is anchored to the server's attempt start, so a reconnect never resets elapsed
  time, and the final event flush is deadline-bounded and reports what it could not sync.
- One attempt settles once. The completion barrier plus a per-claim ownership token means a killed or
  duplicated completion cannot release or overwrite a barrier that has been reclaimed, and the whole
  completion (timeline fetch, scoring) runs inside one budget — an exhausted budget still produces a
  clearly labelled degraded report rather than losing the call.

**Security posture**

- Anonymous ownership: an httpOnly `voxaura_owner` cookie is minted per visitor and checked on every
  attempt-scoped route. The cookie is validated against the shape we mint (48 hex characters), so a
  forged value — including the `demo:sample-library` sentinel — cannot be presented as an identity.
- Reads and writes are different privileges (see `src/lib/access.ts`). Sample rows are public to read
  and refuse writes with a 403; everything else is creator-only and answers 404, so a probe cannot
  learn that an id exists.
- Scenarios carry the same owner: `DELETE /api/scenarios/:id` cascades to every attempt, event and
  report made against it, so it is creator-only, and the sample library is read-only to everyone — an
  anonymous visitor can no longer delete a library scenario and take every attempt with it.
- Authoritative events are server-generated only. The client may report what the candidate did; a
  browser cannot fabricate an opponent offer, an acceptance, or scoring evidence — client-observed
  events are stored flagged non-authoritative and are excluded from scoring, and a candidate
  acceptance the engine never authorised is refused at `/offer`.
- The scored transcript is reconciled server-side: the voice service's recorded timeline is
  authoritative whenever a usable one exists, a client-only turn is adopted only when the surrounding
  turns corroborate it, and every transcript (client or recovered) is clamped per turn and in
  aggregate before it reaches a prompt. The report records which source was used
  (`transcript_source`), so an unverified transcript is labelled as one.
- Scorer input is data, never instructions: the prompt delimits the transcript and the event log and
  tells the model to ignore anything inside them that claims to be an instruction.
- Resource lifecycle: a stored AssemblyAI agent is deleted once its attempt is terminal (never while
  a call could still use it, and never for the inline sentinel, which is a binding rather than an
  agent), a failed setup rolls its attempt back, and attempts left behind by a closed tab are swept
  to `abandoned` — which frees the scenario they were holding.
- Errors return a generic message plus a request id; details are logged server-side only.
- CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and `frame-ancestors` are set in
  `next.config.ts`; all private API responses are `no-store`.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind v4 · Drizzle ORM · Neon Postgres ·
AssemblyAI Voice Agent API · OpenAI `gpt-4o-mini` (Groq free-tier fallback)
