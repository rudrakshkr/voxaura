"use client";

import { useEffect, useRef } from "react";

import type { TranscriptTurn } from "@/lib/types";

export function TranscriptView({
  transcript,
  partialUser,
  agentSpeaking,
}: {
  transcript: TranscriptTurn[];
  partialUser: string | null;
  agentSpeaking: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, partialUser]);

  return (
    <div className="card flex h-[46vh] flex-col">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
        Live transcript
      </h3>
      <div className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1">
        {transcript.length === 0 && !partialUser && !agentSpeaking && (
          <p className="text-sm text-white/40">
            The call will start when you connect. Speak naturally — this is a roleplay.
          </p>
        )}
        {transcript.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === "user"
                ? "ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-violet-600/25 px-4 py-2"
                : "mr-auto max-w-[85%] rounded-2xl rounded-bl-md bg-white/8 px-4 py-2"
            }
          >
            <p className={turn.role === "user" ? "text-sm text-violet-100" : "text-sm text-white/90"}>
              {turn.text}
              {turn.interrupted && (
                <span className="ml-2 text-xs text-white/40">(interrupted)</span>
              )}
            </p>
          </div>
        ))}
        {partialUser && (
          <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-violet-600/10 px-4 py-2">
            <p className="text-sm italic text-violet-200/70">{partialUser}</p>
          </div>
        )}
        {agentSpeaking && (
          <div className="mr-auto flex items-center gap-1 rounded-2xl bg-white/5 px-4 py-3">
            <span className="h-2 w-2 animate-bounce rounded-full bg-white/50 [animation-delay:0ms]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-white/50 [animation-delay:120ms]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-white/50 [animation-delay:240ms]" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
