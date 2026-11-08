import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Live voice calls ride the Codex app-server's thread-scoped realtime transport.
 * The server owns signalling; the browser owns the WebRTC audio and the peer connection.
 */
export function createVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:start",
      tag: WS_METHODS.voiceStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:stop",
      tag: WS_METHODS.voiceStop,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:voice:events",
      tag: WS_METHODS.voiceSubscribe,
      // Stream atoms publish only the last value per chunk; every realtime frame matters.
      transform: (stream) => stream.pipe(Stream.rechunk(1)),
    }),
  };
}
