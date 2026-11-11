import { MicIcon, MicOffIcon, PhoneOffIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import {
  VOICE_PROVIDERS,
  endGrokVoiceCall,
  sendGrokVoiceText,
  setGrokVoice,
  toggleGrokVoiceMute,
  useGrokVoiceStore,
} from "./call";

/** The call so far. It follows `lines` alone, so the level meter doesn't re-render it. */
function CallTranscript({ name }: { name: string }) {
  const lines = useGrokVoiceStore((state) => state.lines);
  const list = useRef<HTMLOListElement>(null);
  // Follows new lines unless the user scrolled up to read.
  const pinned = useRef(true);
  const lastId = lines.at(-1)?.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the list's DOM scroll position on the newest line, and re-pins when a new call clears it
  useLayoutEffect(() => {
    const element = list.current;
    if (lastId === undefined) pinned.current = true;
    else if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lastId]);
  return (
    <ol
      ref={list}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs"
    >
      {lines.map((line) => (
        <li
          key={line.id}
          className={cn(
            line.who === "you" && "text-foreground",
            line.who === "grok" && "text-muted-foreground",
            line.who === "note" && "text-muted-foreground italic",
          )}
        >
          <span className="font-medium">
            {line.who === "you" ? "You: " : line.who === "grok" ? `${name}: ` : ""}
          </span>
          {line.text}
        </li>
      ))}
    </ol>
  );
}

/** Floating call surface; renders nothing unless a call is on, just ended, or just failed. */
export function GrokVoiceCallPanel() {
  const { status, error, hasLines, speaking, muted, delegating, level, voice, provider, canType } =
    useGrokVoiceStore(
      useShallow((state) => ({
        status: state.status,
        error: state.error,
        hasLines: state.lines.length > 0,
        speaking: state.speaking,
        muted: state.muted,
        delegating: state.delegating,
        level: state.level,
        voice: state.voice,
        provider: state.provider,
        canType: state.canType,
      })),
    );
  const name = VOICE_PROVIDERS[provider].label;
  // A finished call's transcript stays until dismissed.
  if (status === "idle" && !error && !hasLines) return null;

  const label =
    status === "connecting"
      ? "Connecting…"
      : delegating > 0
        ? "Working on it…"
        : speaking === "assistant"
          ? `${name} is speaking`
          : speaking === "user"
            ? "Listening"
            : muted
              ? "Muted"
              : "Live";

  return (
    <div
      role="region"
      aria-label="Voice call"
      className="pointer-events-auto fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            status === "live"
              ? "bg-success"
              : status === "connecting"
                ? "bg-warning"
                : "bg-muted-foreground",
          )}
        />
        <span className="text-sm font-medium">{name} voice</span>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {status === "idle" ? "Ended" : label}
        </span>
        {delegating > 0 || status === "connecting" ? <Spinner className="size-3" /> : null}
        {status === "idle" ? (
          <Button
            variant="ghost-muted"
            size="icon-micro"
            className="ml-auto"
            aria-label="Dismiss"
            onClick={() => useGrokVoiceStore.setState({ error: null, lines: [] })}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}

      {hasLines ? (
        <CallTranscript name={name} />
      ) : status === "live" ? (
        <p className="text-xs text-muted-foreground">
          Say what you want done. {name} hands it to your threads.
        </p>
      ) : null}

      {status === "live" && canType ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem("grok-text");
            if (!(input instanceof HTMLInputElement)) return;
            sendGrokVoiceText(input.value);
            input.value = "";
          }}
        >
          <Input
            name="grok-text"
            size="compact"
            nativeInput
            placeholder="Type instead…"
            aria-label="Type to Grok"
            autoComplete="off"
          />
        </form>
      ) : null}

      {status !== "idle" ? (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            onClick={toggleGrokVoiceMute}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </Button>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full bg-success" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <Button variant="destructive" size="compact" onClick={endGrokVoiceCall}>
            <PhoneOffIcon />
            Hang up
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          Voice:
          {VOICE_PROVIDERS[provider].voices.slice(0, 5).map((option) => (
            <Button
              key={option}
              variant={option === voice ? "ghost" : "ghost-muted"}
              size="compact"
              aria-pressed={option === voice}
              onClick={() => setGrokVoice(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
