import { MicIcon, MicOffIcon, PhoneOffIcon, XIcon } from "lucide-react";
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

const VISIBLE_LINES = 6;

/** Floating call surface; renders nothing unless a call is on or just failed. */
export function GrokVoiceCallPanel() {
  const { status, error, lines, speaking, muted, delegating, level, voice, provider, canType } =
    useGrokVoiceStore(useShallow((state) => state));
  const name = VOICE_PROVIDERS[provider].label;
  if (status === "idle" && !error) return null;

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
            onClick={() => useGrokVoiceStore.setState({ error: null })}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}

      {lines.length > 0 ? (
        <ol className="flex max-h-48 flex-col gap-1 overflow-y-auto text-xs">
          {lines.slice(-VISIBLE_LINES).map((line, index) => (
            <li
              // Lines only append, so position is a stable identity within the window.
              key={`${lines.length - VISIBLE_LINES + index}`}
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
