// While a call is muted the voice model hears nothing, so "unmute" has to be caught here. T3
// Code's on-device transcription does it when a streaming model is installed; Chrome's speech
// recognition is the fallback. Either listens to a copy of the call's microphone.

import {
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
} from "@t3tools/client-runtime/voice-input";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";

import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import type { readPreparedConnection } from "../state/session";
import captureWorkletUrl from "./captureWorklet.ts?worker&url";

type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

// The server caps one transcription stream at five minutes of audio.
const SESSION_ROTATE_MS = 4 * 60_000;
const SESSION_OVERLAP_MS = 3000;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Mute", "mute yourself", "go on mute"; not a sentence that merely contains the word. */
export function isMuteCommand(text: string) {
  return /^(please |ok(ay)? |hey )?(mute|go (on )?mute|mute (yourself|myself|me|the mic|the microphone|now|please)|stop listening)( please| now)?$/.test(
    words(text),
  );
}

export function mentionsUnmute(text: string) {
  return /\bun ?-?mute\b/.test(words(text));
}

export interface UnmuteListener {
  readonly stop: () => void;
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function browserRecognition(onUnmute: () => void, onFailed: () => void): UnmuteListener | null {
  const scope = window as unknown as Record<string, (new () => Recognition) | undefined>;
  const Constructor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Constructor) return null;
  const recognition = new Constructor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  let stopped = false;
  recognition.onresult = (event) => {
    for (const result of Array.from(event.results))
      if (mentionsUnmute(result[0]?.transcript ?? "")) {
        stopped = true;
        recognition.stop();
        onUnmute();
        return;
      }
  };
  recognition.onerror = (event) => {
    // "no-speech" and "aborted" are routine; anything else means it can't hear at all here.
    if (event.error === "no-speech" || event.error === "aborted") return;
    stopped = true;
    onFailed();
  };
  recognition.onend = () => {
    if (!stopped) recognition.start();
  };
  recognition.start();
  return {
    stop: () => {
      stopped = true;
      recognition.stop();
    },
  };
}

async function localTranscription(
  prepared: PreparedConnection,
  microphone: MediaStream,
  onUnmute: () => void,
  onFailed: () => void,
): Promise<UnmuteListener | null> {
  const status = await runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared)).catch(() => null);
  if (
    !status?.supported ||
    status.state === "missing-model" ||
    !(status.supportsStreaming || status.supportsBufferedStreaming)
  )
    return null;
  const source = microphone.getAudioTracks()[0];
  if (!source) return null;
  // A copy stays live while the call's own track is disabled for muting.
  const track = source.clone();
  track.enabled = true;
  const context = new AudioContext({ sampleRate: 16_000 });
  await context.resume();
  await context.audioWorklet.addModule(captureWorkletUrl);
  const capture = new AudioWorkletNode(context, "grok-capture");
  const sink = context.createGain();
  sink.gain.value = 0;
  context
    .createMediaStreamSource(new MediaStream([track]))
    .connect(capture)
    .connect(sink);
  sink.connect(context.destination);

  let stopped = false;
  const sessions: { feed: (pcm: Float32Array) => void; cancel: () => void }[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(rotation);
    for (const session of sessions.splice(0)) session.cancel();
    track.stop();
    void context.close().catch(() => {});
  };
  const open = async () => {
    const abort = new AbortController();
    const url = await runEnvironmentSpeech(getEnvironmentSpeechStreamUrl(prepared), {
      signal: abort.signal,
    });
    if (stopped) return;
    const session = openSpeechStream({
      url,
      options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      signal: abort.signal,
      canSend: () => !stopped,
      onText: ({ committed, tentative }) => {
        if (stopped || !mentionsUnmute(`${committed} ${tentative}`)) return;
        stop();
        onUnmute();
      },
      onError: () => {
        if (stopped || !sessions.includes(session)) return;
        stop();
        onFailed();
      },
    });
    sessions.push(session);
  };
  capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
    sessions.at(-1)?.feed(event.data);
  };
  const rotation = setInterval(() => {
    const previous = sessions.at(-1);
    void open().then(() =>
      setTimeout(() => {
        previous?.cancel();
        const index = previous ? sessions.indexOf(previous) : -1;
        if (index >= 0) sessions.splice(index, 1);
      }, SESSION_OVERLAP_MS),
    );
  }, SESSION_ROTATE_MS);
  try {
    await open();
  } catch {
    stop();
    return null;
  }
  return { stop };
}

/**
 * Listens for "unmute" until heard or stopped. Resolves to null when nothing here can listen,
 * and calls `onFailed` if listening stops working later.
 */
export async function listenForUnmute(input: {
  prepared: PreparedConnection;
  microphone: MediaStream | undefined;
  onUnmute: () => void;
  onFailed: () => void;
}): Promise<{ listener: UnmuteListener; via: "on-device" | "browser" } | null> {
  if (input.microphone) {
    const local = await localTranscription(
      input.prepared,
      input.microphone,
      input.onUnmute,
      input.onFailed,
    ).catch(() => null);
    if (local) return { listener: local, via: "on-device" };
  }
  const browser = browserRecognition(input.onUnmute, input.onFailed);
  return browser ? { listener: browser, via: "browser" } : null;
}
