import * as Schema from "effect/Schema";

import { GrokVoiceSession } from "./grokVoice.ts";

export const VoiceCallSpeaker = Schema.Literals(["User", "Voice agent", "T3 Code", "Update"]);

export const VoiceCallLine = Schema.Struct({
  at: Schema.Number,
  who: VoiceCallSpeaker,
  text: Schema.String,
});
export type VoiceCallLine = typeof VoiceCallLine.Type;

export const VoiceCallProvider = Schema.Literals(["chatgpt", "grok"]);

/** A finished call in the history, without its transcript. */
export const VoiceCallSummary = Schema.Struct({
  id: Schema.String,
  provider: VoiceCallProvider,
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  notes: Schema.String,
  lineCount: Schema.Number,
});
export type VoiceCallSummary = typeof VoiceCallSummary.Type;

export const VoiceCallList = Schema.Struct({ calls: Schema.Array(VoiceCallSummary) });
export type VoiceCallList = typeof VoiceCallList.Type;

export const VoiceCallRecord = Schema.Struct({
  id: Schema.String,
  provider: VoiceCallProvider,
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  notes: Schema.String,
  lines: Schema.Array(VoiceCallLine),
});
export type VoiceCallRecord = typeof VoiceCallRecord.Type;

export const VoiceCallLookup = Schema.Struct({ call: Schema.NullOr(VoiceCallRecord) });
export type VoiceCallLookup = typeof VoiceCallLookup.Type;

/** History a realtime session starts with, so it knows the call it joins. */
export const VoiceCallSeedItem = Schema.Struct({
  role: Schema.Literals(["developer", "user", "assistant"]),
  text: Schema.String,
});
export type VoiceCallSeedItem = typeof VoiceCallSeedItem.Type;

export const GrokCallStartRequest = Schema.Struct({
  replyLanguage: Schema.optionalKey(Schema.String),
  /** Days to keep the call in the history; 0 doesn't save it. */
  keepDays: Schema.optionalKey(Schema.Number),
});
export type GrokCallStartRequest = typeof GrokCallStartRequest.Type;

/** A Grok call the server remembers, and a realtime session to run it on. */
export const GrokCallSession = Schema.Struct({
  callId: Schema.String,
  session: GrokVoiceSession,
  seed: Schema.Array(VoiceCallSeedItem),
});
export type GrokCallSession = typeof GrokCallSession.Type;

export const GrokCallLines = Schema.Struct({
  lines: Schema.Array(
    Schema.Struct({
      who: Schema.Literals(["User", "Voice agent", "Update"]),
      text: Schema.String,
    }),
  ),
});
export type GrokCallLines = typeof GrokCallLines.Type;
