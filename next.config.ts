import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy.
 *
 * The audio path is a same-origin AudioWorklet (`/worklets/pcm-processor.js`)
 * plus a WebSocket to AssemblyAI, so nothing here needs `blob:` scripts or a
 * wildcard. `unsafe-inline` for scripts/styles is required by Next's inline
 * bootstrap and styled output; `unsafe-eval` is added in development only,
 * where React Refresh needs it.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "connect-src 'self' https://api.assemblyai.com https://agents.assemblyai.com wss://agents.assemblyai.com ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Pin the workspace root so a stray lockfile in $HOME doesn't confuse tracing.
  outputFileTracingRoot: __dirname,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // The microphone is the product; nothing else is needed, and the
          // exception is scoped to this origin.
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
