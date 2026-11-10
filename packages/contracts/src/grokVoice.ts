import * as Schema from "effect/Schema";

/** A short-lived xAI realtime credential; the Grok CLI login never leaves the server. */
export const GrokVoiceSession = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
});
export type GrokVoiceSession = typeof GrokVoiceSession.Type;

/** One stateless delegator round, forwarded to xAI's Responses API with the server's Grok login. */
export const GrokVoiceRespondRequest = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  instructions: Schema.String,
  input: Schema.Array(Schema.Unknown),
  tools: Schema.Array(Schema.Unknown),
});
export type GrokVoiceRespondRequest = typeof GrokVoiceRespondRequest.Type;

export const GrokVoiceRespondResult = Schema.Struct({
  output: Schema.Array(Schema.Unknown),
});
export type GrokVoiceRespondResult = typeof GrokVoiceRespondResult.Type;

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
