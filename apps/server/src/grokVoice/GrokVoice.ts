import {
  CommandId,
  RuntimeRequestId,
  ThreadId,
  GrokVoiceError,
  GrokVoiceSession,
  type GrokVoiceDelegateRequest,
  type GrokVoiceDelegateResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeOS from "node:os";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { runDelegation, type McpTool } from "./Delegator.ts";

const API = "https://api.x.ai/v1";
const GROK_VOICE_MODEL = "grok-voice-latest";
const GROK_DELEGATOR_MODEL = "grok-4.20-0309-non-reasoning";
// Refresh through the CLI this long before expiry so a call never starts on a dying token.
const REFRESH_MARGIN_MS = 5 * 60_000;
const GROK_BINARIES = ["grok", "/opt/homebrew/bin/grok", "/usr/local/bin/grok"];

const AuthEntry = Schema.Struct({
  key: Schema.String,
  expires_at: Schema.optionalKey(Schema.String),
});
const AuthFile = Schema.Record(Schema.String, Schema.Unknown);
const ClientSecret = Schema.Struct({ value: Schema.String, expires_at: Schema.Number });
const ResponsesResult = Schema.Struct({ output: Schema.Array(Schema.Unknown) });
const decodeAuthFile = Schema.decodeUnknownOption(AuthFile);
const decodeAuthEntry = Schema.decodeUnknownOption(AuthEntry);
const isGrokVoiceError = Schema.is(GrokVoiceError);

export interface GrokLogin {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

/** Picks the freshest usable credential from the Grok CLI's `auth.json`. */
export function parseGrokAuth(text: string): GrokLogin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const file = decodeAuthFile(parsed);
  if (file._tag === "None") return undefined;
  let best: GrokLogin | undefined;
  for (const value of Object.values(file.value)) {
    const entry = decodeAuthEntry(value);
    if (entry._tag === "None" || !entry.value.key) continue;
    const expiresAt = entry.value.expires_at ? Date.parse(entry.value.expires_at) : Infinity;
    const candidate = { token: Redacted.make(entry.value.key), expiresAt };
    if (!best || candidate.expiresAt > best.expiresAt) best = candidate;
  }
  return best;
}

const grokAuthPath = (path: Path.Path) =>
  path.join(process.env.GROK_HOME?.trim() || path.join(NodeOS.homedir(), ".grok"), "auth.json");

export class GrokVoice extends Context.Service<
  GrokVoice,
  {
    readonly session: Effect.Effect<GrokVoiceSession, GrokVoiceError>;
    readonly delegate: (
      request: GrokVoiceDelegateRequest,
    ) => Effect.Effect<GrokVoiceDelegateResult, GrokVoiceError>;
  }
>()("t3/grokVoice/GrokVoice") {}

const failureFor = (status: number, detail?: string) =>
  new GrokVoiceError({
    reason: [401, 403].includes(status)
      ? "rejected"
      : status === 429
        ? "rate-limit"
        : "unavailable",
    ...(detail ? { detail } : {}),
  });

export const layer = Layer.effect(
  GrokVoice,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const processes = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const config = yield* ServerConfig.ServerConfig;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const random = yield* SecureRandom.SecureRandom;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(() => new GrokVoiceError({ reason: "unavailable" })),
      );

    const readLogin = fs.readFileString(grokAuthPath(path)).pipe(
      Effect.mapError(() => new GrokVoiceError({ reason: "not-signed-in" })),
      Effect.map(parseGrokAuth),
    );

    // The CLI owns the refresh token; running it lets it rotate and persist the login itself.
    const refreshThroughCli = Effect.fn("GrokVoice.refresh")(function* () {
      for (const command of GROK_BINARIES) {
        const ran = yield* processes
          .run({ command, args: ["models"], timeout: "30 seconds" })
          .pipe(Effect.option);
        if (ran._tag === "Some") return;
      }
    });

    const login = Effect.fn("GrokVoice.login")(function* () {
      const current = yield* readLogin;
      if (current && current.expiresAt - (yield* Clock.currentTimeMillis) > REFRESH_MARGIN_MS)
        return current;
      yield* refreshThroughCli();
      const refreshed = yield* readLogin;
      if (!refreshed) return yield* new GrokVoiceError({ reason: "not-signed-in" });
      if (refreshed.expiresAt <= (yield* Clock.currentTimeMillis))
        return yield* new GrokVoiceError({ reason: "rejected" });
      return refreshed;
    });

    const session = Effect.gen(function* () {
      const { token } = yield* login();
      const response = yield* execute(
        HttpClientRequest.post(`${API}/realtime/client_secrets`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({ expires_after: { seconds: 60 } }),
        ),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* failureFor(response.status);
      const secret = yield* HttpClientResponse.schemaBodyJson(ClientSecret)(response).pipe(
        Effect.mapError(() => new GrokVoiceError({ reason: "unavailable" })),
      );
      return {
        url: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(GROK_VOICE_MODEL)}`,
        token: secret.value,
        expiresAt: secret.expires_at,
      };
    }).pipe(Effect.withSpan("GrokVoice.session"));

    const responses = Effect.fn("GrokVoice.responses")(function* (body: {
      instructions: string;
      input: ReadonlyArray<unknown>;
      tools: ReadonlyArray<unknown>;
    }) {
      const { token } = yield* login();
      const response = yield* execute(
        HttpClientRequest.post(`${API}/responses`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({ model: GROK_DELEGATOR_MODEL, store: false, ...body }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* failureFor(response.status, detail.slice(0, 300));
      }
      const { output } = yield* HttpClientResponse.schemaBodyJson(ResponsesResult)(response).pipe(
        Effect.mapError(() => new GrokVoiceError({ reason: "unavailable" })),
      );
      return output;
    });

    const unavailable = (detail: string) => new GrokVoiceError({ reason: "unavailable", detail });

    // The delegator is an outside MCP client of this same server, like `t3 thread`: it gets
    // T3 Code's own tools without being a thread, and its credential ends with the request.
    const delegate = Effect.fn("GrokVoice.delegate")(
      function* (request: GrokVoiceDelegateRequest) {
        yield* login();
        const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError(() => unavailable("Couldn't find this server's address.")),
        );
        if (state._tag === "None")
          return yield* unavailable("Couldn't find this server's address.");
        const issued = yield* Effect.acquireRelease(
          auth
            .issueMcpClientSession({
              label: "Grok voice",
              access: "full-access",
              peerLink: false,
              client: { deviceType: "bot" },
            })
            .pipe(Effect.mapError(() => unavailable("Couldn't authorize T3 Code's tools."))),
          (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
        );
        const mcp = yield* mcpToolSession({
          endpoint: new URL("/mcp", state.value.origin).href,
          authorization: `Bearer ${issued.token}`,
          clientName: "t3-grok-voice",
        }).pipe(Effect.mapError((error) => unavailable(error.message)));
        const listed = yield* mcp.list.pipe(Effect.mapError((error) => unavailable(error.message)));
        const tools = ((listed as { tools?: McpTool[] } | null)?.tools ?? []) as McpTool[];
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        return yield* Effect.tryPromise({
          try: () =>
            runDelegation(
              {
                tools,
                respond: (body) => runPromise(responses(body)),
                call: (name, args) => runPromise(mcp.call(name, args)),
                approvals: {
                  list: (threadId) =>
                    runPromise(
                      threads
                        .getThreadRecords(ThreadId.make(threadId), ["runtimeRequests"])
                        .pipe(
                          Effect.map(({ runtimeRequests }) =>
                            runtimeRequests
                              .filter(
                                (entry) =>
                                  entry.status === "pending" &&
                                  entry.responseCapability.type === "live" &&
                                  entry.kind !== "user_input" &&
                                  entry.kind !== "dynamic_tool_call" &&
                                  entry.kind !== "auth_refresh",
                              )
                              .map((entry) => ({ requestId: entry.id, kind: entry.kind })),
                          ),
                        ),
                    ),
                  answer: (threadId, requestId, decision) =>
                    runPromise(
                      random.uuidV4().pipe(
                        Effect.flatMap((uuid) =>
                          threads.dispatch({
                            type: "runtime-request.respond",
                            threadId: ThreadId.make(threadId),
                            commandId: CommandId.make(`grok-voice:${uuid}`),
                            requestId: RuntimeRequestId.make(requestId),
                            decision,
                          }),
                        ),
                        Effect.asVoid,
                      ),
                    ),
                },
              },
              request,
            ),
          catch: (error) =>
            isGrokVoiceError(error)
              ? error
              : unavailable(error instanceof Error ? error.message : String(error)),
        });
      },
      (effect) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: "140 seconds",
            orElse: () => Effect.fail(unavailable("Timed out.")),
          }),
        ),
    );

    return GrokVoice.of({ session, delegate });
  }),
);
