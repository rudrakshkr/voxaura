import OpenAI from "openai";

import { env } from "../env";

/**
 * Provider-agnostic JSON LLM calls with automatic fallback.
 *
 * Chain: OpenAI (gpt-4o-mini) → Groq (openai/gpt-oss-120b, free tier) — or a
 * single provider when LLM_PROVIDER is pinned. Both expose OpenAI-compatible
 * APIs, so one client type covers both. Structured JSON comes back via
 * response_format json_schema (best-effort mode for cross-provider safety);
 * callers still Zod-validate the parsed result.
 */

export interface JsonCallArgs {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
}

export interface JsonCallResult {
  content: string;
  provider: string;
  model: string;
}

export class LlmUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "LlmUnavailableError";
  }
}

interface Provider {
  name: "openai" | "groq";
  model: string;
  client: OpenAI;
}

function makeProvider(name: "openai" | "groq", apiKey: string, model: string, baseUrl?: string): Provider {
  return {
    name,
    model,
    client: new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout: 45_000,
      maxRetries: 1,
    }),
  };
}

/** Build the provider chain from env. OpenAI first, Groq as free fallback. */
function providerChain(): Provider[] {
  const e = env();
  const pinned = e.LLM_PROVIDER;
  const providers: Provider[] = [];

  const openaiReady = Boolean(e.OPENAI_API_KEY);
  const groqReady = Boolean(e.GROQ_API_KEY);

  if (pinned === "openai") {
    if (!openaiReady) throw new LlmUnavailableError("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
    return [makeProvider("openai", e.OPENAI_API_KEY!, e.LLM_MODEL)];
  }
  if (pinned === "groq") {
    if (!groqReady) throw new LlmUnavailableError("LLM_PROVIDER=groq but GROQ_API_KEY is not set");
    return [makeProvider("groq", e.GROQ_API_KEY!, e.GROQ_MODEL, "https://api.groq.com/openai/v1")];
  }

  if (openaiReady) {
    providers.push(makeProvider("openai", e.OPENAI_API_KEY!, e.LLM_MODEL));
  }
  if (groqReady) {
    providers.push(makeProvider("groq", e.GROQ_API_KEY!, e.GROQ_MODEL, "https://api.groq.com/openai/v1"));
  }
  return providers;
}

/** True when at least one LLM provider is configured (used to gate features). */
export function hasLLM(): boolean {
  try {
    return providerChain().length > 0;
  } catch {
    return false;
  }
}

function describe(err: unknown, provider: Provider): string {
  const e = err as { status?: number; message?: string };
  const status = e?.status != null ? ` (HTTP ${e.status})` : "";
  return `${provider.name}/${provider.model}${status}: ${e?.message ?? String(err)}`;
}

/**
 * Billing/quota failures (401/402/429) skip to the next provider; schema
 * rejections (400 mentioning response_format) retry the same provider in
 * plain JSON-object mode; anything else also moves down the chain.
 */
function isBillingOrQuota(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 401 || status === 402 || status === 429;
}

function looksLikeSchemaRejection(err: unknown): boolean {
  const msg = ((err as { message?: string })?.message ?? "").toLowerCase();
  return (
    (err as { status?: number })?.status === 400 &&
    (msg.includes("json_schema") ||
      msg.includes("response_format") ||
      msg.includes("json_object") ||
      msg.includes("schema"))
  );
}

async function callProvider(p: Provider, args: JsonCallArgs): Promise<JsonCallResult> {
  const base = {
    model: p.model,
    messages: [
      { role: "system" as const, content: args.system },
      { role: "user" as const, content: args.user },
    ],
    temperature: args.temperature,
  };

  try {
    const res = await p.client.chat.completions.create({
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: { name: args.schemaName, strict: false, schema: args.schema },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error("empty response content");
    return { content, provider: p.name, model: p.model };
  } catch (err) {
    if (looksLikeSchemaRejection(err)) {
      // Fall back to plain JSON-object mode on this provider.
      const res = await p.client.chat.completions.create({
        ...base,
        response_format: { type: "json_object" },
      });
      const content = res.choices[0]?.message?.content;
      if (!content) throw new Error("empty response content (json_object mode)");
      return { content, provider: p.name, model: p.model };
    }
    throw err;
  }
}

/** Run a JSON structured call across the provider chain. */
export async function callJson(args: JsonCallArgs): Promise<JsonCallResult> {
  const chain = providerChain();
  if (chain.length === 0) {
    throw new LlmUnavailableError(
      "No LLM provider configured. Set OPENAI_API_KEY (paid) or GROQ_API_KEY (free tier at console.groq.com), or set AI_DEBUG=1.",
    );
  }

  const failures: string[] = [];
  for (const p of chain) {
    try {
      return await callProvider(p, args);
    } catch (err) {
      failures.push(describe(err, p));
      if (isBillingOrQuota(err)) {
        console.warn(`[llm] ${p.name} unavailable (billing/quota), trying next provider…`);
      } else {
        console.warn(`[llm] ${p.name} call failed, trying next provider…`, err);
      }
    }
  }

  const billingHint = failures.some((f) => f.includes("429") || f.includes("402") || f.includes("401"))
    ? " If this is your OpenAI key out of credits, add credits at platform.openai.com or set GROQ_API_KEY (free)."
    : "";
  throw new LlmUnavailableError(`All LLM providers failed. ${failures.join(" | ")}.${billingHint}`);
}
