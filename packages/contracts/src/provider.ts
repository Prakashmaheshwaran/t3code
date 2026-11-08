import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

export const VoiceCallStartInput = Schema.Struct({
  threadId: ThreadId,
  /** Browser SDP offer for the WebRTC audio transport. */
  sdp: TrimmedNonEmptyString,
  prompt: Schema.optional(TrimmedNonEmptyString),
  voice: Schema.optional(TrimmedNonEmptyString),
});
export type VoiceCallStartInput = typeof VoiceCallStartInput.Type;

export const VoiceCallStopInput = Schema.Struct({
  threadId: ThreadId,
});
export type VoiceCallStopInput = typeof VoiceCallStopInput.Type;

export const VoiceCallSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type VoiceCallSubscribeInput = typeof VoiceCallSubscribeInput.Type;

/** One raw `thread/realtime/*` notification; `type` omits the `thread/realtime/` prefix. */
export const VoiceCallStreamEvent = Schema.Struct({
  type: Schema.String,
  payload: Schema.Unknown,
});
export type VoiceCallStreamEvent = typeof VoiceCallStreamEvent.Type;

export class VoiceCallError extends Schema.TaggedError<VoiceCallError>()("VoiceCallError", {
  threadId: ThreadId,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
