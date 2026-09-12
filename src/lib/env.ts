import { z } from "zod";

/**
 * Server env parsing. Kept lazy so importing this module never crashes a build;
 * values are validated on first actual use. Empty strings are treated as
 * unset so `.env` stubs like `OPENAI_API_KEY=` stay valid in debug mode.
 */
const optionalKey = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.string().min(1).optional(),
);

/** Only "1"/"true" enable a flag — Boolean("0") is true, so never coerce. */
const flag = z.preprocess(
  (v) => v === "1" || v === "true" || v === true,
  z.boolean().default(false),
);

const EnvSchema = z.object({
  DATABASE_URL: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.string().min(1, "DATABASE_URL is required"),
  ),
  ASSEMBLYAI_API_KEY: optionalKey,
  OPENAI_API_KEY: optionalKey,
  /** Optional free-tier fallback (OpenAI-compatible): https://console.groq.com */
  GROQ_API_KEY: optionalKey,
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  /** "openai" | "groq" to pin one provider; default tries OpenAI then Groq. */
  LLM_PROVIDER: z.enum(["openai", "groq"]).optional(),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  AI_DEBUG: flag,
  ALLOW_INLINE_AGENT: flag,
});

let cached: z.infer<typeof EnvSchema> | null = null;

export function env(): z.infer<typeof EnvSchema> {
  if (!cached) {
    cached = EnvSchema.parse(process.env);
  }
  return cached;
}

export function requireAssemblyAIKey(): string {
  const key = env().ASSEMBLYAI_API_KEY;
  if (!key) {
    throw new ApiKeyMissingError("ASSEMBLYAI_API_KEY");
  }
  return key;
}

export function requireOpenAIKey(): string {
  const key = env().OPENAI_API_KEY;
  if (!key) {
    throw new ApiKeyMissingError("OPENAI_API_KEY");
  }
  return key;
}

export class ApiKeyMissingError extends Error {
  constructor(name: string) {
    super(`Missing ${name} in environment. Copy .env.example to .env and fill it in.`);
    this.name = "ApiKeyMissingError";
  }
}
