import { randomUUID } from "node:crypto";

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

/**
 * Every API response is private and uncacheable: these payloads carry a
 * candidate's transcript, scores and — on no route, ever — hidden state, and a
 * shared cache or browser back/forward cache must never replay them.
 */
function privateHeaders(init?: Headers | undefined): Headers {
  const headers = new Headers(init);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Vary", "Cookie");
  return headers;
}

function privateResponse(res: Response): Response {
  if (res.headers.get("Cache-Control")?.includes("no-store")) return res;
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: privateHeaders(res.headers),
  });
}

/** True for errors that are safe (and useful) to show the user verbatim. */
function isActionable(err: unknown): boolean {
  return (
    err instanceof ApiError ||
    (err instanceof Error &&
      (err.name === "LlmUnavailableError" || err.name === "ApiKeyMissingError"))
  );
}

/**
 * Wrap a route handler so thrown ApiErrors become JSON responses and anything
 * unexpected becomes a generic 500 with a correlation id. Internal exception
 * text is never returned to the client — it is logged server-side against the
 * same id, so a demo failure can still be diagnosed from the logs.
 */
export function handle<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const requestId = randomUUID();
    try {
      return privateResponse(await fn(...args));
    } catch (err) {
      if (err instanceof ApiError) {
        return privateResponse(jsonError(err.status, err.message, { request_id: requestId }));
      }
      if (isActionable(err)) {
        return privateResponse(
          jsonError(503, (err as Error).message, { request_id: requestId }),
        );
      }
      console.error(`[api] unhandled error (request_id=${requestId}):`, err);
      return privateResponse(
        jsonError(500, "Something went wrong on our side. Please try again.", {
          request_id: requestId,
        }),
      );
    }
  };
}
