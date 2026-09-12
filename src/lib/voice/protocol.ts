/**
 * Typed mirror of the AssemblyAI Voice Agent API WebSocket protocol
 * (wss://agents.assemblyai.com/v1/ws). Only the events Voxaura consumes are
 * modeled.
 */

export const SAMPLE_RATE = 24000;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface SessionUpdateMsg {
  type: "session.update";
  session: {
    // Stored agent mode (mutually exclusive with inline fields).
    agent_id?: string;
    // Inline mode (debug only).
    system_prompt?: string;
    greeting?: string;
    tools?: unknown[];
    input?: Record<string, unknown>;
    output?: { voice?: string; volume?: number; format?: { encoding: string } };
  };
}

export interface InputAudioMsg {
  type: "input.audio";
  audio: string; // base64 PCM16
}

export interface ToolResultMsg {
  type: "tool.result";
  call_id: string;
  result: string; // JSON string
  is_error?: boolean;
}

export interface SessionEndMsg {
  type: "session.end";
}

export interface SessionResumeMsg {
  type: "session.resume";
  session_id: string;
}

/** Inject a message into the conversation context (used for engine directives). */
export interface ConversationMessageMsg {
  type: "conversation.message";
  role: "user" | "system";
  content: string;
}

export type ClientMsg =
  | SessionUpdateMsg
  | InputAudioMsg
  | ToolResultMsg
  | SessionEndMsg
  | SessionResumeMsg
  | ConversationMessageMsg;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface SessionReadyEvent {
  type: "session.ready";
  session_id: string;
  expires_at?: number;
  resume_token?: string;
  config?: Record<string, unknown>;
}

export interface SessionUpdatedEvent {
  type: "session.updated";
  config?: Record<string, unknown>;
}

export interface SessionEndedEvent {
  type: "session.ended";
  session_duration_seconds?: number;
  audio_duration_seconds?: number | null;
  timestamp?: number;
}

export interface SessionErrorEvent {
  type: "session.error";
  code: string;
  message: string;
  timestamp?: string;
  param?: string;
}

export interface SpeechStartedEvent {
  type: "input.speech.started";
}

export interface SpeechStoppedEvent {
  type: "input.speech.stopped";
}

export interface TranscriptUserDeltaEvent {
  type: "transcript.user.delta";
  item_id: string;
  text: string; // full text so far, supersedes previous
}

export interface TranscriptUserEvent {
  type: "transcript.user";
  text: string;
  item_id: string;
}

export interface ReplyStartedEvent {
  type: "reply.started";
  reply_id: string;
  item_id: string;
}

export interface ReplyAudioEvent {
  type: "reply.audio";
  data: string; // base64 PCM16
}

export interface TranscriptAgentDeltaEvent {
  type: "transcript.agent.delta";
  reply_id: string;
  item_id: string;
  delta: string;
  start_ms: number | null;
  end_ms: number | null;
}

export interface TranscriptAgentEvent {
  type: "transcript.agent";
  text: string;
  reply_id: string;
  item_id: string;
  interrupted: boolean;
}

export interface ReplyDoneEvent {
  type: "reply.done";
  reply_id: string;
  status: "completed" | "interrupted";
}

export interface ToolCallEvent {
  type: "tool.call";
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type VoiceAgentEvent =
  | SessionReadyEvent
  | SessionUpdatedEvent
  | SessionEndedEvent
  | SessionErrorEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | TranscriptUserDeltaEvent
  | TranscriptUserEvent
  | ReplyStartedEvent
  | ReplyAudioEvent
  | TranscriptAgentDeltaEvent
  | TranscriptAgentEvent
  | ReplyDoneEvent
  | ToolCallEvent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function base64EncodePCM(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as never);
  }
  return btoa(binary);
}

export function decodeBase64PCM(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
