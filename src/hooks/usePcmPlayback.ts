"use client";

import { useCallback, useRef } from "react";

import { decodeBase64PCM, SAMPLE_RATE } from "@/lib/voice/protocol";

/**
 * Schedules reply.audio chunks back-to-back on the audio clock. Keeps a cursor
 * so chunks arriving faster than real-time still play in order. flush() stops
 * every scheduled source and resets the cursor (barge-in).
 */
export function usePcmPlayback() {
  const ctxRef = useRef<AudioContext | null>(null);
  const cursorRef = useRef(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const ensureCtx = useCallback((): AudioContext => {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    return ctxRef.current;
  }, []);

  const play = useCallback(
    (b64: string) => {
      const ctx = ensureCtx();
      const int16 = decodeBase64PCM(b64);
      const float = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;

      const buffer = ctx.createBuffer(1, float.length, SAMPLE_RATE);
      buffer.getChannelData(0).set(float);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      if (cursorRef.current < now) cursorRef.current = now;
      source.start(cursorRef.current);
      cursorRef.current += buffer.duration;

      sourcesRef.current.push(source);
      source.onended = () => {
        sourcesRef.current = sourcesRef.current.filter((s) => s !== source);
      };
    },
    [ensureCtx],
  );

  const flush = useCallback(() => {
    for (const src of sourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    sourcesRef.current = [];
    if (ctxRef.current && ctxRef.current.state !== "closed") {
      cursorRef.current = ctxRef.current.currentTime;
    }
  }, []);

  const close = useCallback(() => {
    flush();
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, [flush]);

  return { ensureCtx, play, flush, close };
}
