// Browser side of a Grok voice call: one WebSocket to xAI's realtime API (OpenAI-compatible
// events), the microphone in, and scheduled PCM playback out. No React here.

import captureWorkletUrl from "./captureWorklet.ts?worker&url";
import { openCallMicrophone, watchMicrophone } from "./microphone";

const SAMPLE_RATE = 24_000;

export interface RealtimeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface RealtimeCallbacks {
  readonly onStatus: (status: "connecting" | "live" | "closed", detail?: string) => void;
  readonly onUserTranscript: (text: string) => void;
  readonly onAssistantTranscript: (text: string) => void;
  readonly onSpeaking: (who: "user" | "assistant" | null) => void;
  readonly onToolCall: (call: { callId: string; name: string; args: unknown }) => void;
  readonly onLevel?: (level: number) => void;
  readonly onNote?: (text: string) => void;
}

export interface RealtimeOptions {
  readonly url: string;
  readonly token: string;
  readonly instructions: string;
  readonly voice: string;
  readonly tools: ReadonlyArray<RealtimeTool>;
}

function toBase64Pcm16(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64Pcm16(data: string) {
  const binary = atob(data);
  const out = new Float32Array(binary.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
  }
  return out;
}

export class GrokRealtimeCall {
  private ws: WebSocket | undefined;
  private context: AudioContext | undefined;
  private stream: MediaStream | undefined;
  private playhead = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private muted = false;
  private heard: ((level: number) => void) | undefined;
  private closed = false;
  private userText = "";
  private assistantText = "";
  private responseActive = false;
  private pendingResponses: unknown[] = [];

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  async start(options: RealtimeOptions) {
    this.callbacks.onStatus("connecting");
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Created after awaits, so Chrome no longer counts the click and starts it suspended.
    void this.context.resume().catch(() => {});
    try {
      this.stream = await openCallMicrophone();
      const note = this.callbacks.onNote;
      this.heard = note ? watchMicrophone(this.stream, note) : undefined;
      await this.context.audioWorklet.addModule(captureWorkletUrl);
      const source = this.context.createMediaStreamSource(this.stream);
      const capture = new AudioWorkletNode(this.context, "grok-capture");
      // A silent sink keeps the worklet pulled without echoing the microphone.
      const sink = this.context.createGain();
      sink.gain.value = 0;
      source.connect(capture).connect(sink).connect(this.context.destination);
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => this.onMicFrame(event.data);
    } catch (error) {
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      this.callbacks.onNote?.(
        denied
          ? "Microphone access is blocked. Allow it for T3 Code, or type to Grok instead."
          : "No microphone available. Type to Grok instead.",
      );
    }

    const ws = new WebSocket(options.url, [`xai-client-secret.${options.token}`]);
    this.ws = ws;
    ws.onmessage = (event) => this.onEvent(JSON.parse(String(event.data)));
    ws.onclose = (event) => {
      if (!this.closed) this.stop(event.reason || `Connection closed (${event.code}).`);
    };
    ws.onerror = () => {
      if (!this.closed) this.stop("Couldn't reach Grok voice.");
    };
    ws.onopen = () => {
      this.send({
        type: "session.update",
        session: {
          instructions: options.instructions,
          voice: options.voice,
          turn_detection: { type: "server_vad" },
          audio: {
            input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
            output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
          },
          tools: options.tools.map((tool) => ({ type: "function", ...tool })),
        },
      });
      this.callbacks.onStatus("live");
    };
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  /** Answers a tool call; the model speaks again once the output lands. */
  sendToolOutput(callId: string, output: unknown) {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    this.requestResponse();
  }

  /** Typed input, for when speaking isn't an option. */
  say(text: string) {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.requestResponse();
  }

  /** Out-of-band news (a thread finished): spoken once, and never able to trigger tools. */
  announce(text: string) {
    // xAI ignores per-response instructions once a conversation has history, so the news is an item.
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `[Status update from T3 Code, not a request from me] ${text}`,
          },
        ],
      },
    });
    this.requestResponse({ tool_choice: "none" });
  }

  stop(detail?: string) {
    if (this.closed) return;
    this.closed = true;
    this.stopPlayback();
    try {
      this.ws?.close(1000);
    } catch {}
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    this.callbacks.onSpeaking(null);
    this.callbacks.onStatus("closed", detail);
  }

  private requestResponse(response?: Record<string, unknown>) {
    const event = response ? { type: "response.create", response } : { type: "response.create" };
    // Overlapping response.create calls are rejected, so wait for the current one to finish.
    if (this.responseActive) this.pendingResponses.push(event);
    else this.send(event);
  }

  private send(event: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  private onMicFrame(frame: Float32Array) {
    let peak = 0;
    for (let i = 0; i < frame.length; i += 8) peak = Math.max(peak, Math.abs(frame[i]!));
    this.callbacks.onLevel?.(this.muted ? 0 : peak);
    if (this.muted) return;
    this.heard?.(peak);
    this.send({ type: "input_audio_buffer.append", audio: toBase64Pcm16(frame) });
  }

  private stopPlayback() {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {}
    }
    this.playing.clear();
    this.playhead = 0;
  }

  private play(delta: string) {
    const context = this.context;
    if (!context) return;
    const samples = fromBase64Pcm16(delta);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    const at = Math.max(this.playhead, context.currentTime + 0.02);
    node.start(at);
    this.playhead = at + buffer.duration;
    this.playing.add(node);
    this.callbacks.onSpeaking("assistant");
    node.onended = () => {
      this.playing.delete(node);
      if (this.playing.size === 0) this.callbacks.onSpeaking(null);
    };
  }

  private onEvent(event: { type: string; [key: string]: unknown }) {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        // Barge-in: the user talking over Grok cuts its audio immediately.
        this.stopPlayback();
        this.callbacks.onSpeaking("user");
        return;
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onSpeaking(null);
        return;
      case "conversation.item.input_audio_transcription.delta":
        this.userText += String(event.delta ?? "");
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? this.userText).trim();
        this.userText = "";
        if (text) this.callbacks.onUserTranscript(text);
        return;
      }
      case "response.created":
        this.responseActive = true;
        return;
      case "response.done":
        this.responseActive = false;
        {
          const next = this.pendingResponses.shift();
          if (next) {
            this.responseActive = true;
            this.send(next);
          }
        }
        return;
      case "response.output_audio.delta":
        this.play(String(event.delta ?? ""));
        return;
      case "response.output_audio_transcript.delta":
        this.assistantText += String(event.delta ?? "");
        return;
      case "response.output_audio_transcript.done": {
        const text = String(event.transcript ?? this.assistantText).trim();
        this.assistantText = "";
        if (text) this.callbacks.onAssistantTranscript(text);
        return;
      }
      case "response.function_call_arguments.done": {
        let args: unknown = {};
        try {
          args = JSON.parse(String(event.arguments ?? "{}"));
        } catch {}
        this.callbacks.onToolCall({
          callId: String(event.call_id),
          name: String(event.name),
          args,
        });
        return;
      }
      case "error": {
        const error = event.error as { message?: string } | undefined;
        console.warn("[grok-voice]", error?.message ?? event);
        return;
      }
    }
  }
}
