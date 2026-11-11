import * as Schema from "effect/Schema";

import { GrokVoiceSentPrompt, GrokVoiceViewed } from "./grokVoice.ts";

/** Voices GPT-Live offers on a ChatGPT subscription. */
export const CHATGPT_VOICES = [
  "cove",
  "arbor",
  "breeze",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
] as const;
export const ChatGptVoiceName = Schema.Literals(CHATGPT_VOICES);

/** The browser's WebRTC offer; the server places the call with the Codex CLI's ChatGPT login. */
export const ChatGptVoiceStartRequest = Schema.Struct({
  sdp: Schema.String,
  voice: ChatGptVoiceName,
  viewed: Schema.optionalKey(GrokVoiceViewed),
  /** The Codex model the delegator thinks with; the server's default when omitted. */
  delegatorModel: Schema.optionalKey(Schema.String),
  /**
   * A call to continue in a fresh realtime session, seeded with that call's notes. Used before a
   * long session runs out of room, and after one drops.
   */
  resume: Schema.optionalKey(Schema.String),
  /** The language the voice always answers in; it matches the user's when omitted. */
  replyLanguage: Schema.optionalKey(Schema.String),
  /** Days to keep the call in the history; 0 doesn't save it. Kept until pruned when omitted. */
  keepDays: Schema.optionalKey(Schema.Number),
});
export type ChatGptVoiceStartRequest = typeof ChatGptVoiceStartRequest.Type;

export const ChatGptVoiceModels = Schema.Struct({
  models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  default: Schema.NullOr(Schema.String),
});
export type ChatGptVoiceModels = typeof ChatGptVoiceModels.Type;

export const ChatGptVoiceStartResult = Schema.Struct({ callId: Schema.String, sdp: Schema.String });
export type ChatGptVoiceStartResult = typeof ChatGptVoiceStartResult.Type;

export const ChatGptVoiceEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("speaking"),
    who: Schema.NullOr(Schema.Literals(["user", "assistant"])),
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("delegating"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("delegated"),
    id: Schema.String,
    speech: Schema.String,
    open: Schema.optionalKey(Schema.String),
    sent: Schema.Array(GrokVoiceSentPrompt),
  }),
  Schema.Struct({ type: Schema.Literal("note"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    reason: Schema.optionalKey(Schema.String),
    /** Only the realtime session ended; the call can go on in a new one with `resume`. */
    resumable: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type ChatGptVoiceEvent = typeof ChatGptVoiceEvent.Type;

export const ChatGptVoiceEvents = Schema.Struct({
  events: Schema.Array(ChatGptVoiceEvent),
  next: Schema.Number,
});
export type ChatGptVoiceEvents = typeof ChatGptVoiceEvents.Type;

export const ChatGptVoiceContextRequest = Schema.Struct({
  viewed: Schema.optionalKey(GrokVoiceViewed),
  /** News for the voice agent to tell the user, such as a thread finishing. */
  announce: Schema.optionalKey(Schema.String),
  /** News the app already told the voice agent itself, kept in the call's notes. */
  remember: Schema.optionalKey(Schema.String),
});
export type ChatGptVoiceContextRequest = typeof ChatGptVoiceContextRequest.Type;

export class ChatGptVoiceError extends Schema.TaggedError<ChatGptVoiceError>()(
  "ChatGptVoiceError",
  {
    reason: Schema.Literals([
      "not-signed-in",
      "rejected",
      "no-voice",
      "rate-limit",
      "no-call",
      "unavailable",
    ]),
    detail: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    switch (this.reason) {
      case "not-signed-in":
        return "Sign in to the Codex CLI with ChatGPT on this computer (run `codex login`) to use ChatGPT voice.";
      case "rejected":
        return "ChatGPT rejected the Codex login. Run `codex login` again.";
      case "no-voice":
        return "Your ChatGPT plan doesn't include voice here, or today's voice allowance is used up.";
      case "rate-limit":
        return "ChatGPT voice limit reached. Try again later.";
      case "no-call":
        return "That ChatGPT voice call has ended.";
      case "unavailable":
        return `ChatGPT voice is unavailable right now.${this.detail ? ` ${this.detail}` : ""}`;
    }
  }
}
