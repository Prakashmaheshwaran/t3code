// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the store writes plain files, so its tests read them.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearCalls,
  deleteCall,
  listCalls,
  readCall,
  recentCallNotes,
  recentNotes,
  saveCall,
  type SavedCall,
} from "./store.ts";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-calls-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const call = (id: string, endedAt: number, notes = `- ${id}`): SavedCall => ({
  id: `${id}-0000-0000`,
  provider: "chatgpt",
  startedAt: endedAt - 60_000,
  endedAt,
  notes,
  lines: [{ at: endedAt - 30_000, who: "User", text: `hello from ${id}` }],
});

describe("voice call store", () => {
  it("saves, lists newest first, reads, and deletes calls", () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 10, 10, 12);
    saveCall(dir, call("aaaa", now - 2 * 60_000));
    saveCall(dir, call("bbbb", now - 60_000));
    expect(listCalls(dir).map((saved) => saved.id)).toEqual(["bbbb-0000-0000", "aaaa-0000-0000"]);
    expect(listCalls(dir)[0]).toMatchObject({ lineCount: 1, notes: "- bbbb" });
    expect(readCall(dir, "aaaa-0000-0000")?.lines[0]?.text).toBe("hello from aaaa");
    deleteCall(dir, "aaaa-0000-0000");
    expect(listCalls(dir)).toHaveLength(1);
    clearCalls(dir);
    expect(listCalls(dir)).toEqual([]);
  });

  it("refuses ids that could leave the directory", () => {
    const dir = tempDir();
    expect(readCall(dir, "../../etc/passwd")).toBeUndefined();
    saveCall(dir, { ...call("cccc", 1), id: "../escape" });
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("keeps calls for the chosen number of days, and saves nothing at 0", () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 10, 10, 12);
    saveCall(dir, call("old1", now - 10 * DAY));
    saveCall(dir, call("new1", now), 7);
    expect(listCalls(dir).map((saved) => saved.id)).toEqual(["new1-0000-0000"]);
    saveCall(dir, call("skip", now), 0);
    expect(listCalls(dir)).toHaveLength(1);
  });

  it("starts the next call with the notes of the last day's newest calls", () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 10, 10, 12);
    saveCall(dir, call("stal", now - 2 * DAY, "stale"));
    saveCall(dir, call("frsh", now - 60_000, "- Launched the auth thread."));
    const text = recentNotes(dir, now);
    expect(text).toContain("Launched the auth thread.");
    expect(text).not.toContain("stale");
    expect(recentCallNotes([], now)).toBe("");
  });
});
