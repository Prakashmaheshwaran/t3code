// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off tryCatchInEffectGen:off effectFnOpportunity:off - a small in-memory registry of live calls, kept plain like ChatGptVoice.

// The memory of Grok voice calls. Grok's realtime session runs in the browser, so the app posts
// each line here as it's said; delegations name the call to get its notes, a refresh gets a new
// session seeded with them, and hanging up saves the call to the shared history.

import type {
  GrokCallLines,
  GrokCallSession,
  GrokCallStartRequest,
  GrokVoiceDelegateRequest,
  GrokVoiceDelegateResult,
} from "@t3tools/contracts";
import { GrokVoiceError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import {
  CallLog,
  KEEP_LINES,
  delegationMemory,
  render,
  seedItems,
  spoken,
  type Summarize,
} from "../voiceCalls/memory.ts";
import {
  recentNotes,
  saveCall,
  savesSettled,
  trackSave,
  voiceCallsDir,
} from "../voiceCalls/store.ts";
import * as GrokVoice from "./GrokVoice.ts";

const RESUME_FOLD_WAIT_MS = 4_000;
const SAVE_FOLD_WAIT_MS = 15_000;
const SAVE_WAIT_MS = 5_000;
// Grok often calls `delegate` before its transcript of the user's words is final; words that
// land this soon after a delegation that lacked them were that delegation's request.
const LATE_TRANSCRIPT_MS = 4_000;
// A call the app stopped talking about (a crash, a closed laptop) is saved and forgotten.
const IDLE_MS = 2 * 60 * 60_000;

class GrokCall extends CallLog {
  readonly id = crypto.randomUUID();
  readonly startedAt = Date.now();
  delegatedUpTo = 0;
  /** When the last delegation ran, and whether it had the user's own words for its request. */
  lastDelegationAt = 0;
  lastDelegationHeardUser = true;
  replyLanguage: string | undefined;
  keepDays: number | undefined;
  lastActive = Date.now();
  closed = false;
}

export class GrokCalls extends Context.Service<
  GrokCalls,
  {
    readonly start: (
      request: GrokCallStartRequest,
    ) => Effect.Effect<GrokCallSession, GrokVoiceError>;
    readonly lines: (callId: string, request: GrokCallLines) => Effect.Effect<void>;
    /** A delegation with the call's own lines and notes; stateless without a known call. */
    readonly delegate: (
      request: GrokVoiceDelegateRequest,
    ) => Effect.Effect<GrokVoiceDelegateResult, GrokVoiceError>;
    readonly resume: (callId: string) => Effect.Effect<GrokCallSession, GrokVoiceError>;
    readonly end: (callId: string) => Effect.Effect<void>;
  }
>()("t3/grokVoice/GrokCalls") {}

const within = (work: Promise<unknown>, ms: number) =>
  Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms))]);

const outputText = (output: ReadonlyArray<unknown>) =>
  (output as { content?: { text?: string }[] }[])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

export const layer = Layer.effect(
  GrokCalls,
  Effect.gen(function* () {
    const grok = yield* GrokVoice.GrokVoice;
    const config = yield* ServerConfig.ServerConfig;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const callsDir = voiceCallsDir(NodePath.dirname(config.serverRuntimeStatePath));
    const calls = new Map<string, GrokCall>();

    const summarize: Summarize = async ({ instructions, input }) =>
      outputText(
        await runPromise(
          grok.respond({ instructions, input: [{ role: "user", content: input }], tools: [] }),
        ),
      );

    const save = async (call: GrokCall) => {
      if (call.lines.length === 0 || call.keepDays === 0) return;
      await within(call.fold(call.lines.length, summarize), SAVE_FOLD_WAIT_MS);
      try {
        saveCall(
          callsDir,
          {
            id: call.id,
            provider: "grok",
            startedAt: call.startedAt,
            endedAt: Date.now(),
            notes: call.notes,
            lines: call.lines,
          },
          call.keepDays,
        );
      } catch {}
    };

    const close = (call: GrokCall) => {
      if (call.closed) return;
      call.closed = true;
      calls.delete(call.id);
      void trackSave(save(call));
    };

    const sweep = setInterval(() => {
      for (const call of calls.values()) if (Date.now() - call.lastActive > IDLE_MS) close(call);
    }, 10 * 60_000);
    yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(sweep)));

    const live = (callId: string) => {
      const call = calls.get(callId);
      if (call) call.lastActive = Date.now();
      return call;
    };
    const ended = () =>
      new GrokVoiceError({ reason: "unavailable", detail: "That call has ended." });

    const sessionFor = (call: GrokCall, resumed: boolean) =>
      grok.session.pipe(
        Effect.map((session) => ({ callId: call.id, session, seed: seedItems(call, resumed) })),
      );

    const start = (request: GrokCallStartRequest) =>
      Effect.promise(() => savesSettled(SAVE_WAIT_MS)).pipe(
        Effect.andThen(() => {
          const call = new GrokCall();
          call.replyLanguage = request.replyLanguage;
          call.keepDays = request.keepDays;
          if (request.keepDays !== 0) call.earlier = recentNotes(callsDir, Date.now());
          return sessionFor(call, false).pipe(
            Effect.tap(() => Effect.sync(() => calls.set(call.id, call))),
          );
        }),
      );

    const lines = (callId: string, request: GrokCallLines) =>
      Effect.sync(() => {
        const call = live(callId);
        if (!call) return;
        for (const line of request.lines) {
          call.add(line.who, line.text);
          if (
            line.who === "User" &&
            !call.lastDelegationHeardUser &&
            Date.now() - call.lastDelegationAt < LATE_TRANSCRIPT_MS
          ) {
            call.delegatedUpTo = call.lines.length;
            call.lastDelegationHeardUser = true;
          }
        }
        call.foldIfLong(summarize);
      });

    const delegate = (request: GrokVoiceDelegateRequest) =>
      Effect.suspend(() => {
        const call = request.callId ? live(request.callId) : undefined;
        if (!call) return grok.delegate(request);
        const deltaStart = call.delegatedUpTo;
        const said = call.lines.slice(deltaStart).filter(spoken).slice(-20).map(render);
        const memory = delegationMemory(call, deltaStart);
        call.delegatedUpTo = call.lines.length;
        call.lastDelegationAt = Date.now();
        call.lastDelegationHeardUser = said.some((line) => line.startsWith("User: "));
        return grok
          .delegate({
            request: request.request,
            transcript: said.length > 0 ? said : [`User: ${request.request}`],
            ...(request.viewed ? { viewed: request.viewed } : {}),
            ...(memory ? { memory } : {}),
            ...(call.replyLanguage ? { replyLanguage: call.replyLanguage } : {}),
          })
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                const where = result.sent.flatMap((sent) =>
                  sent.title ? [JSON.stringify(sent.title)] : [],
                );
                call.add(
                  "T3 Code",
                  `${result.speech}${where.length ? ` (sent to ${where.join(", ")})` : ""}`,
                );
                call.foldIfLong(summarize);
              }),
            ),
          );
      });

    const resume = (callId: string) =>
      Effect.suspend(() => {
        const call = live(callId);
        if (!call) return Effect.fail(ended());
        return Effect.promise(() =>
          within(
            call.fold(Math.max(call.foldedUpTo, call.lines.length - KEEP_LINES), summarize),
            RESUME_FOLD_WAIT_MS,
          ),
        ).pipe(Effect.andThen(sessionFor(call, true)));
      });

    const end = (callId: string) =>
      Effect.sync(() => {
        const call = calls.get(callId);
        if (call) close(call);
      });

    return GrokCalls.of({ start, lines, delegate, resume, end });
  }),
);
