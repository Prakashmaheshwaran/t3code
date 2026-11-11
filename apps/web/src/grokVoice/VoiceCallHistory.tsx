import {
  clearVoiceCalls,
  deleteVoiceCall,
  listVoiceCalls,
  readVoiceCall,
} from "@t3tools/client-runtime/voice-input";
import type { VoiceCallRecord, VoiceCallSummary } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { VOICE_PROVIDERS, useGrokVoiceStore, voiceConnection } from "./call";

// The server writes a call a few seconds after hang-up, once its final notes are folded.
const SAVED_AFTER_MS = 8000;

const minutes = (call: VoiceCallSummary) =>
  Math.max(1, Math.round((call.endedAt - call.startedAt) / 60_000));

interface HistoryState {
  readonly calls: ReadonlyArray<VoiceCallSummary> | null;
  readonly error: string | null;
  readonly opened: VoiceCallRecord | null;
  readonly confirmClear: boolean;
}

const useHistory = create<HistoryState>()(() => ({
  calls: null,
  error: null,
  opened: null,
  confirmClear: false,
}));

async function loadCalls() {
  const prepared = voiceConnection();
  if (!prepared)
    return useHistory.setState({ error: "Connect to an environment to see its calls." });
  try {
    const { calls } = await runEnvironmentSpeech(listVoiceCalls(prepared));
    useHistory.setState({ calls, error: null });
  } catch {
    useHistory.setState({ error: "Couldn't load the call history." });
  }
}

async function openCall(id: string) {
  if (useHistory.getState().opened?.id === id) return useHistory.setState({ opened: null });
  const prepared = voiceConnection();
  if (!prepared) return;
  const found = await runEnvironmentSpeech(readVoiceCall(prepared, id)).catch(() => null);
  useHistory.setState({ opened: found?.call ?? null });
}

async function removeCall(id: string) {
  const prepared = voiceConnection();
  if (!prepared) return;
  await runEnvironmentSpeech(deleteVoiceCall(prepared, id)).catch(() => {});
  if (useHistory.getState().opened?.id === id) useHistory.setState({ opened: null });
  await loadCalls();
}

/** Deletes every saved call on the second press. */
async function clearAll() {
  if (!useHistory.getState().confirmClear) {
    useHistory.setState({ confirmClear: true });
    setTimeout(() => useHistory.setState({ confirmClear: false }), 4000);
    return;
  }
  useHistory.setState({ confirmClear: false, opened: null });
  const prepared = voiceConnection();
  if (!prepared) return;
  await runEnvironmentSpeech(clearVoiceCalls(prepared)).catch(() => {});
  await loadCalls();
}

/** Finished calls with their notes and transcripts, kept by this environment. */
export function VoiceCallHistory() {
  const { calls, error, opened, confirmClear } = useHistory(useShallow((state) => state));
  const status = useGrokVoiceStore((state) => state.status);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the history lives in the environment's files; it reloads once a finished call has been written
  useEffect(() => {
    if (status !== "idle") return;
    void loadCalls();
    const timer = setTimeout(() => void loadCalls(), SAVED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <SettingsRow
      title="Recent calls"
      description={
        error ??
        (calls?.length === 0 ? "No saved calls yet." : "Notes and transcripts of finished calls.")
      }
      control={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload calls"
            onClick={() => void loadCalls()}
          >
            <RefreshCwIcon />
          </Button>
          {calls && calls.length > 0 ? (
            <Button
              variant={confirmClear ? "destructive" : "ghost"}
              size="compact"
              onClick={() => void clearAll()}
            >
              {confirmClear ? "Delete all calls?" : "Delete all"}
            </Button>
          ) : null}
        </div>
      }
    >
      {calls && calls.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-lg border text-sm">
          {calls.map((call) => {
            const isOpen = opened?.id === call.id;
            return (
              <li key={call.id} className="flex flex-col gap-2 px-3 py-2">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    aria-expanded={isOpen}
                    onClick={() => void openCall(call.id)}
                  >
                    {isOpen ? (
                      <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">
                        {new Date(call.startedAt).toLocaleString()}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {VOICE_PROVIDERS[call.provider].label} · {minutes(call)} min ·{" "}
                        {call.lineCount} lines
                      </span>
                      {!isOpen && call.notes ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {call.notes.split("\n")[0]}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <Button
                    variant="ghost-destructive"
                    size="icon-sm"
                    aria-label="Delete this call"
                    onClick={() => void removeCall(call.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                {isOpen && opened ? <CallRecord call={opened} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsRow>
  );
}

function CallRecord({ call }: { call: VoiceCallRecord }) {
  const name = VOICE_PROVIDERS[call.provider].label;
  return (
    <div className="flex flex-col gap-2 pl-6 text-xs">
      {call.notes ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{call.notes}</p>
      ) : null}
      <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md bg-muted/40 p-2">
        {call.lines.map((line, index) => (
          <li
            // A saved call never changes, so position is its lines' identity.
            // oxlint-disable-next-line react/no-array-index-key -- saved lines are immutable and have no id
            key={index}
            className={cn(
              line.who === "User" ? "text-foreground" : "text-muted-foreground",
              (line.who === "T3 Code" || line.who === "Update") && "italic",
            )}
          >
            <span className="tabular-nums opacity-60">
              {new Date(line.at).toLocaleTimeString()}{" "}
            </span>
            <span className="font-medium">
              {line.who === "User" ? "You" : line.who === "Voice agent" ? name : line.who}:{" "}
            </span>
            {line.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
