// Time to first token and output speed for finished runs, from what the thread projection
// already records: the provider turn's start and end, its items' start times, and the main
// agent's output token count.

import {
  latestProviderTurnForAttempt,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";

export interface RunSpeed {
  /** From the provider receiving the request to its first output item. */
  readonly ttftMs: number;
  readonly outputTokens: number | null;
  /** Output tokens over the time from the first output to the turn's end, tool time included. */
  readonly tokensPerSecond: number | null;
}

/** Items the model produced; the rest are the user's or T3 Code's own. */
const MODEL_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

// Shorter windows make the rate mostly rounding noise.
const MIN_RATE_WINDOW_MS = 500;

const millis = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.toEpochMillis(value) : null;

export function deriveRunSpeeds(input: {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "activeAttemptId" | "status" | "startedAt" | "completedAt">
  >;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly turnItems: ReadonlyArray<
    Pick<ThreadStructure["turnItems"][number], "type" | "providerTurnId" | "startedAt">
  >;
}): ReadonlyMap<RunId, RunSpeed> {
  const firstOutputByTurn = new Map<string, number>();
  for (const item of input.turnItems) {
    if (item.providerTurnId === null || !MODEL_OUTPUT_TYPES.has(item.type)) continue;
    const at = millis(item.startedAt);
    if (at === null) continue;
    const seen = firstOutputByTurn.get(item.providerTurnId);
    if (seen === undefined || at < seen) firstOutputByTurn.set(item.providerTurnId, at);
  }

  const speeds = new Map<RunId, RunSpeed>();
  for (const run of input.runs) {
    if (run.status !== "completed" || run.activeAttemptId === null) continue;
    const turn = latestProviderTurnForAttempt(input.providerTurns, run.activeAttemptId);
    if (!turn) continue;
    const firstOutput = firstOutputByTurn.get(turn.id);
    const requested = millis(turn.startedAt) ?? millis(run.startedAt);
    if (firstOutput === undefined || requested === null || firstOutput < requested) continue;
    const ended = millis(turn.completedAt) ?? millis(run.completedAt);
    const outputTokens = turn.turnTokenUsage?.outputTokens ?? null;
    const window = ended === null ? 0 : ended - firstOutput;
    speeds.set(run.id, {
      ttftMs: firstOutput - requested,
      outputTokens,
      tokensPerSecond:
        outputTokens && window >= MIN_RATE_WINDOW_MS ? outputTokens / (window / 1000) : null,
    });
  }
  return speeds;
}

export function formatTtft(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatTokensPerSecond(rate: number) {
  return `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} tok/s`;
}
