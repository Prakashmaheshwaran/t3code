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

/** The server's own words for why a request failed, when it gave any. */
function serverReason(error: unknown) {
  const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause;
  return typeof cause?.message === "string" ? cause.message : undefined;
}

const ICE_WAIT_MS = 3000;
// Reconnecting again sooner than this means sessions keep failing, so the call ends instead.
const MIN_RESUME_GAP_MS = 60_000;

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
  private utteranceAt = 0;
  private lastDelegation: string | undefined;
  private sentEvents = 0;
  private muted = false;
  private input:
    | { voice: ChatGptVoiceStartRequest["voice"]; delegatorModel?: string | undefined }
    | undefined;
  private viewed: GrokVoiceViewed | undefined;
  private sessionStartedAt = 0;
  private switching = false;
  /** When a dropped session was last continued; a planned refresh doesn't count. */
  private lastResumeAt = 0;

  constructor(prepared: PreparedConnection, callbacks: ChatGptCallCallbacks) {
    this.prepared = prepared;
    this.callbacks = callbacks;
  }

  async start(input: {
    voice: ChatGptVoiceStartRequest["voice"];
    viewed?: GrokVoiceViewed;
    delegatorModel?: string | undefined;
  }) {
    this.input = { voice: input.voice, delegatorModel: input.delegatorModel };
    this.viewed = input.viewed;
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
    // A media element pulls the remote track in Chromium; Web Audio alone can report silence.
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.meter();

    const session = await this.offer();
    try {
      if (this.stopped) throw new Error("Hung up.");
      const started = await runEnvironmentSpeech(
        startChatGptVoiceCall(this.prepared, this.request(session.sdp)),
      );
      this.callId = started.callId;
      if (this.stopped) {
        void this.endOnServer();
        throw new Error("Hung up.");
      }
      await session.peer.setRemoteDescription({ type: "answer", sdp: started.sdp });
    } catch (error) {
      session.peer.close();
      if (this.stopped) return;
      throw error;
    }
    this.use(session.peer, session.channel);
    this.callbacks.onStatus("live");
    void this.follow();
  }

  /** How long the current realtime session has run. */
  get sessionAge() {
    return this.sessionStartedAt ? Date.now() - this.sessionStartedAt : 0;
  }

  /** Moving to a new session right now, after a drop or for a refresh. */
  get switchingSessions() {
    return this.switching;
  }

  /**
   * Moves the call onto a new realtime session, which the server seeds with the call's notes and
   * latest lines. The old session keeps talking until the new one answers.
   */
  async refresh(dropped?: string): Promise<boolean> {
    if (this.stopped || this.switching || !this.callId) return false;
    this.switching = true;
    if (dropped !== undefined) this.lastResumeAt = Date.now();
    let session: Awaited<ReturnType<ChatGptCall["offer"]>> | undefined;
    try {
      session = await this.offer();
      if (this.stopped) throw new Error("Hung up.");
      const resumed = await runEnvironmentSpeech(
        startChatGptVoiceCall(this.prepared, { ...this.request(session.sdp), resume: this.callId }),
      );
      if (this.stopped) throw new Error("stopped");
      await session.peer.setRemoteDescription({ type: "answer", sdp: resumed.sdp });
      const previous = this.peer;
      this.use(session.peer, session.channel);
      previous?.close();
      return true;
    } catch (error) {
      if (session && this.peer !== session.peer) session.peer.close();
      this.stop(serverReason(error) ?? dropped ?? "Couldn't refresh the call.");
      return false;
    } finally {
      this.switching = false;
    }
  }

  private request(sdp: string): ChatGptVoiceStartRequest {
    return {
      sdp,
      voice: this.input?.voice ?? "cove",
      ...(this.input?.delegatorModel ? { delegatorModel: this.input.delegatorModel } : {}),
      ...(this.viewed ? { viewed: this.viewed } : {}),
    };
  }

  /** A peer connection on the call's microphone, with its offer gathered. */
  private async offer() {
    const peer = new RTCPeerConnection();
    const stream = this.stream;
    if (stream) for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const channel = peer.createDataChannel("oai-events");
    // GPT-Live's own events show who is talking without a round trip through the server.
    channel.onmessage = (message: MessageEvent<string>) => {
      if (this.channel === channel) this.onLiveEvent(message.data);
    };
    channel.onopen = () => {
      if (this.channel === channel && this.muted) this.sendLive({ type: "input_audio.pause" });
    };
    peer.ontrack = (event) => {
      if (this.peer === peer && this.audio)
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    };
    peer.onconnectionstatechange = () => {
      // While a new session connects, the old peer failing is expected.
      if (this.peer !== peer || this.switching || peer.connectionState !== "failed") return;
      if (Date.now() - this.lastResumeAt > MIN_RESUME_GAP_MS)
        void this.refresh("The audio connection dropped.");
      else this.stop("The audio connection dropped.");
    };
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
    return { peer, channel, sdp: peer.localDescription?.sdp ?? "" };
  }

  /** Makes a connected session the call's own: its audio plays and its events count. */
  private use(peer: RTCPeerConnection, channel: RTCDataChannel) {
    this.peer = peer;
    this.channel = channel;
    this.lastDelegation = undefined;
    this.utterance = "";
    this.sessionStartedAt = Date.now();
    // A session that dropped mid-turn never said it stopped talking.
    this.callbacks.onEvent({ type: "speaking", who: null });
    const tracks = peer
      .getReceivers()
      .map((receiver) => receiver.track)
      .filter((track) => track.kind === "audio");
    if (this.audio && tracks.length > 0) this.audio.srcObject = new MediaStream(tracks);
    if (channel.readyState === "open" && this.muted) this.sendLive({ type: "input_audio.pause" });
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
      // The server never saw this, and it belongs in the call's notes.
      if (this.callId)
        void runEnvironmentSpeech(
          chatGptVoiceContext(this.prepared, this.callId, { remember: text }),
        ).catch(() => {});
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
    if (viewed) this.viewed = viewed;
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
      // A pause longer than a word gap starts a new utterance.
      const now = Date.now();
      if (now - this.utteranceAt > 1000) this.utterance = "";
      this.utteranceAt = now;
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
          if (event.type === "closed") {
            // A session that drops mid-call is continued once; the server keeps the call meanwhile.
            if (event.resumable && this.switching) continue;
            if (event.resumable && Date.now() - this.lastResumeAt > MIN_RESUME_GAP_MS) {
              this.callbacks.onEvent({ type: "note", text: "The call dropped. Reconnecting…" });
              void this.refresh(event.reason ?? "The call dropped.").then((resumed) => {
                if (resumed) this.callbacks.onEvent({ type: "note", text: "Reconnected." });
              });
              continue;
            }
            return this.stop(event.reason);
          }
          this.callbacks.onEvent(event);
        }
      } catch {
        if (++failures >= 4) return this.stop("Lost touch with the call.");
        await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
      }
    }
  }
}
