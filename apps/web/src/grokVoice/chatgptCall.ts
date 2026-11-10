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
import type { readPreparedConnection } from "../state/session";

type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

export interface ChatGptCallCallbacks {
  readonly onStatus: (status: "live" | "closed", detail?: string) => void;
  readonly onEvent: (event: ChatGptVoiceEvent) => void;
  readonly onLevel: (level: number) => void;
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

  constructor(prepared: PreparedConnection, callbacks: ChatGptCallCallbacks) {
    this.prepared = prepared;
    this.callbacks = callbacks;
  }

  async start(input: { voice: ChatGptVoiceStartRequest["voice"]; viewed?: GrokVoiceViewed }) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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

  setMuted(muted: boolean) {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (this.channel?.readyState === "open")
      this.channel.send(
        JSON.stringify({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" }),
      );
  }

  /** News for the voice agent to tell the user; it can never trigger a delegation. */
  announce(text: string) {
    if (!this.callId) return;
    void runEnvironmentSpeech(
      chatGptVoiceContext(this.prepared, this.callId, { announce: text }),
    ).catch(() => {});
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

  private endOnServer() {
    if (!this.callId) return Promise.resolve();
    return runEnvironmentSpeech(endChatGptVoiceCall(this.prepared, this.callId)).catch(() => {});
  }

  private meter() {
    if (!this.stream) return;
    this.context = new AudioContext();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (let index = 0; index < samples.length; index += 4)
        peak = Math.max(peak, Math.abs(samples[index]!));
      this.callbacks.onLevel(peak);
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
