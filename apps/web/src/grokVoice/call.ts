import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createGrokVoiceSession } from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { create } from "zustand";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { readThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { liveInstructions, liveTools, runDelegation } from "./delegator";
import { createBrowserHost, describeThread, lastAgentReply, readViewedThreadRef } from "./host";
import { GrokRealtimeCall } from "./realtime";

export const GROK_VOICES = ["Ara", "Eve", "Leo", "Rex", "Sal"] as const;
const VOICE_KEY = "t3code:grok-voice:voice";
const MAX_LINES = 40;
const ANNOUNCE_CHARS = 1200;

export interface CallLine {
  readonly who: "you" | "grok" | "note";
  readonly text: string;
}

interface GrokVoiceState {
  readonly status: "idle" | "connecting" | "live";
  readonly error: string | null;
  readonly lines: ReadonlyArray<CallLine>;
  readonly speaking: "user" | "assistant" | null;
  readonly muted: boolean;
  readonly delegating: number;
  readonly level: number;
  readonly voice: string;
}

function readVoice() {
  try {
    const stored = localStorage.getItem(VOICE_KEY);
    if (stored && (GROK_VOICES as readonly string[]).includes(stored)) return stored;
  } catch {}
  return "Ara";
}

export const useGrokVoiceStore = create<GrokVoiceState>()(() => ({
  status: "idle",
  error: null,
  lines: [],
  speaking: null,
  muted: false,
  delegating: 0,
  level: 0,
  voice: readVoice(),
}));

const set = useGrokVoiceStore.setState;
const addLine = (line: CallLine) =>
  set((state) => ({ lines: [...state.lines, line].slice(-MAX_LINES) }));

let router: AnyRouter | null = null;
let active: { call: GrokRealtimeCall; dispose: () => void } | null = null;

export function installGrokVoice(appRouter: AnyRouter) {
  router = appRouter;
}

export function setGrokVoice(voice: string) {
  try {
    localStorage.setItem(VOICE_KEY, voice);
  } catch {}
  set({ voice });
}

export function toggleGrokVoiceMute() {
  const muted = !useGrokVoiceStore.getState().muted;
  active?.call.setMuted(muted);
  set({ muted });
}

export function sendGrokVoiceText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !active) return;
  addLine({ who: "you", text: trimmed });
  active.call.say(trimmed);
}

export function toggleGrokVoiceCall() {
  if (useGrokVoiceStore.getState().status === "idle") void startGrokVoiceCall();
  else endGrokVoiceCall();
}

export function endGrokVoiceCall() {
  active?.dispose();
}

function pickEnvironment(): EnvironmentId | null {
  if (router) {
    const viewed = readViewedThreadRef(router);
    if (viewed) return viewed.environmentId;
  }
  for (const id of appAtomRegistry.get(liveShellEnvironmentIdsAtom)) return id;
  return null;
}

interface Watched {
  readonly ref: ScopedThreadRef;
  readonly baselineRunId: string | null;
  announced: string | null;
}

/** Announces delegated threads' outcomes: the reason a stateless delegator can answer "started". */
function watchThreads(onNews: (note: string, detail: string) => void) {
  const watched = new Map<string, Watched>();
  const check = () => {
    for (const [key, entry] of watched) {
      const shell = readThreadShell(entry.ref);
      if (!shell) continue;
      const run = shell.latestRun;
      if (!run) continue;
      const { title, status } = describeThread(shell);
      // Approvals and questions arrive mid-run, so they are checked before the run is.
      if (status === "approval" || status === "input" || status === "request") {
        const marker = `${run.runId}:${status}`;
        if (entry.announced === marker) continue;
        entry.announced = marker;
        const need = status === "approval" ? "an approval" : "an answer";
        onNews(`${title} is waiting for ${need}.`, `Thread "${title}" is waiting for ${need}.`);
        continue;
      }
      // Cleared once answered, so a second request in the same run is announced too.
      entry.announced = null;
      if (run.runId === entry.baselineRunId || shell.runtime?.activeRunId === run.runId) continue;
      if (status === "working" || status === "preparing" || status === "waiting") continue;
      watched.delete(key);
      const outcome = run.status === "completed" ? "finished" : `ended (${run.status})`;
      void lastAgentReply(entry.ref).then((text) => {
        const reply = text.slice(0, ANNOUNCE_CHARS);
        onNews(
          `${title} ${outcome}.`,
          `Thread "${title}" ${outcome}.${reply ? ` Its final reply: ${reply}` : ""}`,
        );
      });
    }
  };
  const unsubscribe = appAtomRegistry.subscribe(
    environmentThreadShells.quietThreadShellsAtom,
    check,
  );
  return {
    watch: (ref: ScopedThreadRef) => {
      const key = scopedThreadKey(ref);
      if (watched.has(key)) return;
      const shell = readThreadShell(ref);
      const status = shell ? describeThread(shell).status : null;
      watched.set(key, {
        ref,
        // A run already finished before this request is old news; one still running is not.
        baselineRunId: shell?.runtime?.activeRunId ? null : (shell?.latestRun?.runId ?? null),
        // The delegator already knows about a request pending when it started watching.
        announced:
          shell?.latestRun && (status === "approval" || status === "input" || status === "request")
            ? `${shell.latestRun.runId}:${status}`
            : null,
      });
    },
    dispose: unsubscribe,
  };
}

async function startGrokVoiceCall() {
  if (useGrokVoiceStore.getState().status !== "idle" || !router) return;
  const appRouter = router;
  set({
    status: "connecting",
    error: null,
    lines: [],
    muted: false,
    delegating: 0,
    speaking: null,
  });
  const environmentId = pickEnvironment();
  const prepared = environmentId ? readPreparedConnection(environmentId) : null;
  if (!environmentId || !prepared) {
    set({ status: "idle", error: "Connect to an environment first." });
    return;
  }

  let ended = false;
  const watcher = watchThreads((note, detail) => {
    if (ended) return;
    addLine({ who: "note", text: note });
    call.announce(detail);
  });
  const host = createBrowserHost({ router: appRouter, environmentId, watch: watcher.watch });
  const transcript = () =>
    useGrokVoiceStore
      .getState()
      .lines.filter((line) => line.who !== "note")
      .slice(-12)
      .map((line) => `${line.who === "you" ? "User" : "Voice agent"}: ${line.text}`)
      .join("\n");

  const call: GrokRealtimeCall = new GrokRealtimeCall({
    onStatus: (status, detail) => {
      if (status === "live") set({ status: "live" });
      if (status === "closed") {
        dispose();
        if (detail) set({ error: detail });
      }
    },
    onUserTranscript: (text) => addLine({ who: "you", text }),
    onAssistantTranscript: (text) => addLine({ who: "grok", text }),
    onSpeaking: (speaking) => set({ speaking }),
    onNote: (text) => addLine({ who: "note", text }),
    onLevel: (level) => {
      const rounded = Math.min(1, Math.round(level * 8) / 8);
      if (rounded !== useGrokVoiceStore.getState().level) set({ level: rounded });
    },
    onToolCall: ({ callId, name, args }) => {
      if (name === "end_call") {
        call.sendToolOutput(callId, { status: "ending" });
        setTimeout(dispose, 2500);
        return;
      }
      if (name !== "delegate") {
        call.sendToolOutput(callId, { error: `Unknown tool ${name}` });
        return;
      }
      const request =
        typeof (args as { request?: unknown }).request === "string"
          ? (args as { request: string }).request
          : "";
      set((state) => ({ delegating: state.delegating + 1 }));
      runDelegation({ host, request, transcript: transcript() })
        .then(
          (speech) => {
            if (!ended) call.sendToolOutput(callId, { speech });
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            addLine({ who: "note", text: `Delegation failed: ${message}` });
            if (!ended) call.sendToolOutput(callId, { error: message });
          },
        )
        .finally(() => set((state) => ({ delegating: Math.max(0, state.delegating - 1) })));
    },
  });

  const dispose = () => {
    if (ended) return;
    ended = true;
    watcher.dispose();
    call.stop();
    active = null;
    set({ status: "idle", speaking: null, delegating: 0, level: 0 });
  };
  active = { call, dispose };

  try {
    const session = await runEnvironmentSpeech(createGrokVoiceSession(prepared));
    if (ended) return;
    await call.start({
      url: session.url,
      token: session.token,
      instructions: liveInstructions,
      voice: useGrokVoiceStore.getState().voice,
      tools: liveTools,
    });
  } catch (error) {
    dispose();
    set({ error: errorMessage(error) });
  }
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "message" in cause)
      return String((cause as { message: unknown }).message);
    if ("message" in error) return String((error as { message: unknown }).message);
  }
  return "Couldn't start the call.";
}
