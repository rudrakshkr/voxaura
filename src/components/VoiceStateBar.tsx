"use client";

import clsx from "clsx";

import { fmtTime } from "./ui";
import type { AgentStatus } from "@/hooks/useVoiceAgent";

interface Props {
  status: AgentStatus;
  userSpeaking: boolean;
  agentSpeaking: boolean;
  recruiterThinking: boolean;
  justInterrupted: boolean;
  elapsedSec: number;
}

/**
 * Compact voice-state strip for the live call. One glance tells you:
 * connection state, who is speaking, and whether the recruiter is composing.
 */
export function VoiceStateBar(props: Props) {
  const live = props.status === "ready";

  let stateLabel = "Listening";
  let stateCls = "text-white/50";
  if (props.status === "connecting" || props.status === "reconnecting") {
    stateLabel = props.status === "reconnecting" ? "Reconnecting…" : "Connecting…";
    stateCls = "text-amber-300";
  } else if (props.justInterrupted) {
    stateLabel = "Interrupted — go ahead";
    stateCls = "text-amber-300";
  } else if (props.agentSpeaking) {
    stateLabel = "Recruiter speaking";
    stateCls = "text-violet-300";
  } else if (props.recruiterThinking) {
    stateLabel = "Recruiter thinking…";
    stateCls = "text-white/70";
  } else if (props.userSpeaking) {
    stateLabel = "You're speaking";
    stateCls = "text-emerald-300";
  }

  return (
    <div className="card flex items-center justify-between py-3">
      <div className="flex items-center gap-3">
        {/* Voice activity orb */}
        <span className="relative flex h-8 w-8 items-center justify-center">
          <span
            className={clsx(
              "absolute inset-0 rounded-full transition-all duration-200",
              props.agentSpeaking && "animate-ping bg-violet-500/30",
              props.userSpeaking && "bg-emerald-500/20",
              !props.agentSpeaking && !props.userSpeaking && "bg-white/5",
            )}
          />
          <span
            className={clsx(
              "relative h-3 w-3 rounded-full transition-colors",
              props.agentSpeaking && "bg-violet-400",
              props.userSpeaking && "bg-emerald-400",
              !props.agentSpeaking && !props.userSpeaking && "bg-white/30",
            )}
          />
        </span>
        <div>
          <p className={clsx("text-sm font-medium", stateCls)}>{stateLabel}</p>
          <p className="text-xs text-white/35">
            {live ? "Live connection" : props.status === "idle" ? "Not connected" : props.status}
          </p>
        </div>
      </div>
      <span className="font-mono text-lg text-white/80">{fmtTime(props.elapsedSec)}</span>
    </div>
  );
}
