import * as Schema from "effect/Schema";

/** A short-lived xAI realtime credential; the Grok CLI login never leaves the server. */
export const GrokVoiceSession = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
});
export type GrokVoiceSession = typeof GrokVoiceSession.Type;

/** One voice request for the stateless delegator, which acts through this server's MCP tools. */
export const GrokVoiceDelegateRequest = Schema.Struct({
  /** What the voice agent heard the user ask. */
  request: Schema.String,
  /** Both sides of the call since the previous delegation, as `User: …` / `Voice agent: …` lines. */
  transcript: Schema.Array(Schema.String),
  viewed: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.optionalKey(Schema.String),
      projectId: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Threads that already got the full voice-delegation header in this call. */
  explained: Schema.Array(Schema.String),
});
export type GrokVoiceDelegateRequest = typeof GrokVoiceDelegateRequest.Type;

export const GrokVoiceSentPrompt = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  instruction: Schema.String,
});
export type GrokVoiceSentPrompt = typeof GrokVoiceSentPrompt.Type;

export const GrokVoiceDelegateResult = Schema.Struct({
  speech: Schema.String,
  /** A thread the client should show; MCP cannot move the user's screen. */
  open: Schema.optionalKey(Schema.String),
  /** Work admitted this request, for announcing replies when they land. */
  sent: Schema.Array(GrokVoiceSentPrompt),
  explained: Schema.Array(Schema.String),
});
export type GrokVoiceDelegateResult = typeof GrokVoiceDelegateResult.Type;

export class GrokVoiceError extends Schema.TaggedError<GrokVoiceError>()(
  "GrokVoiceError",
  {
    reason: Schema.Literals(["not-signed-in", "rejected", "rate-limit", "unavailable"]),
    detail: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    switch (this.reason) {
      case "not-signed-in":
        return "Sign in to the Grok CLI on this computer (run `grok`) to use Grok voice.";
      case "rejected":
        return "xAI rejected the Grok login. Run `grok` once to refresh it, then try again.";
      case "rate-limit":
        return "Your Grok plan reached a usage limit. Try again later.";
      case "unavailable":
        return `Grok voice is unavailable right now.${this.detail ? ` ${this.detail}` : ""}`;
    }
  }
}
