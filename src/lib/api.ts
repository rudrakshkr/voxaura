/** Shared API error with an HTTP status — thrown by lib helpers, caught by routes. */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return Response.json({ error: message, ...extra }, { status });
}

/** Wrap a route handler so thrown ApiErrors become JSON responses. */
export function handle<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return jsonError(err.status, err.message);
      }
      // Friendly, actionable errors for missing keys and provider outages.
      if (err instanceof Error && (err.name === "LlmUnavailableError" || err.name === "ApiKeyMissingError")) {
        return jsonError(503, err.message);
      }
      console.error("[api] unhandled error:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      return jsonError(500, message);
    }
  };
}
