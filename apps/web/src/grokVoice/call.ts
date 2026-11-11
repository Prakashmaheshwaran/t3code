import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  addGrokCallLines,
  chatGptVoiceModels,
  endGrokCallSession,
  grokVoiceDelegate,
  resumeGrokCallSession,
  startGrokCallSession,
} from "@t3tools/client-runtime/voice-input";
import {
  CHATGPT_VOICES,
  type ChatGptVoiceEvent,
  type EnvironmentId,
  type GrokVoiceSentPrompt,
  type ScopedThreadRef,
} from "@t3tools/contracts";
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
import { ChatGptCall } from "./chatgptCall";
import { isMuteCommand, listenForUnmute, type UnmuteListener } from "./unmuteListener";
import { GrokRealtimeCall } from "./realtime";

const GROK_VOICES = ["Ara", "Eve", "Leo", "Rex", "Sal"] as const;
export type VoiceProvider = "grok" | "chatgpt";
export const VOICE_PROVIDERS: Record<VoiceProvider, { label: string; voices: readonly string[] }> =
  {
    grok: { label: "Grok", voices: GROK_VOICES },
    chatgpt: { label: "ChatGPT", voices: CHATGPT_VOICES },
  };
const VOICE_KEY = "t3code:grok-voice:voice";
const PROVIDER_KEY = "t3code:grok-voice:provider";
const DELEGATOR_MODEL_KEY = "t3code:grok-voice:chatgpt-delegator-model";
const REPLY_LANGUAGE_KEY = "t3code:grok-voice:reply-language";
const KEEP_DAYS_KEY = "t3code:grok-voice:keep-days";

/** Languages the voice can be told to always answer in. */
export const REPLY_LANGUAGES = [
  "English",
  "Tamil",
  "Hindi",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Japanese",
  "Chinese",
  "Arabic",
] as const;

/** How long finished calls stay in the history; null keeps the newest 200. */
export const KEEP_CALL_OPTIONS: ReadonlyArray<{ days: number | null; label: string }> = [
  { days: null, label: "Keep the last 200" },
  { days: 30, label: "30 days" },
  { days: 7, label: "7 days" },
  { days: 0, label: "Don't save calls" },
];
// The whole call stays readable in the panel; ChatGPT calls are also saved by the server.
const MAX_LINES = 1000;
const ANNOUNCE_CHARS = 800;
const DELEGATION_HOLD_MS = 20_000;
// A moment of silence after an answer, so news doesn't ride on its tail.
const QUIET_MS = 1200;
// A long GPT-Live session loses the start of the call, so the call moves to a fresh one seeded
// with its notes, at the first quiet moment after this long.
const REFRESH_AFTER_MS = 20 * 60_000;
const REFRESH_QUIET_MS = 4000;
// Reconnecting again sooner than this means sessions keep failing, so the call ends instead.
const MIN_RESUME_GAP_MS = 60_000;

export interface CallLine {
  readonly id: number;
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
  readonly provider: VoiceProvider;
  readonly voice: string;
  /** The call takes typed input as well as speech. */
  readonly canType: boolean;
  /** The Codex model ChatGPT calls' delegator thinks with; null follows the server default. */
  readonly delegatorModel: string | null;
  readonly chatgptModels: ReadonlyArray<{ id: string; name: string }> | null;
  readonly chatgptDefaultModel: string | null;
  readonly chatgptModelsError: string | null;
  /** The language the voice always answers in; null answers in the language it hears. */
  readonly replyLanguage: string | null;
  /** Days to keep finished calls; null keeps the newest 200, 0 saves none. */
  readonly keepDays: number | null;
}

function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function readProvider(): VoiceProvider {
  return readStored(PROVIDER_KEY) === "chatgpt" ? "chatgpt" : "grok";
}

function readVoice(provider: VoiceProvider) {
  const voices = VOICE_PROVIDERS[provider].voices;
  const stored = readStored(provider === "grok" ? VOICE_KEY : `${VOICE_KEY}:${provider}`);
  return stored && voices.includes(stored) ? stored : voices[0]!;
}

export const useGrokVoiceStore = create<GrokVoiceState>()(() => ({
  status: "idle",
  error: null,
  lines: [],
  speaking: null,
  muted: false,
  delegating: 0,
  level: 0,
  provider: readProvider(),
  voice: readVoice(readProvider()),
  canType: false,
  delegatorModel: readStored(DELEGATOR_MODEL_KEY),
  chatgptModels: null,
  chatgptDefaultModel: null,
  chatgptModelsError: null,
  replyLanguage: readStored(REPLY_LANGUAGE_KEY),
  keepDays: readKeepDays(),
}));

function readKeepDays() {
  const stored = Number(readStored(KEEP_DAYS_KEY) ?? "NaN");
  return KEEP_CALL_OPTIONS.some((option) => option.days === stored) ? stored : null;
}

function writeOrClear(key: string, value: string | null) {
  if (value !== null) return writeStored(key, value);
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function setReplyLanguage(language: string | null) {
  writeOrClear(REPLY_LANGUAGE_KEY, language);
  set({ replyLanguage: language });
}

export function setKeepDays(days: number | null) {
  writeOrClear(KEEP_DAYS_KEY, days === null ? null : String(days));
  set({ keepDays: days });
}

/** What a voice is told to always do, matching the server's standing instructions. */
function standingInstructions(replyLanguage: string | null) {
  return replyLanguage
    ? [
        `Always speak to the user in ${replyLanguage}, whatever language they speak, unless they ask you to switch. Understand them in any language.`,
      ]
    : [];
}

const set = useGrokVoiceStore.setState;
let lineIds = 0;
const addLine = (line: Omit<CallLine, "id">) =>
  set((state) => ({ lines: [...state.lines, { ...line, id: ++lineIds }].slice(-MAX_LINES) }));

let router: AnyRouter | null = null;
interface VoiceCall {
  readonly say?: (text: string) => void;
  readonly announce: (text: string) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly stop: () => void;
  readonly microphone: MediaStream | undefined;
  /** Moving to a new realtime session, which news must wait for. */
  readonly switchingSessions?: boolean;
}

let active: {
  call: VoiceCall;
  dispose: () => void;
  heardUser: (text: string) => void;
  prepared: NonNullable<ReturnType<typeof readPreparedConnection>>;
  unmute?: UnmuteListener | undefined;
} | null = null;

/** Mutes or unmutes the call; while muted, listens locally for "unmute". */
function setCallMuted(muted: boolean, byVoice = false) {
  const call = active;
  if (!call || useGrokVoiceStore.getState().muted === muted) return;
  call.call.setMuted(muted);
  set({ muted });
  call.unmute?.stop();
  call.unmute = undefined;
  if (!muted) {
    if (byVoice) addLine({ who: "note", text: "Unmuted." });
    return;
  }
  addLine({ who: "note", text: "Muted. Click the mic to unmute." });
  void listenForUnmute({
    prepared: call.prepared,
    microphone: call.call.microphone,
    onUnmute: () => setCallMuted(false, true),
    onFailed: () =>
      addLine({ who: "note", text: 'Stopped listening for "unmute". Click the mic to unmute.' }),
  }).then((listening) => {
    if (active !== call || !useGrokVoiceStore.getState().muted) {
      listening?.listener.stop();
      return;
    }
    call.unmute = listening?.listener;
    if (listening)
      addLine({
        who: "note",
        text: `Say "unmute" to come back${listening.via === "browser" ? " (heard through Chrome's speech recognition)" : ""}.`,
      });
    else addLine({ who: "note", text: "Voice unmute isn't available here." });
  });
}

/** A spoken "mute" mutes the call; the model never needs to act on it. */
function heardCommand(text: string) {
  if (isMuteCommand(text)) setCallMuted(true, true);
}

export function installGrokVoice(appRouter: AnyRouter) {
  router = appRouter;
}

export function setGrokVoice(voice: string) {
  const { provider } = useGrokVoiceStore.getState();
  writeStored(provider === "grok" ? VOICE_KEY : `${VOICE_KEY}:${provider}`, voice);
  set({ voice });
}

export function setDelegatorModel(model: string | null) {
  if (model) writeStored(DELEGATOR_MODEL_KEY, model);
  else
    try {
      localStorage.removeItem(DELEGATOR_MODEL_KEY);
    } catch {}
  set({ delegatorModel: model });
}

/** Asks the environment which Codex models the signed-in ChatGPT plan offers. */
export async function loadChatGptModels() {
  const environmentId = pickEnvironment();
  const prepared = environmentId ? readPreparedConnection(environmentId) : null;
  if (!prepared) return set({ chatgptModelsError: "Connect to an environment first." });
  try {
    const result = await runEnvironmentSpeech(chatGptVoiceModels(prepared));
    set({
      chatgptModels: result.models,
      chatgptDefaultModel: result.default,
      chatgptModelsError: null,
    });
  } catch (error) {
    set({ chatgptModelsError: errorMessage(error) });
  }
}

export function setVoiceProvider(provider: VoiceProvider) {
  writeStored(PROVIDER_KEY, provider);
  set({ provider, voice: readVoice(provider) });
}

export function toggleGrokVoiceMute() {
  setCallMuted(!useGrokVoiceStore.getState().muted);
}

export function sendGrokVoiceText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !active?.call.say) return;
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

/** The connection voice features use: the viewed thread's environment, or the first one. */
export function voiceConnection() {
  const environmentId = pickEnvironment();
  return environmentId ? readPreparedConnection(environmentId) : null;
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
  /** Until then, a pending request is the one the delegator just saw or answered. */
  readonly settleAt: number;
}

// Long enough for an answered approval to clear from the thread before it could be re-announced.
const WATCH_GRACE_MS = 2500;

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
        if (Date.now() < entry.settleAt) continue;
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
      const shell = readThreadShell(ref);
      watched.set(scopedThreadKey(ref), {
        ref,
        prompt,
        // A run that already finished, even one the delegator waited on and reported, is old news.
        // Queued work waits behind the running run, whose result answers someone else's request.
        baselineRunId: shell?.runtime?.activeRunId
          ? prompt.queued
            ? shell.runtime.activeRunId
            : null
          : (shell?.latestRun?.runId ?? null),
        announced: null,
        settleAt: Date.now() + WATCH_GRACE_MS,
      });
      // A request still pending after the grace period is a new one, or one nobody answered.
      setTimeout(check, WATCH_GRACE_MS + 50);
    },
    dispose: unsubscribe,
  };
}

async function startGrokVoiceCall() {
  if (useGrokVoiceStore.getState().status !== "idle" || !router) return;
  const appRouter = router;
  const { provider } = useGrokVoiceStore.getState();
  set({
    status: "connecting",
    error: null,
    lines: [],
    muted: false,
    delegating: 0,
    speaking: null,
    canType: true,
  });
  const environmentId = pickEnvironment();
  const prepared = environmentId ? readPreparedConnection(environmentId) : null;
  if (!environmentId || !prepared) {
    set({ status: "idle", error: "Connect to an environment first." });
    return;
  }

  let ended = false;
  // Each provider's branch below installs its call here; news is spoken through it.
  let announcer: VoiceCall | null = null;
  // News waits until nobody is talking and no delegation is running, as OpenCode's reply gate
  // does, but never longer than DELEGATION_HOLD_MS behind a delegation that never reports back.
  const news: string[] = [];
  let newsSince = 0;
  let lastBusyAt = 0;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  // News that lands while the agent answers is merged into that answer and lost, so it waits
  // for quiet: nobody speaking and no delegation running, for at most DELEGATION_HOLD_MS.
  const flushNews = () => {
    const state = useGrokVoiceStore.getState();
    if (ended || !announcer || news.length === 0) return;
    // News sent while the call moves to a new session would reach the old one and be lost.
    if (announcer.switchingSessions) {
      clearTimeout(recheck);
      recheck = setTimeout(flushNews, QUIET_MS);
      return;
    }
    newsSince ||= Date.now();
    const busy = state.speaking !== null || state.delegating > 0;
    const wait = busy ? newsSince + DELEGATION_HOLD_MS - Date.now() : QUIET_MS - quietFor();
    if (wait > 0) {
      clearTimeout(recheck);
      recheck = setTimeout(flushNews, Math.min(wait, QUIET_MS));
      return;
    }
    newsSince = 0;
    for (const detail of news.splice(0)) announcer.announce(detail);
  };
  const quietFor = () => {
    noteBusy();
    return Date.now() - lastBusyAt;
  };
  const noteBusy = () => {
    const state = useGrokVoiceStore.getState();
    if (state.speaking !== null || state.delegating > 0) lastBusyAt = Date.now();
  };
  const unsubscribeGate = useGrokVoiceStore.subscribe(() => {
    noteBusy();
    flushNews();
  });
  const watcher = watchThreads((note, detail) => {
    if (ended) return;
    addLine({ who: "note", text: note });
    news.push(detail);
    flushNews();
  });

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
  const delegated = (result: { open?: string; sent: ReadonlyArray<GrokVoiceSentPrompt> }) => {
    for (const prompt of result.sent)
      watcher.watch(scopeThreadRef(environmentId, prompt.threadId as never), prompt);
    if (result.open)
      void openThread(appRouter, environmentId, result.open).then((opened) => {
        if (!opened) addLine({ who: "note", text: "That thread didn't show up to open." });
      });
  };
  const onLevel = (level: number) => {
    const rounded = Math.min(1, Math.round(level * 8) / 8);
    if (rounded !== useGrokVoiceStore.getState().level) set({ level: rounded });
  };

  if (provider === "chatgpt") {
    // The server runs this call's delegations; the client follows along and shows the results.
    const onEvent = (event: ChatGptVoiceEvent) => {
      switch (event.type) {
        case "speaking":
          return set({ speaking: event.who });
        case "transcript":
          // GPT-Live only reports user turns in this stream, so a spoken command is caught here
          // as well as on the call's own data channel.
          if (event.role === "user") heardCommand(event.text);
          return addLine({ who: event.role === "user" ? "you" : "grok", text: event.text });
        case "delegating":
          return set((state) => ({ delegating: state.delegating + 1 }));
        case "delegated":
          set((state) => ({ delegating: Math.max(0, state.delegating - 1) }));
          if (import.meta.env.DEV) console.info("[grok-voice] delegation", event);
          return delegated(event);
        case "note":
          return addLine({ who: "note", text: event.text });
        case "announce":
          // Waits for quiet like thread news, then goes to the session that's live now.
          news.push(event.text);
          return flushNews();
      }
    };
    const call: ChatGptCall = new ChatGptCall(prepared, {
      onStatus: (status, detail) => {
        if (status === "live") set({ status: "live" });
        if (status === "closed") {
          dispose();
          if (detail && detail !== "Hung up.") addLine({ who: "note", text: detail });
        }
      },
      onEvent,
      onLevel,
      onUtterance: heardCommand,
    });
    announcer = call;
    const stopFollowing = appRouter.subscribe("onResolved", () => call.updateViewed(viewed()));
    const refresher = setInterval(() => {
      const state = useGrokVoiceStore.getState();
      if (state.status !== "live" || call.switchingSessions) return;
      if (call.sessionAge < REFRESH_AFTER_MS) return;
      if (news.length > 0 || state.delegating > 0 || quietFor() < REFRESH_QUIET_MS) return;
      addLine({
        who: "note",
        text: "Refreshing the call so it keeps up with a long conversation…",
      });
      void call.refresh().then((refreshed) => {
        if (refreshed) addLine({ who: "note", text: "Refreshed, with this call's notes." });
      });
    }, 5000);
    const dispose = () => {
      if (ended) return;
      ended = true;
      clearTimeout(recheck);
      clearInterval(refresher);
      active?.unmute?.stop();
      stopFollowing();
      unsubscribeGate();
      watcher.dispose();
      call.stop();
      active = null;
      set({ status: "idle", speaking: null, delegating: 0, level: 0 });
    };
    active = { call, dispose, heardUser: (text) => addLine({ who: "you", text }), prepared };
    try {
      const current = viewed();
      await call.start({
        voice: useGrokVoiceStore.getState().voice as (typeof CHATGPT_VOICES)[number],
        delegatorModel: useGrokVoiceStore.getState().delegatorModel ?? undefined,
        replyLanguage: useGrokVoiceStore.getState().replyLanguage ?? undefined,
        keepDays: useGrokVoiceStore.getState().keepDays ?? undefined,
        ...(current ? { viewed: current } : {}),
      });
    } catch (error) {
      dispose();
      set({ error: errorMessage(error) });
    }
    return;
  }

  const replyLanguage = useGrokVoiceStore.getState().replyLanguage;
  // The server remembers the call: every line goes there in order, and delegations name it.
  let callId: string | undefined;
  let posting: Promise<unknown> = Promise.resolve();
  const remember = (who: "User" | "Voice agent" | "Update", text: string) => {
    if (!callId) return;
    const id = callId;
    posting = posting
      .then(() => runEnvironmentSpeech(addGrokCallLines(prepared, id, { lines: [{ who, text }] })))
      .catch(() => {});
  };
  const heardGrokUser = (text: string) => {
    addLine({ who: "you", text });
    remember("User", text);
  };
  let switching = false;
  let lastResumeAt = 0;
  /** Moves the call to a fresh Grok session that starts from the server's notes. */
  const refreshGrok = async (dropped?: string) => {
    if (switching || ended || !callId) return false;
    switching = true;
    if (dropped !== undefined) lastResumeAt = Date.now();
    try {
      const next = await runEnvironmentSpeech(resumeGrokCallSession(prepared, callId));
      await call.reconnect(next.session, next.seed);
      return true;
    } catch (error) {
      dispose();
      set({ error: dropped ?? errorMessage(error) });
      return false;
    } finally {
      switching = false;
    }
  };
  const call: GrokRealtimeCall = new GrokRealtimeCall({
    onStatus: (status, detail) => {
      if (status === "live") set({ status: "live" });
      if (status === "closed") {
        dispose();
        if (detail) set({ error: detail });
      }
    },
    onUserTranscript: (text) => {
      heardGrokUser(text);
      heardCommand(text);
    },
    onAssistantTranscript: (text) => {
      addLine({ who: "grok", text });
      remember("Voice agent", text);
    },
    onSpeaking: (speaking) => set({ speaking }),
    onNote: (text) => addLine({ who: "note", text }),
    onLevel,
    onDropped: (reason) => {
      if (switching) return;
      // Sessions that keep failing end the call rather than loop.
      if (Date.now() - lastResumeAt < MIN_RESUME_GAP_MS) {
        dispose();
        set({ error: reason });
        return;
      }
      addLine({ who: "note", text: "The call dropped. Reconnecting…" });
      void refreshGrok(reason).then((resumed) => {
        if (resumed) addLine({ who: "note", text: "Reconnected." });
      });
    },
    onToolCall: ({ callId: toolCallId, name, args }) => {
      if (name === "end_call") {
        call.sendToolOutput(toolCallId, { status: "ending" });
        setTimeout(dispose, 2500);
        return;
      }
      if (name !== "delegate") {
        call.sendToolOutput(toolCallId, { error: `Unknown tool ${name}` });
        return;
      }
      const request =
        typeof (args as { request?: unknown }).request === "string"
          ? (args as { request: string }).request
          : "";
      set((state) => ({ delegating: state.delegating + 1 }));
      const current = viewed();
      // The server reads this request's lines from the call, so they land first.
      void posting
        .then(() =>
          runEnvironmentSpeech(
            grokVoiceDelegate(prepared, {
              request,
              transcript: [],
              ...(callId ? { callId } : {}),
              ...(current ? { viewed: current } : {}),
              ...(replyLanguage ? { replyLanguage } : {}),
            }),
          ),
        )
        .then(
          (result) => {
            delegated(result);
            if (import.meta.env.DEV) console.info("[grok-voice] delegation", result);
            if (!ended) call.sendToolOutput(toolCallId, { speech: result.speech });
          },
          (error: unknown) => {
            const message = errorMessage(error);
            addLine({ who: "note", text: `Delegation failed: ${message}` });
            if (!ended) call.sendToolOutput(toolCallId, { error: message });
          },
        )
        .finally(() => set((state) => ({ delegating: Math.max(0, state.delegating - 1) })));
    },
  });

  const refresher = setInterval(() => {
    const state = useGrokVoiceStore.getState();
    if (state.status !== "live" || switching || call.sessionAge < REFRESH_AFTER_MS) return;
    if (news.length > 0 || state.delegating > 0 || quietFor() < REFRESH_QUIET_MS) return;
    addLine({ who: "note", text: "Refreshing the call so it keeps up with a long conversation…" });
    void refreshGrok().then((refreshed) => {
      if (refreshed) addLine({ who: "note", text: "Refreshed, with this call's notes." });
    });
  }, 5000);
  const dispose = () => {
    if (ended) return;
    ended = true;
    clearTimeout(recheck);
    clearInterval(refresher);
    active?.unmute?.stop();
    unsubscribeGate();
    watcher.dispose();
    call.stop();
    active = null;
    set({ status: "idle", speaking: null, delegating: 0, level: 0 });
    // Saved by the server once the last lines are in.
    const id = callId;
    if (id)
      void posting
        .then(() => runEnvironmentSpeech(endGrokCallSession(prepared, id)))
        .catch(() => {});
  };
  active = { call, dispose, heardUser: heardGrokUser, prepared };
  announcer = {
    say: (text) => call.say(text),
    announce: (text) => {
      call.announce(text);
      remember("Update", text);
    },
    setMuted: (muted) => call.setMuted(muted),
    stop: () => call.stop(),
    get microphone() {
      return call.microphone;
    },
    get switchingSessions() {
      return switching;
    },
  };

  try {
    const started = await runEnvironmentSpeech(
      startGrokCallSession(prepared, {
        ...(replyLanguage ? { replyLanguage } : {}),
        ...(useGrokVoiceStore.getState().keepDays !== null
          ? { keepDays: useGrokVoiceStore.getState().keepDays! }
          : {}),
      }),
    );
    callId = started.callId;
    if (ended) {
      void runEnvironmentSpeech(endGrokCallSession(prepared, started.callId)).catch(() => {});
      return;
    }
    await call.start({
      url: started.session.url,
      token: started.session.token,
      instructions: [liveInstructions, ...standingInstructions(replyLanguage)].join("\n"),
      voice: useGrokVoiceStore.getState().voice,
      tools: liveTools,
      seed: started.seed,
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
