import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createGrokVoiceSession, grokVoiceDelegate } from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, GrokVoiceSentPrompt, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { create } from "zustand";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { readThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { lastAgentReply, openThread, readViewedThreadRef, threadStatus } from "./host";
import { liveInstructions, liveTools } from "./voiceAgent";
import { GrokRealtimeCall } from "./realtime";

export const GROK_VOICES = ["Ara", "Eve", "Leo", "Rex", "Sal"] as const;
const VOICE_KEY = "t3code:grok-voice:voice";
const MAX_LINES = 40;
const ANNOUNCE_CHARS = 800;
const MAX_DELTA_LINES = 20;

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
let active: {
  call: GrokRealtimeCall;
  dispose: () => void;
  heardUser: (text: string) => void;
} | null = null;

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
  active.heardUser(trimmed);
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
  readonly prompt: GrokVoiceSentPrompt;
  readonly baselineRunId: string | null;
  announced: string | null;
}

const isRequestStatus = (status: string) =>
  status === "approval" || status === "input" || status === "request";

/**
 * Pushes delegated threads' outcomes into the call, as OpenCode's reply watch does: the reason a
 * stateless delegator can answer "started" and let the result arrive on its own.
 */
function watchThreads(onNews: (note: string, detail: string) => void) {
  const watched = new Map<string, Watched>();
  const check = () => {
    for (const [key, entry] of watched) {
      const shell = readThreadShell(entry.ref);
      if (!shell) continue;
      const run = shell.latestRun;
      if (!run) continue;
      const title = shell.title || entry.prompt.title || "a thread";
      const request = JSON.stringify(entry.prompt.instruction.slice(0, 100));
      const status = threadStatus(shell);
      // Approvals and questions arrive mid-run, so they are checked before the run is.
      if (isRequestStatus(status)) {
        const marker = `${run.runId}:${status}`;
        if (entry.announced === marker) continue;
        entry.announced = marker;
        const need = status === "approval" ? "an approval" : "an answer";
        onNews(
          `${title} is waiting for ${need}.`,
          `Thread ${JSON.stringify(title)}, request ${request}, is waiting for ${need} from the user.`,
        );
        continue;
      }
      // Cleared once answered, so a second request in the same run is announced too.
      entry.announced = null;
      if (run.runId === entry.baselineRunId || shell.runtime?.activeRunId === run.runId) continue;
      if (status === "working" || status === "preparing" || status === "waiting") continue;
      watched.delete(key);
      const outcome = run.status === "completed" ? "finished" : `ended (${run.status})`;
      void lastAgentReply(entry.ref).then((text) => {
        const reply = text.replace(/```[\s\S]*?```/g, "[code in thread]").slice(0, ANNOUNCE_CHARS);
        onNews(
          `${title} ${outcome}.`,
          `Result from thread ${JSON.stringify(title)}, request ${request} (${outcome}): ${reply || "no reply text."}`,
        );
      });
    }
  };
  const unsubscribe = appAtomRegistry.subscribe(
    environmentThreadShells.quietThreadShellsAtom,
    check,
  );
  return {
    watch: (ref: ScopedThreadRef, prompt: GrokVoiceSentPrompt) => {
      const key = scopedThreadKey(ref);
      const shell = readThreadShell(ref);
      const status = shell ? threadStatus(shell) : null;
      watched.set(key, {
        ref,
        prompt,
        // A run that already finished, even one the delegator waited on and reported, is old news.
        baselineRunId: shell?.runtime?.activeRunId ? null : (shell?.latestRun?.runId ?? null),
        // The delegator already knows about a request pending when it started watching.
        announced:
          shell?.latestRun && status && isRequestStatus(status)
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
  // News waits until nobody is talking and no delegation is running, as OpenCode's reply gate does.
  const news: string[] = [];
  const flushNews = () => {
    const state = useGrokVoiceStore.getState();
    if (ended || state.speaking === "user" || state.delegating > 0) return;
    for (const detail of news.splice(0)) call.announce(detail);
  };
  const unsubscribeGate = useGrokVoiceStore.subscribe(flushNews);
  const watcher = watchThreads((note, detail) => {
    if (ended) return;
    addLine({ who: "note", text: note });
    news.push(detail);
    flushNews();
  });

  // Both sides of the call; each delegation gets the lines since the previous one.
  const log: string[] = [];
  const heardUser = (text: string) => {
    log.push(`User: ${text}`);
    addLine({ who: "you", text });
  };
  let delegatedUpTo = 0;
  let explained: string[] = [];
  const takeDelta = () => {
    const delta = log.slice(Math.max(delegatedUpTo, log.length - MAX_DELTA_LINES));
    delegatedUpTo = log.length;
    return delta;
  };
  const viewed = () => {
    const ref = readViewedThreadRef(appRouter);
    if (!ref || ref.environmentId !== environmentId) return undefined;
    const shell = readThreadShell(ref);
    return {
      threadId: ref.threadId,
      ...(shell?.title ? { title: shell.title } : {}),
      ...(shell?.projectId ? { projectId: shell.projectId } : {}),
    };
  };

  const call: GrokRealtimeCall = new GrokRealtimeCall({
    onStatus: (status, detail) => {
      if (status === "live") set({ status: "live" });
      if (status === "closed") {
        dispose();
        if (detail) set({ error: detail });
      }
    },
    onUserTranscript: (text) => heardUser(text),
    onAssistantTranscript: (text) => {
      log.push(`Voice agent: ${text}`);
      addLine({ who: "grok", text });
    },
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
      const current = viewed();
      runEnvironmentSpeech(
        grokVoiceDelegate(prepared, {
          request,
          transcript: takeDelta(),
          ...(current ? { viewed: current } : {}),
          explained,
        }),
      )
        .then(
          (result) => {
            explained = [...result.explained];
            for (const prompt of result.sent)
              watcher.watch(scopeThreadRef(environmentId, prompt.threadId as never), prompt);
            if (result.open)
              void openThread(appRouter, environmentId, result.open).then((opened) => {
                if (!opened) addLine({ who: "note", text: "That thread didn't show up to open." });
              });
            if (import.meta.env.DEV) console.info("[grok-voice] delegation", result);
            if (!ended) call.sendToolOutput(callId, { speech: result.speech });
          },
          (error: unknown) => {
            const message = errorMessage(error);
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
    unsubscribeGate();
    watcher.dispose();
    call.stop();
    active = null;
    set({ status: "idle", speaking: null, delegating: 0, level: 0 });
  };
  active = { call, dispose, heardUser };

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
