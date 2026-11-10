// Browser side of a ChatGPT (GPT-Live) voice call: WebRTC audio straight to OpenAI. The server
// places the call with the Codex CLI's ChatGPT login and owns the control channel, so this only
// carries audio and follows the server's events with a long poll.

import {
  chatGptVoiceContext,
  chatGptVoiceEvents,
  endChatGptVoiceCall,
  startChatGptVoiceCall,
} from "@t3tools/client-runtime/voice-input";
import type {
  ChatGptVoiceEvent,
  GrokVoiceViewed,
  ChatGptVoiceStartRequest,
} from "@t3tools/contracts";

import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { openCallMicrophone, watchMicrophone } from "./microphone";
import type { readPreparedConnection } from "../state/session";

type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

export interface ChatGptCallCallbacks {
  readonly onStatus: (status: "live" | "closed", detail?: string) => void;
  readonly onEvent: (event: ChatGptVoiceEvent) => void;
  readonly onLevel: (level: number) => void;
  /** The user's words so far, as GPT-Live hears them; called again as each piece arrives. */
  readonly onUtterance?: (text: string) => void;
}

// GPT-Live caps context appends at 500 tokens; bytes are a conservative stand-in.
function speakableChunks(text: string) {
  const parts: string[] = [];
  let current = "";
  for (const character of text) {
    if (new TextEncoder().encode(current + character).length > 500) {
      parts.push(current);
      current = "";
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

const ICE_WAIT_MS = 3000;

export class ChatGptCall {
  private readonly prepared: PreparedConnection;
  private readonly callbacks: ChatGptCallCallbacks;
  private peer: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private stream: MediaStream | undefined;
  private audio: HTMLAudioElement | undefined;
  private context: AudioContext | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private callId: string | undefined;
  private stopped = false;
  private utterance = "";
  private lastDelegation: string | undefined;
  private sentEvents = 0;
  private muted = false;

  constructor(prepared: PreparedConnection, callbacks: ChatGptCallCallbacks) {
    this.prepared = prepared;
    this.callbacks = callbacks;
  }

  async start(input: {
    voice: ChatGptVoiceStartRequest["voice"];
    viewed?: GrokVoiceViewed;
    delegatorModel?: string | undefined;
  }) {
    try {
      this.stream = await openCallMicrophone();
    } catch (error) {
      throw new Error(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "ChatGPT voice needs the microphone. Allow it for T3 Code and try again."
          : "ChatGPT voice needs a microphone.",
        { cause: error },
      );
    }
    const peer = new RTCPeerConnection();
    this.peer = peer;
    for (const track of this.stream.getAudioTracks()) peer.addTrack(track, this.stream);
    this.channel = peer.createDataChannel("oai-events");
    // GPT-Live's own events show who is talking without a round trip through the server.
    this.channel.onmessage = (message: MessageEvent<string>) => this.onLiveEvent(message.data);
    // A media element pulls the remote track in Chromium; Web Audio alone can report silence.
    this.audio = new Audio();
    this.audio.autoplay = true;
    peer.ontrack = (event) => {
      if (this.audio) this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") this.stop("The audio connection dropped.");
    };
    this.meter();

    await peer.setLocalDescription(await peer.createOffer());
    await new Promise<void>((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, ICE_WAIT_MS);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState !== "complete") return;
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.stopped) return;
    const started = await runEnvironmentSpeech(
      startChatGptVoiceCall(this.prepared, {
        sdp: peer.localDescription?.sdp ?? "",
        voice: input.voice,
        ...(input.delegatorModel ? { delegatorModel: input.delegatorModel } : {}),
        ...(input.viewed ? { viewed: input.viewed } : {}),
      }),
    );
    this.callId = started.callId;
    if (this.stopped) {
      void this.endOnServer();
      return;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: started.sdp });
    this.callbacks.onStatus("live");
    void this.follow();
  }

  /** The microphone the call hears, for listening locally while muted. */
  get microphone() {
    return this.stream;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    // GPT-Live's own pause; it rejects other mute events, and silence alone still holds the turn.
    this.sendLive({ type: muted ? "input_audio.pause" : "input_audio.resume" });
  }

  /**
   * News for the voice agent to tell the user; it can never trigger a delegation. It goes over
   * the call's own channel: Codex's appendSpeech is only spoken inside a pending handoff, and
   * once any handoff happened GPT-Live ignores session context, so news joins the last one.
   */
  announce(text: string) {
    if (this.channel?.readyState === "open") {
      for (const part of speakableChunks(text))
        this.sendLive(
          this.lastDelegation
            ? {
                type: "delegation.context.append",
                delegation_item_id: this.lastDelegation,
                channel: "speakable",
                content: [{ type: "input_text", text: part }],
              }
            : {
                type: "session.context.append",
                channel: "commentary",
                content: [{ type: "input_text", text: part }],
              },
        );
      return;
    }
    if (!this.callId) return;
    void runEnvironmentSpeech(
      chatGptVoiceContext(this.prepared, this.callId, { announce: text }),
    ).catch(() => {});
  }

  private sendLive(event: Record<string, unknown>) {
    if (this.channel?.readyState === "open")
      this.channel.send(JSON.stringify({ event_id: `t3_${++this.sentEvents}`, ...event }));
  }

  updateViewed(viewed: GrokVoiceViewed | undefined) {
    if (!this.callId || !viewed) return;
    void runEnvironmentSpeech(chatGptVoiceContext(this.prepared, this.callId, { viewed })).catch(
      () => {},
    );
  }

  stop(detail?: string) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.levelTimer);
    void this.endOnServer();
    this.peer?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.audio) this.audio.srcObject = null;
    void this.context?.close().catch(() => {});
    this.callbacks.onStatus("closed", detail);
  }

  private onLiveEvent(data: string) {
    let event: {
      type?: string;
      turn?: { role?: string; transcript?: string };
      item?: { text?: string; id?: string };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return;
    }
    const speaking = (who: "user" | "assistant" | null) =>
      this.callbacks.onEvent({ type: "speaking", who });
    if (event.type === "delegation.created" && event.item?.id) this.lastDelegation = event.item.id;
    else if (event.type === "input_transcript.added") {
      // GPT-Live never closes a user turn with turn.done, so the words are checked as they land.
      this.utterance = (this.utterance + (event.item?.text ?? "")).slice(-240);
      speaking("user");
      if (this.utterance.trim()) this.callbacks.onUtterance?.(this.utterance.trim());
    } else if (event.type === "output_transcript.added") {
      this.utterance = "";
      speaking("assistant");
    } else if (event.type === "turn.created" && event.turn?.role === "assistant")
      this.utterance = "";
    else if (event.type === "turn.done" || event.type === "output_audio_buffer.cleared") {
      speaking(null);
      if (event.turn?.role === "user") {
        const said = (event.turn.transcript ?? this.utterance).trim();
        if (said) this.callbacks.onUtterance?.(said);
      }
      this.utterance = "";
    } else if (event.type === "error" && import.meta.env.DEV)
      console.warn("[chatgpt-voice] Live rejected an event", event.error?.message);
  }

  private endOnServer() {
    if (!this.callId) return Promise.resolve();
    return runEnvironmentSpeech(endChatGptVoiceCall(this.prepared, this.callId)).catch(() => {});
  }

  private meter() {
    if (!this.stream) return;
    this.context = new AudioContext();
    // Created after awaits, so Chrome no longer counts the click and starts it suspended.
    void this.context.resume().catch(() => {});
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const heard = watchMicrophone(this.stream, (text) =>
      this.callbacks.onEvent({ type: "note", text }),
    );
    this.levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (let index = 0; index < samples.length; index += 4)
        peak = Math.max(peak, Math.abs(samples[index]!));
      if (!this.muted) heard(peak);
      this.callbacks.onLevel(this.muted ? 0 : peak);
    }, 100);
  }

  /** The server buffers the call's events; each poll returns at once or within 25 seconds. */
  private async follow() {
    let after = 0;
    let failures = 0;
    while (!this.stopped && this.callId) {
      try {
        const batch = await runEnvironmentSpeech(
          chatGptVoiceEvents(this.prepared, this.callId, after),
        );
        failures = 0;
        after = batch.next;
        for (const event of batch.events) {
          if (event.type === "closed") return this.stop(event.reason);
          this.callbacks.onEvent(event);
        }
      } catch {
        if (++failures >= 4) return this.stop("Lost touch with the call.");
        await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
      }
    }
  }
}
