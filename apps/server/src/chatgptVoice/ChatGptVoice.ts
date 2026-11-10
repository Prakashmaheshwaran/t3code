// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off processEnvInEffect:off tryCatchInEffectGen:off globalConsole:off effectFnOpportunity:off - a long-lived JSON-RPC bridge to the Codex CLI's app-server, kept plain like the CLI's own clients.

// GPT-Live voice calls on a ChatGPT subscription, run by the Codex CLI's own app-server so its
// login, refresh, and call placement stay Codex's job. The browser's WebRTC offer goes through
// `thread/realtime/start`; each voice handoff cancels Codex's own agent turn and runs T3 Code's
// stateless delegator instead, whose answer the voice speaks via `thread/realtime/appendSpeech`.

import {
  ChatGptVoiceError,
  type ChatGptVoiceContextRequest,
  type ChatGptVoiceEvent,
  type ChatGptVoiceEvents,
  type ChatGptVoiceModels,
  type ChatGptVoiceStartRequest,
  type ChatGptVoiceStartResult,
  type GrokVoiceViewed,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as GrokVoice from "../grokVoice/GrokVoice.ts";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_BINARIES = ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
// Used when the call doesn't name a model and the account still offers it.
const PREFERRED_DELEGATOR_MODEL =
  process.env.T3_CHATGPT_VOICE_DELEGATOR_MODEL?.trim() || "gpt-5.6-luna";
const TOKEN_MARGIN_MS = 5 * 60_000;
const POLL_WAIT_MS = 25_000;
// A call nobody polls is a call nobody hears; end it rather than burn the voice allowance.
const ABANDONED_MS = 45_000;

function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The ChatGPT account and expiry a Codex access token carries. */
export function codexTokenIdentity(token: string) {
  const claims = jwtClaims(token);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accountId =
    typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id.trim() : "";
  if (!accountId) return undefined;
  return {
    accountId,
    expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : Infinity,
  };
}

type Notification = { method: string; params: Record<string, unknown> };

const wordsKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** One `codex app-server` over stdio JSON-RPC. */
class AppServer {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private buffer = "";
  readonly listeners = new Set<(message: Notification) => void>();
  dead = false;

  constructor(command: string, cwd: string) {
    this.child = NodeChildProcess.spawn(command, ["app-server"], {
      cwd,
      env: { ...process.env, RUST_LOG: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.on("data", () => {});
    const fail = (error: Error) => {
      if (this.dead) return;
      this.dead = true;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      for (const listener of this.listeners)
        listener({ method: "app-server/exited", params: { message: error.message } });
    };
    this.child.on("error", fail);
    this.child.on("exit", (code) => fail(new Error(`Codex app-server exited (${code}).`)));
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && message.method) {
        // The voice thread never asks to run anything we would allow.
        this.write({ id: message.id, result: { decision: "decline" } });
        continue;
      }
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message ?? "Codex error"));
        else waiter?.resolve(message.result);
        continue;
      }
      if (message.method)
        for (const listener of this.listeners)
          listener({ method: message.method, params: message.params ?? {} });
    }
  }

  private write(message: Record<string, unknown>) {
    if (!this.dead) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error("Codex app-server is not running."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string) {
    this.write({ method });
  }

  kill() {
    this.child.kill();
  }
}

class Call {
  readonly threadId: string;
  readonly events: { seq: number; event: ChatGptVoiceEvent }[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();
  readonly log: string[] = [];
  delegatedUpTo = 0;
  explained: string[] = [];
  viewed: GrokVoiceViewed | undefined;
  delegatorModel: string | undefined;
  lastPoll = Date.now();
  closed = false;
  watchdog: ReturnType<typeof setInterval> | undefined;
  readonly handled = new Set<string>();
  /** Handoffs carry the user's words before Live's final transcript of them arrives. */
  readonly delegatedWords = new Set<string>();

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  push(event: ChatGptVoiceEvent) {
    this.events.push({ seq: ++this.seq, event });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  after(seq: number) {
    return this.events.filter((entry) => entry.seq > seq);
  }

  get latest() {
    return this.seq;
  }

  wait(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, ms);
      this.waiters.add(done);
    });
  }
}

export class ChatGptVoice extends Context.Service<
  ChatGptVoice,
  {
    readonly models: Effect.Effect<ChatGptVoiceModels, ChatGptVoiceError>;
    readonly start: (
      request: ChatGptVoiceStartRequest,
    ) => Effect.Effect<ChatGptVoiceStartResult, ChatGptVoiceError>;
    readonly events: (
      callId: string,
      after: number,
    ) => Effect.Effect<ChatGptVoiceEvents, ChatGptVoiceError>;
    readonly context: (
      callId: string,
      request: ChatGptVoiceContextRequest,
    ) => Effect.Effect<void, ChatGptVoiceError>;
    readonly end: (callId: string) => Effect.Effect<void>;
  }
>()("t3/chatgptVoice/ChatGptVoice") {}

const failure = (reason: ChatGptVoiceError["reason"], detail?: string) =>
  new ChatGptVoiceError({ reason, ...(detail ? { detail } : {}) });
const isChatGptVoiceError = (value: unknown): value is ChatGptVoiceError =>
  value instanceof Error && (value as { _tag?: unknown })._tag === "ChatGptVoiceError";

/** Maps Codex's realtime errors onto what the user can act on. */
function realtimeFailure(message: string) {
  if (/not logged in|sign in|log in/i.test(message)) return failure("not-signed-in");
  if (/404|not found|entitle/i.test(message)) return failure("no-voice");
  if (/429|rate limit|usage limit/i.test(message)) return failure("rate-limit");
  if (/401|unauthorized/i.test(message)) return failure("rejected");
  return failure("unavailable", message.slice(0, 300));
}

export const layer = Layer.effect(
  ChatGptVoice,
  Effect.gen(function* () {
    const grok = yield* GrokVoice.GrokVoice;
    const config = yield* ServerConfig.ServerConfig;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const calls = new Map<string, Call>();
    const workDir = NodePath.join(NodePath.dirname(config.serverRuntimeStatePath), "voice-codex");
    let server: Promise<AppServer> | undefined;
    let token: { value: string; accountId: string; expiresAt: number } | undefined;

    const route = (message: Notification) => {
      if (message.method === "app-server/exited") {
        server = undefined;
        token = undefined;
        for (const call of calls.values()) close(call, "Codex stopped running.");
        return;
      }
      const threadId = message.params.threadId;
      const call = typeof threadId === "string" ? calls.get(threadId) : undefined;
      if (call) onCallEvent(call, message);
    };

    const launch = async () => {
      NodeFS.mkdirSync(workDir, { recursive: true });
      let lastError: unknown;
      for (const command of CODEX_BINARIES) {
        const candidate = new AppServer(command, workDir);
        try {
          await candidate.request("initialize", {
            clientInfo: { name: "t3code-voice", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          });
          candidate.notify("initialized");
          candidate.listeners.add(route);
          return candidate;
        } catch (error) {
          lastError = error;
          candidate.kill();
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Couldn't start Codex.");
    };

    const appServer = async (): Promise<AppServer> => {
      server ??= launch().catch((error: unknown) => {
        server = undefined;
        throw error;
      });
      const running = await server;
      if (!running.dead) return running;
      server = undefined;
      return appServer();
    };

    const tryCodex = <A>(work: () => Promise<A>) =>
      Effect.tryPromise({
        try: work,
        catch: (error) =>
          isChatGptVoiceError(error)
            ? error
            : /ENOENT|spawn/i.test(String(error))
              ? failure("not-signed-in", "Install the Codex CLI (npm i -g @openai/codex).")
              : realtimeFailure(error instanceof Error ? error.message : String(error)),
      });

    // Codex keeps the login fresh; it hands out the current token when asked.
    const currentToken = async () => {
      if (token && token.expiresAt - Date.now() > TOKEN_MARGIN_MS) return token;
      const running = await appServer();
      for (const refreshToken of [false, true]) {
        const status = await running.request<{ authToken: string | null }>("getAuthStatus", {
          includeToken: true,
          refreshToken,
        });
        const identity = status.authToken ? codexTokenIdentity(status.authToken) : undefined;
        if (status.authToken && identity && identity.expiresAt - Date.now() > TOKEN_MARGIN_MS) {
          token = { value: status.authToken, ...identity };
          return token;
        }
      }
      throw failure("not-signed-in");
    };

    const listModels = async () => {
      const running = await appServer();
      const listed = await running.request<{
        data?: { model?: string; id?: string; displayName?: string; hidden?: boolean }[];
      }>("model/list", {});
      return (listed.data ?? []).flatMap((model) => {
        const id = model.model || model.id;
        return !model.hidden && id ? [{ id, name: model.displayName || id }] : [];
      });
    };

    const defaultModel = (ids: ReadonlyArray<string>) =>
      ids.includes(PREFERRED_DELEGATOR_MODEL) ? PREFERRED_DELEGATOR_MODEL : (ids[0] ?? null);

    const models = tryCodex(async () => {
      const listed = await listModels();
      return { models: listed, default: defaultModel(listed.map((model) => model.id)) };
    });

    // The delegator thinks with the plan's own Codex backend, statelessly, one request at a time.
    const responder =
      (call: Call): GrokVoice.DelegatorResponder =>
      (body) =>
        tryCodex(async () => {
          const auth = await currentToken();
          call.delegatorModel ??=
            defaultModel((await listModels()).map((model) => model.id)) ?? undefined;
          if (!call.delegatorModel) throw failure("unavailable", "No Codex model is available.");
          const response = await fetch(RESPONSES_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${auth.value}`,
              "ChatGPT-Account-ID": auth.accountId,
              "OpenAI-Beta": "responses=experimental",
              originator: "t3code",
              session_id: crypto.randomUUID(),
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              model: call.delegatorModel,
              instructions: body.instructions,
              input: body.input,
              tools: body.tools,
              tool_choice: "auto",
              parallel_tool_calls: false,
              store: false,
              stream: true,
            }),
          });
          const text = await response.text();
          if (!response.ok)
            throw failure("unavailable", `${response.status}: ${text.slice(0, 300)}`);
          const output: unknown[] = [];
          for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5)) as { type?: string; item?: unknown };
              if (event.type === "response.output_item.done" && event.item) output.push(event.item);
            } catch {}
          }
          return output;
        });

    const speak = (call: Call, text: string) => {
      if (call.closed || !text.trim()) return;
      void appServer()
        .then((running) =>
          running.request("thread/realtime/appendSpeech", { threadId: call.threadId, text }),
        )
        .catch(() => call.push({ type: "note", text: "Couldn't hand that answer to the voice." }));
    };

    const close = (call: Call, reason?: string) => {
      if (call.closed) return;
      call.closed = true;
      clearInterval(call.watchdog);
      void server
        ?.then((running) =>
          running.dead
            ? undefined
            : running.request("thread/realtime/stop", { threadId: call.threadId }),
        )
        .catch(() => {});
      call.push({ type: "closed", ...(reason ? { reason } : {}) });
      // Keep the final events readable briefly, then forget the call.
      setTimeout(() => calls.delete(call.threadId), 60_000);
    };

    const delegate = (call: Call, id: string, prompt: string) => {
      if (call.handled.has(id)) return;
      call.handled.add(id);
      call.push({ type: "delegating", id });
      const transcript = [...call.log.slice(call.delegatedUpTo).slice(-19), `User: ${prompt}`];
      call.delegatedUpTo = call.log.length;
      call.delegatedWords.add(wordsKey(prompt));
      void runPromise(
        grok.delegateWith(
          {
            request: prompt,
            transcript,
            ...(call.viewed ? { viewed: call.viewed } : {}),
            explained: call.explained,
          },
          responder(call),
        ),
      ).then(
        (result) => {
          call.explained = [...result.explained];
          speak(call, result.speech);
          call.push({
            type: "delegated",
            id,
            speech: result.speech,
            ...(result.open ? { open: result.open } : {}),
            sent: [...result.sent],
          });
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          speak(call, `That failed: ${message}`);
          call.push({ type: "note", text: `Delegation failed: ${message}` });
          call.push({ type: "delegated", id, speech: "", sent: [] });
        },
      );
    };

    const onCallEvent = (call: Call, { method, params }: Notification) => {
      switch (method) {
        case "turn/started": {
          // Voice handoffs start Codex's own agent; T3 Code's delegator answers instead.
          const turnId = (params.turn as { id?: unknown } | undefined)?.id;
          if (typeof turnId === "string")
            void appServer()
              .then((running) =>
                running.request("turn/interrupt", { threadId: call.threadId, turnId }),
              )
              .catch(() => {});
          return;
        }
        case "thread/realtime/itemAdded": {
          const item = params.item as Record<string, unknown> | undefined;
          if (item?.type !== "handoff_request") return;
          const id = String(item.handoff_id ?? item.item_id ?? "");
          const prompt = typeof item.input_transcript === "string" ? item.input_transcript : "";
          if (id) delegate(call, id, prompt.trim());
          return;
        }
        case "thread/realtime/transcript/done": {
          const text = typeof params.text === "string" ? params.text.trim() : "";
          const role = params.role === "user" ? "user" : "assistant";
          if (!text) return;
          // A late transcript of words already handed off would leak into the next request.
          if (role !== "user" || !call.delegatedWords.delete(wordsKey(text)))
            call.log.push(`${role === "user" ? "User" : "Voice agent"}: ${text}`);
          call.push({ type: "transcript", role, text });
          return;
        }
        case "thread/realtime/error":
          call.push({ type: "note", text: String(params.message ?? "Voice error").slice(0, 300) });
          return;
        case "thread/realtime/closed":
          return close(call, typeof params.reason === "string" ? params.reason : undefined);
      }
    };

    const start = Effect.fn("ChatGptVoice.start")(function* (request: ChatGptVoiceStartRequest) {
      return yield* tryCodex(async () => {
        const running = await appServer();
        const thread = await running.request<{ thread: { id: string } }>("thread/start", {
          cwd: workDir,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
        });
        const call = new Call(thread.thread.id);
        call.viewed = request.viewed;
        call.delegatorModel = request.delegatorModel;
        calls.set(call.threadId, call);
        const answer = new Promise<string>((resolve, reject) => {
          const listen = ({ method, params }: Notification) => {
            if (params.threadId !== call.threadId) return;
            if (method !== "thread/realtime/sdp" && method !== "thread/realtime/error") return;
            clearTimeout(timer);
            running.listeners.delete(listen);
            if (method === "thread/realtime/sdp") resolve(String(params.sdp));
            else reject(new Error(String(params.message)));
          };
          const timer = setTimeout(() => {
            running.listeners.delete(listen);
            reject(new Error("ChatGPT didn't answer the call."));
          }, 20_000);
          running.listeners.add(listen);
        });
        try {
          await running.request("thread/realtime/start", {
            threadId: call.threadId,
            outputModality: "audio",
            transport: { type: "webrtc", sdp: request.sdp },
            version: "v3",
            voice: request.voice,
            clientManagedHandoffs: true,
            includeStartupContext: false,
          });
          const sdp = await answer;
          call.watchdog = setInterval(() => {
            if (Date.now() - call.lastPoll > ABANDONED_MS)
              close(call, "The app stopped listening.");
          }, 10_000);
          return { callId: call.threadId, sdp };
        } catch (error) {
          calls.delete(call.threadId);
          throw error;
        }
      });
    });

    const callFor = (callId: string) =>
      Effect.suspend(() => {
        const call = calls.get(callId);
        return call ? Effect.succeed(call) : Effect.fail(failure("no-call"));
      });

    const events = Effect.fn("ChatGptVoice.events")(function* (callId: string, after: number) {
      const call = yield* callFor(callId);
      call.lastPoll = Date.now();
      if (call.after(after).length === 0 && !call.closed)
        yield* Effect.promise(() => call.wait(POLL_WAIT_MS));
      call.lastPoll = Date.now();
      return { events: call.after(after).map((entry) => entry.event), next: call.latest };
    });

    const context = Effect.fn("ChatGptVoice.context")(function* (
      callId: string,
      request: ChatGptVoiceContextRequest,
    ) {
      const call = yield* callFor(callId);
      if (request.viewed) call.viewed = request.viewed;
      if (request.announce) speak(call, request.announce);
    });

    const end = (callId: string) =>
      Effect.sync(() => {
        const call = calls.get(callId);
        if (call) close(call, "Hung up.");
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        void server?.then((running) => running.kill()).catch(() => {});
      }),
    );

    return ChatGptVoice.of({ models, start, events, context, end });
  }),
);
