// @effect-diagnostics nodeBuiltinImport:off globalDate:off - small synchronous files beside the server's state, read and written by the voice calls.

// Finished voice calls, one JSON file each in `<state>/voice-calls/`: the call's notes and
// everything said. The newest calls' notes are what the next call starts with.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Line } from "./memory.ts";

export type VoiceProviderName = "chatgpt" | "grok";

export interface SavedCall {
  readonly id: string;
  readonly provider: VoiceProviderName;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly notes: string;
  readonly lines: ReadonlyArray<Line>;
}

export interface SavedCallSummary {
  readonly id: string;
  readonly provider: VoiceProviderName;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly notes: string;
  readonly lineCount: number;
}

const CALLS_KEPT = 200;
const RECENT_CALLS_USED = 3;
const RECENT_CALLS_FRESH_MS = 24 * 60 * 60_000;
const EARLIER_MAX_CHARS = 3_000;
const DAY_MS = 24 * 60 * 60_000;

export const voiceCallsDir = (stateDir: string) => NodePath.join(stateDir, "voice-calls");

// Ids are UUIDs; anything else could step outside the directory.
const validId = (id: string) => /^[A-Za-z0-9-]{8,64}$/.test(id);
const fileName = (call: Pick<SavedCall, "id" | "startedAt">) =>
  `${new Date(call.startedAt).toISOString().replace(/[:.]/g, "-")}-${call.id}.json`;

/** Saved calls' file names, oldest first: names start with the time. */
const callFiles = (dir: string) => {
  try {
    return NodeFS.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .toSorted();
  } catch {
    return [];
  }
};

function parse(dir: string, name: string): SavedCall | undefined {
  try {
    const value = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8")) as SavedCall;
    return typeof value?.id === "string" &&
      typeof value.startedAt === "number" &&
      typeof value.endedAt === "number" &&
      Array.isArray(value.lines)
      ? { ...value, notes: typeof value.notes === "string" ? value.notes : "" }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves a finished call, then drops calls beyond the newest 200 and, when `keepDays` is set,
 * calls older than that. `keepDays` 0 means calls aren't saved, so this one isn't either.
 */
export function saveCall(dir: string, call: SavedCall, keepDays?: number | null) {
  if (keepDays === 0 || call.lines.length === 0 || !validId(call.id)) return;
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, fileName(call)), JSON.stringify(call));
  pruneCalls(dir, keepDays, call.endedAt);
}

function pruneCalls(dir: string, keepDays: number | null | undefined, now: number) {
  const files = callFiles(dir);
  const stale = new Set(files.slice(0, -CALLS_KEPT));
  if (keepDays && keepDays > 0)
    for (const name of files) {
      const call = parse(dir, name);
      if (call && now - call.endedAt > keepDays * DAY_MS) stale.add(name);
    }
  for (const name of stale) NodeFS.rmSync(NodePath.join(dir, name), { force: true });
}

/** Saved calls, newest first, without their transcripts. */
export function listCalls(dir: string): SavedCallSummary[] {
  return callFiles(dir)
    .toReversed()
    .flatMap((name) => {
      const call = parse(dir, name);
      return call
        ? [
            {
              id: call.id,
              provider: call.provider === "grok" ? "grok" : "chatgpt",
              startedAt: call.startedAt,
              endedAt: call.endedAt,
              notes: call.notes,
              lineCount: call.lines.length,
            } satisfies SavedCallSummary,
          ]
        : [];
    });
}

export function readCall(dir: string, id: string): SavedCall | undefined {
  if (!validId(id)) return undefined;
  const name = callFiles(dir).find((file) => file.endsWith(`-${id}.json`));
  return name ? parse(dir, name) : undefined;
}

export function deleteCall(dir: string, id: string) {
  if (!validId(id)) return;
  for (const name of callFiles(dir))
    if (name.endsWith(`-${id}.json`)) NodeFS.rmSync(NodePath.join(dir, name), { force: true });
}

export function clearCalls(dir: string) {
  for (const name of callFiles(dir)) NodeFS.rmSync(NodePath.join(dir, name), { force: true });
}

/** The notes of the newest calls that ended within the last day, oldest of them first. */
export function recentCallNotes(
  calls: ReadonlyArray<Pick<SavedCall, "endedAt" | "notes">>,
  now: number,
) {
  return calls
    .filter((call) => now - call.endedAt < RECENT_CALLS_FRESH_MS && call.notes.trim())
    .slice(-RECENT_CALLS_USED)
    .map((call) => `Call that ended ${new Date(call.endedAt).toLocaleString()}:\n${call.notes}`)
    .join("\n\n")
    .slice(-EARLIER_MAX_CHARS);
}

/** What a new call starts knowing about the user's recent calls. */
export function recentNotes(dir: string, now: number) {
  const recent = callFiles(dir)
    .slice(-RECENT_CALLS_USED)
    .flatMap((name) => parse(dir, name) ?? []);
  return recentCallNotes(recent, now);
}
