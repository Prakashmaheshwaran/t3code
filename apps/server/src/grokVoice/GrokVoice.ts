import {
  GrokVoiceError,
  GrokVoiceSession,
  type GrokVoiceRespondRequest,
  type GrokVoiceRespondResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";

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
    readonly respond: (
      request: GrokVoiceRespondRequest,
    ) => Effect.Effect<GrokVoiceRespondResult, GrokVoiceError>;
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

    const respond = Effect.fn("GrokVoice.respond")(
      function* (request: GrokVoiceRespondRequest) {
        const { token } = yield* login();
        const response = yield* execute(
          HttpClientRequest.post(`${API}/responses`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe({
              model: request.model ?? GROK_DELEGATOR_MODEL,
              instructions: request.instructions,
              input: request.input,
              tools: request.tools,
              store: false,
            }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* failureFor(response.status, detail.slice(0, 300));
        }
        const { output } = yield* HttpClientResponse.schemaBodyJson(ResponsesResult)(response).pipe(
          Effect.mapError(() => new GrokVoiceError({ reason: "unavailable" })),
        );
        return { output };
      },
      (effect) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "60 seconds",
            orElse: () =>
              Effect.fail(new GrokVoiceError({ reason: "unavailable", detail: "Timed out." })),
          }),
        ),
    );

    return GrokVoice.of({ session, respond });
  }),
);
