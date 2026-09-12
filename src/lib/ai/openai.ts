import OpenAI from "openai";

import { ApiKeyMissingError, requireOpenAIKey } from "../env";

let cached: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!cached) {
    // Throws ApiKeyMissingError before constructing a client without a key.
    requireOpenAIKey();
    cached = new OpenAI({ apiKey: requireOpenAIKey() });
  }
  return cached;
}

export { ApiKeyMissingError };
