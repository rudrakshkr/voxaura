"use client";

import { useCallback, useRef } from "react";

import { SAMPLE_RATE } from "@/lib/voice/protocol";

interface StartOpts {
  onChunk: (pcm: Int16Array) => void;
}

/**
 * Captures the mic via an AudioWorklet at exactly 24 kHz (the API's expected
 * rate), with browser AEC so the agent doesn't hear its own TTS.
 */
export function useMicCapture() {
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  const start = useCallback(async ({ onChunk }: StartOpts): Promise<void> => {
    // Idempotent: retrying a failed connect must not double-open the mic.
    if (streamRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    ctxRef.current = ctx;

    await ctx.audioWorklet.addModule("/worklets/pcm-processor.js");
    const worklet = new AudioWorkletNode(ctx, "pcm-processor");
    workletRef.current = worklet;

    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      onChunk(new Int16Array(e.data));
    };

    const source = ctx.createMediaStreamSource(stream);
    source.connect(worklet);
    // Deliberately do NOT connect the worklet to ctx.destination — we stream
    // mic audio to the API, never to the speakers (avoids echo loops).
  }, []);

  const stop = useCallback(() => {
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== "closed") {
      ctxRef.current.close().catch(() => undefined);
    }
    ctxRef.current = null;
  }, []);

  return { start, stop };
}
