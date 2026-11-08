import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useAtomCommand } from "~/state/use-atom-command";
import { voiceEnvironment } from "~/state/voice";

type CallState = "idle" | "connecting" | "live" | "error" | "closed";

type VoiceEvent = {
  readonly type: string;
  readonly payload: unknown;
};

const MAX_LOG_LINES = 8;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined;
}

function payloadText(payload: unknown) {
  const record = payloadRecord(payload);
  if (record === undefined) return undefined;
  for (const key of ["message", "error", "reason", "text", "delta"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(finish, 2_500);
    function finish() {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (peer.iceGatheringState === "complete") finish();
    }
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

function VoiceEventListener(props: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadId: ScopedThreadRef["threadId"];
  readonly onEvent: (event: VoiceEvent) => void;
}) {
  const { environmentId, threadId, onEvent } = props;
  const result = useAtomValue(
    voiceEnvironment.events({
      environmentId,
      input: { threadId },
    }),
  );
  const last = useRef<VoiceEvent | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards a live RPC event from the call's server stream to the call handler; the stream is external to React
  useEffect(() => {
    if (!AsyncResult.isSuccess(result)) return;
    const event = result.value;
    if (event === last.current) return;
    last.current = event;
    onEvent(event);
  }, [onEvent, result]);

  return null;
}

function VoiceCallWidgetForThread(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const start = useAtomCommand(voiceEnvironment.start);
  const stop = useAtomCommand(voiceEnvironment.stop);

  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [caption, setCaption] = useState("");
  const [log, setLog] = useState<Array<{ readonly id: number; readonly text: string }>>([]);
  const [open, setOpen] = useState(false);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const captionRef = useRef("");
  const logID = useRef(0);

  const active = state === "connecting" || state === "live" || state === "error";

  const release = useStableCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioRef.current !== null) audioRef.current.srcObject = null;
    captionRef.current = "";
    setCaption("");
    setMuted(false);
  });

  const endCall = async (nextState: CallState = "idle") => {
    await stop({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).catch(() => undefined);
    release();
    setState(nextState);
    setOpen(false);
  };

  const handleEvent = useStableCallback((event: VoiceEvent) => {
    const payload = payloadRecord(event.payload);
    switch (event.type) {
      case "started":
        setState("live");
        return;
      case "sdp": {
        const sdp = typeof payload?.sdp === "string" ? payload.sdp : undefined;
        if (sdp === undefined || peerRef.current === null) return;
        void peerRef.current
          .setRemoteDescription({ type: "answer", sdp })
          .then(() => {
            setState("live");
            setError(null);
          })
          .catch((cause) => {
            setState("error");
            setError(errorText(cause));
          });
        return;
      }
      case "transcript/delta": {
        const delta = typeof payload?.delta === "string" ? payload.delta : "";
        if (delta.length === 0) return;
        captionRef.current += delta;
        setCaption(captionRef.current);
        return;
      }
      case "transcript/done": {
        const text =
          typeof payload?.text === "string" && payload.text.trim().length > 0
            ? payload.text
            : captionRef.current;
        if (text.trim().length === 0) return;
        const id = ++logID.current;
        setLog((current) => [...current.slice(-(MAX_LOG_LINES - 1)), { id, text: text.trim() }]);
        captionRef.current = "";
        setCaption("");
        return;
      }
      case "error": {
        const message = payloadText(event.payload) ?? "The voice call failed.";
        setError(message);
        setState("error");
        return;
      }
      case "closed": {
        release();
        setState("closed");
        return;
      }
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the ended-call badge visible briefly before returning the widget to idle
  useEffect(() => {
    if (state !== "closed") return;
    const timer = window.setTimeout(() => {
      setState("idle");
      setOpen(false);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [state]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the peer connection and microphone tracks when the thread view unmounts
  useEffect(() => () => release(), [release]);

  const beginCall = async () => {
    if (active) {
      setOpen(true);
      return;
    }
    setOpen(true);
    setState("connecting");
    setError(null);
    setCaption("");
    setLog([]);
    captionRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      streamRef.current = stream;
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      peer.ontrack = (event) => {
        const [remote] = event.streams;
        if (audioRef.current !== null && remote !== undefined) {
          audioRef.current.srcObject = remote;
          void audioRef.current.play().catch(() => undefined);
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          setError("The audio connection failed. End the call and try again.");
          setState("error");
        }
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      peer.createDataChannel("oai-events");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const sdp = peer.localDescription?.sdp;
      if (sdp === undefined) throw new Error("Could not create a WebRTC offer.");
      const result = await start({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, sdp },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      release();
      setError(errorText(cause));
      setState("error");
    }
  };

  const toggleMute = () => {
    setMuted((current) => {
      const next = !current;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  };

  const statusLabel =
    state === "connecting"
      ? "Connecting…"
      : state === "live"
        ? "Live"
        : state === "error"
          ? "Needs attention"
          : state === "closed"
            ? "Call ended"
            : "Ready";

  return (
    <div className="pointer-events-none fixed right-4 bottom-24 z-50 flex flex-col items-end gap-2">
      {open ? (
        <div className="pointer-events-auto w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border bg-background/95 p-3 text-foreground shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`size-2.5 shrink-0 rounded-full ${
                  state === "live"
                    ? "bg-success"
                    : state === "connecting"
                      ? "animate-pulse bg-warning"
                      : state === "error"
                        ? "bg-destructive"
                        : "bg-muted-foreground"
                }`}
              />
              <span className="truncate text-sm font-medium">Voice call</span>
              <span className="truncate text-xs text-muted-foreground">{statusLabel}</span>
            </div>
            <button
              type="button"
              aria-label="Close voice call panel"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              <XIcon className="size-4" />
            </button>
          </div>

          <div className="mt-3 min-h-20 max-h-48 overflow-y-auto rounded-xl bg-muted/50 p-2.5 text-xs leading-relaxed">
            {log.length === 0 && caption.length === 0 ? (
              <p className="text-muted-foreground">
                {state === "error"
                  ? "Send a message in this thread first so the Codex session opens, then try again."
                  : "Talk naturally. Your request is handed to this thread and the result is spoken back."}
              </p>
            ) : (
              <>
                {log.map((line) => (
                  <p key={line.id} className="mb-1.5 last:mb-0">
                    {line.text}
                  </p>
                ))}
                {caption.length > 0 ? (
                  <p className="mb-0 text-foreground/80 italic">{caption}</p>
                ) : null}
              </>
            )}
          </div>

          {error !== null ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              disabled={state !== "live" && state !== "connecting"}
              onClick={toggleMute}
            >
              {muted ? <MicOffIcon className="size-3.5" /> : <MicIcon className="size-3.5" />}
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
              onClick={() => void endCall()}
            >
              <PhoneOffIcon className="size-3.5" />
              End call
            </button>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        aria-label={active ? "Open voice call" : "Start voice call"}
        className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2.5 text-sm font-medium shadow-lg transition hover:bg-muted ${
          state === "live" ? "border-success/60" : ""
        }`}
        onClick={() => {
          if (active) {
            setOpen(true);
            return;
          }
          void beginCall();
        }}
      >
        {state === "live" ? (
          <span className="size-2.5 rounded-full bg-success" />
        ) : (
          <PhoneIcon className="size-4" />
        )}
        {active ? "Voice" : "Call"}
      </button>

      {active ? (
        <VoiceEventListener
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          onEvent={handleEvent}
        />
      ) : null}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
    </div>
  );
}

export function VoiceCallWidget(props: { readonly threadRef: ScopedThreadRef | null }) {
  if (props.threadRef === null) return null;
  return <VoiceCallWidgetForThread threadRef={props.threadRef} />;
}
