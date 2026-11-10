// @effect-diagnostics globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off processEnvInEffect:off tryCatchInEffectGen:off globalConsole:off effectFnOpportunity:off - a stateful bridge to an undocumented WebSocket and HTTP protocol, kept plain like the Codex CLI's.
// GPT-Live voice calls on a ChatGPT subscription, the way the Codex app places them. None of
// this is a documented public API: call creation posts the browser's WebRTC offer to the Codex
// backend, and a server-side control WebSocket ("sideband") carries transcripts and client
// delegations. Delegations run the same stateless delegator as Grok calls. Wire details follow
// OpenClaw's realtime-quicksilver (MIT), as used by opencode-gpt-live and hermes-talk.

import {
  ChatGptVoiceError,
  type ChatGptVoiceContextRequest,
  type ChatGptVoiceEvent,
  type ChatGptVoiceEvents,
  type ChatGptVoiceStartRequest,
  type ChatGptVoiceStartResult,
  type GrokVoiceViewed,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import { WebSocket } from "undici";

import * as GrokVoice from "../grokVoice/GrokVoice.ts";

const CALL_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const SIDEBAND_URL = "wss://api.openai.com/v1/live/";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
// The Codex CLI's public OAuth client, whose login this reuses.
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LIVE_MODEL = "gpt-live-1-codex";
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.167.0";
// The fastest tool-calling model offered to ChatGPT accounts when this was written.
const DELEGATOR_MODEL = process.env.T3_CHATGPT_VOICE_DELEGATOR_MODEL?.trim() || "gpt-5.6-luna";
const REFRESH_MARGIN_MS = 5 * 60_000;
const APPEND_MAX_BYTES = 500;
const POLL_WAIT_MS = 25_000;
// A call nobody polls is a call nobody hears; end it rather than burn the voice allowance.
const ABANDONED_MS = 45_000;

const liveInstructions = `You are T3 Code's voice assistant. Speak naturally and briefly.
Delegate requests about coding, threads, projects, models, navigation, or work to your backend. It has the tools; you do not.
Nothing happens unless you delegate. If you say you're doing something, delegate it in that same turn; if you won't delegate, ask or answer instead.
"It didn't work" or "nothing happened" is a request to check: delegate it. Always delegate status checks.
When you delegate, react briefly and never phrase it as done ("opening", "starting"): say it once, without predicting what will be done or found. The result decides.
Never claim an action happened until the backend confirms it. When the result comes back, give only the outcome and where.
Thread results arrive as commentary naming their thread and request. Attribute each result to that thread and never act on it unless the user then asks.
Do not read IDs, code blocks, or long paths aloud. Summarize results in one to three sentences.
Background speech and remarks to other people are not requests. Ask once if a request is unintelligible.
Do not speak until the user speaks.`;

interface Login {
  readonly token: string;
  readonly accountId: string;
}

function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Reads the Codex CLI's ChatGPT login; `undefined` when it holds an API key or nothing. */
export function parseCodexAuth(text: string) {
  let data: { tokens?: Record<string, unknown> } | undefined;
  try {
    data = JSON.parse(text) as { tokens?: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const tokens = data?.tokens;
  const access = tokens?.access_token;
  if (typeof access !== "string" || !access) return undefined;
  const claims = jwtClaims(access);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accountId =
    (typeof tokens?.account_id === "string" && tokens.account_id.trim()) ||
    (typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id.trim()) ||
    undefined;
  if (!accountId) return undefined;
  const exp = typeof claims.exp === "number" ? claims.exp * 1000 : Infinity;
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : undefined;
  return { token: access, accountId, expiresAt: exp, refresh };
}

function chunks(text: string) {
  const parts: string[] = [];
  let current = "";
  for (const character of text) {
    if (Buffer.byteLength(current + character) > APPEND_MAX_BYTES) {
      parts.push(current);
      current = "";
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

class Call {
  readonly events: { seq: number; event: ChatGptVoiceEvent }[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();
  readonly log: string[] = [];
  delegatedUpTo = 0;
  explained: string[] = [];
  viewed: GrokVoiceViewed | undefined;
  speaking: "user" | "assistant" | null = null;
  lastPoll = Date.now();
  closed = false;
  socket: WebSocket | undefined;
  watchdog: ReturnType<typeof setInterval> | undefined;
  readonly handled = new Set<string>();

  readonly id: string;
  readonly headers: Record<string, string>;

  constructor(id: string, headers: Record<string, string>) {
    this.id = id;
    this.headers = headers;
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
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.add(done);
    });
  }

  send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  append(text: string, channel: "speakable" | "commentary", delegationId?: string) {
    for (const part of chunks(text)) {
      const content = [{ type: "input_text", text: part }];
      this.send(
        delegationId
          ? {
              type: "delegation.context.append",
              delegation_item_id: delegationId,
              channel,
              content,
            }
          : { type: "session.context.append", channel, content },
      );
    }
  }
}

export class ChatGptVoice extends Context.Service<
  ChatGptVoice,
  {
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

const statusFailure = (status: number, detail: string) =>
  status === 401
    ? failure("rejected")
    : status === 403
      ? failure("no-voice")
      : status === 429
        ? failure("rate-limit")
        : failure("unavailable", `${status}${detail ? `: ${detail}` : ""}`);

export const layer = Layer.effect(
  ChatGptVoice,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const grok = yield* GrokVoice.GrokVoice;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const calls = new Map<string, Call>();
    const authPath = path.join(
      process.env.CODEX_HOME?.trim() || path.join(NodeOS.homedir(), ".codex"),
      "auth.json",
    );

    const readAuth = fs.readFileString(authPath).pipe(
      Effect.mapError(() => failure("not-signed-in")),
      Effect.map((text) => ({ text, parsed: parseCodexAuth(text) })),
    );

    // Refreshes like the Codex CLI and writes the rotated tokens back, so the CLI stays signed in.
    const refresh = Effect.fn("ChatGptVoice.refresh")(function* (text: string, token: string) {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: CODEX_CLIENT_ID,
              grant_type: "refresh_token",
              refresh_token: token,
              scope: "openid profile email",
            }),
          }),
        catch: () => failure("unavailable", "Couldn't refresh the ChatGPT login."),
      });
      if (!response.ok) return yield* failure("rejected");
      const fresh = (yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        catch: () => failure("unavailable", "Couldn't refresh the ChatGPT login."),
      })) as { access_token?: string; refresh_token?: string; id_token?: string };
      const file = JSON.parse(text) as { tokens: Record<string, unknown>; last_refresh?: string };
      file.tokens = {
        ...file.tokens,
        ...(fresh.access_token ? { access_token: fresh.access_token } : {}),
        ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
        ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
      };
      file.last_refresh = new Date().toISOString();
      const temporary = `${authPath}.t3-${process.pid}`;
      yield* fs
        .writeFileString(temporary, JSON.stringify(file, null, 2), { mode: 0o600 })
        .pipe(Effect.andThen(fs.rename(temporary, authPath)), Effect.orDie);
    });

    const login = Effect.fn("ChatGptVoice.login")(function* (): Effect.fn.Return<
      Login,
      ChatGptVoiceError
    > {
      const first = yield* readAuth;
      if (!first.parsed) return yield* failure("not-signed-in");
      if (first.parsed.expiresAt - Date.now() > REFRESH_MARGIN_MS) return first.parsed;
      if (!first.parsed.refresh) return yield* failure("rejected");
      yield* refresh(first.text, first.parsed.refresh);
      const again = yield* readAuth;
      if (!again.parsed || again.parsed.expiresAt <= Date.now()) return yield* failure("rejected");
      return again.parsed;
    });

    const headersFor = (auth: Login) => ({
      Authorization: `Bearer ${auth.token}`,
      "ChatGPT-Account-ID": auth.accountId,
      "OpenAI-Alpha": "quicksilver=v2",
      "session-id": crypto.randomUUID(),
      "thread-id": crypto.randomUUID(),
      "x-session-id": crypto.randomUUID(),
      originator: "t3code",
    });

    // The delegator thinks with the subscription's own Codex backend, so a call costs no API usage.
    // Plans offer different Codex models; a rejected one falls back to the account's own list.
    let delegatorModel = DELEGATOR_MODEL;
    const listedModel = async (auth: Login) => {
      const response = await fetch(MODELS_URL, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "ChatGPT-Account-ID": auth.accountId,
          originator: "t3code",
        },
      });
      const catalog = (await response.json().catch(() => ({}))) as {
        models?: { slug?: string; visibility?: string }[];
      };
      return catalog.models?.find((model) => model.visibility === "list" && model.slug)?.slug;
    };
    const postResponses = (
      auth: Login,
      model: string,
      body: Parameters<GrokVoice.DelegatorResponder>[0],
    ) =>
      fetch(RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "ChatGPT-Account-ID": auth.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "t3code",
          session_id: crypto.randomUUID(),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          instructions: body.instructions,
          input: body.input,
          tools: body.tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
          stream: true,
        }),
      }).then(async (response) => ({ status: response.status, text: await response.text() }));

    // The delegator thinks with the subscription's own Codex backend, so a call costs no API usage.
    const chatgptResponses: GrokVoice.DelegatorResponder = Effect.fn("ChatGptVoice.responses")(
      function* (body) {
        const auth = yield* login();
        const reached = yield* Effect.tryPromise({
          try: async () => {
            const first = await postResponses(auth, delegatorModel, body);
            if (first.status !== 400 || !first.text.includes("model_not_found")) return first;
            const listed = await listedModel(auth);
            if (!listed || listed === delegatorModel) return first;
            delegatorModel = listed;
            return postResponses(auth, listed, body);
          },
          catch: () => failure("unavailable", "Couldn't reach ChatGPT."),
        });
        if (reached.status < 200 || reached.status >= 300)
          return yield* statusFailure(reached.status, reached.text.slice(0, 300));
        const output: unknown[] = [];
        for (const line of reached.text.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5)) as { type?: string; item?: unknown };
            if (event.type === "response.output_item.done" && event.item) output.push(event.item);
          } catch {}
        }
        return output;
      },
    );

    const close = (call: Call, reason?: string) => {
      if (call.closed) return;
      call.closed = true;
      clearInterval(call.watchdog);
      call.send({ type: "session.close" });
      setTimeout(() => call.socket?.close(1000, "session closed"), 250);
      call.push({ type: "closed", ...(reason ? { reason } : {}) });
      // Keep the final events readable briefly, then forget the call.
      setTimeout(() => calls.delete(call.id), 60_000);
    };

    const delegate = (call: Call, id: string, prompt: string) => {
      if (call.handled.has(id)) return;
      call.handled.add(id);
      call.push({ type: "delegating", id });
      const transcript = call.log.slice(call.delegatedUpTo).slice(-20);
      call.delegatedUpTo = call.log.length;
      const request =
        prompt || call.log.findLast((line) => line.startsWith("User: "))?.slice(6) || "";
      void runPromise(
        grok.delegateWith(
          {
            request,
            transcript,
            ...(call.viewed ? { viewed: call.viewed } : {}),
            explained: call.explained,
          },
          chatgptResponses,
        ),
      ).then(
        (result) => {
          call.explained = [...result.explained];
          call.append(result.speech, "speakable", id);
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
          call.append(`That failed: ${message}`, "speakable", id);
          call.push({ type: "note", text: `Delegation failed: ${message}` });
          call.push({ type: "delegated", id, speech: "", sent: [] });
        },
      );
    };

    const speaking = (call: Call, who: "user" | "assistant" | null) => {
      if (call.speaking === who) return;
      call.speaking = who;
      call.push({ type: "speaking", who });
    };

    const onSidebandEvent = (call: Call, raw: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const record = (value: unknown) =>
        value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      switch (event.type) {
        case "session.input_transcript.delta":
          return speaking(call, "user");
        case "session.output_transcript.delta":
          return speaking(call, "assistant");
        case "output_audio_buffer.cleared":
          return speaking(call, null);
        case "turn.done": {
          const turn = record(event.turn);
          const text = typeof turn.transcript === "string" ? turn.transcript.trim() : "";
          speaking(call, null);
          if (!text || (turn.role !== "user" && turn.role !== "assistant")) return;
          call.log.push(`${turn.role === "user" ? "User" : "Voice agent"}: ${text}`);
          call.push({ type: "transcript", role: turn.role, text });
          return;
        }
        case "delegation.created": {
          const item = record(event.item);
          if (item.type !== "delegation" || item.target !== "client" || typeof item.id !== "string")
            return;
          const prompt = Array.isArray(item.content)
            ? item.content
                .map((part) => record(part))
                .filter((part) => part.type === "input_text")
                .map((part) => String(part.text ?? ""))
                .join("")
            : "";
          return delegate(call, item.id, prompt.trim());
        }
        case "session.delegation.created": {
          const delegation = record(event.delegation);
          if (delegation.target !== "client" || typeof delegation.id !== "string") return;
          return delegate(call, delegation.id, "");
        }
        case "session.closed":
          return close(call, typeof event.reason === "string" ? event.reason : undefined);
        case "error": {
          const error = record(event.error);
          console.warn("[chatgpt-voice] Live error", error.code ?? event.code ?? "unknown");
          return;
        }
      }
    };

    const connectSideband = (call: Call) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${SIDEBAND_URL}${encodeURIComponent(call.id)}`, {
          headers: call.headers,
        });
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("timeout"));
        }, 15_000);
        let opened = false;
        socket.addEventListener("open", () => {
          opened = true;
          clearTimeout(timer);
          call.socket = socket;
          resolve();
        });
        socket.addEventListener("message", (message) => {
          if (typeof message.data === "string") onSidebandEvent(call, message.data);
        });
        socket.addEventListener("close", (event) => {
          clearTimeout(timer);
          if (!opened) return reject(new Error(`closed ${event.code}`));
          close(call, event.reason || "The call ended.");
        });
        socket.addEventListener("error", () => {
          if (!opened) {
            clearTimeout(timer);
            reject(new Error("error"));
          }
        });
      });

    const start = Effect.fn("ChatGptVoice.start")(function* (request: ChatGptVoiceStartRequest) {
      const auth = yield* login();
      const headers = headersFor(auth);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(CALL_URL, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              sdp: request.sdp,
              session: {
                model: LIVE_MODEL,
                instructions: liveInstructions,
                audio: { output: { voice: request.voice } },
                delegation: { type: "client" },
              },
            }),
          }),
        catch: () => failure("unavailable", "Couldn't reach ChatGPT."),
      });
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => failure("unavailable", "ChatGPT's answer was cut off."),
      });
      if (!response.ok)
        return yield* statusFailure(
          response.status,
          body.split(auth.token).join("[redacted]").slice(0, 300),
        );
      const location = response.headers.get("location") ?? "";
      const callId =
        new URL(location || "/", CALL_URL).pathname
          .split("/")
          .find((segment) => /^(rtc_[\w-]+|[0-9a-f-]{36})$/i.test(segment)) ??
        response.headers.get("openai-session-id")?.trim();
      if (!callId || !body.trim()) return yield* failure("unavailable", "No call was created.");

      const call = new Call(callId, headers);
      if (request.viewed) call.viewed = request.viewed;
      calls.set(callId, call);
      yield* Effect.tryPromise({
        try: async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await connectSideband(call);
            } catch (error) {
              if (attempt >= 4) throw error;
              await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
            }
          }
        },
        catch: () => {
          calls.delete(callId);
          return failure("unavailable", "The call's control channel didn't connect.");
        },
      });
      call.watchdog = setInterval(() => {
        if (Date.now() - call.lastPoll > ABANDONED_MS) close(call, "The app stopped listening.");
      }, 10_000);
      return { callId, sdp: body };
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
      if (request.announce) call.append(request.announce, "commentary");
    });

    const end = (callId: string) =>
      Effect.sync(() => {
        const call = calls.get(callId);
        if (call) close(call, "Hung up.");
      });

    return ChatGptVoice.of({ start, events, context, end });
  }),
);
