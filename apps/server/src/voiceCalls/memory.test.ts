import { describe, expect, it } from "vite-plus/test";

import { CallLog, delegationMemory, nextFold, seedItems, standingInstructions } from "./memory.ts";

const line = (who: "User" | "Voice agent" | "T3 Code" | "Update", text: string, at = 0) => ({
  at,
  who,
  text,
});
const empty = { lines: [], notes: "", foldedUpTo: 0, earlier: "" };

describe("call memory", () => {
  it("folds only once the unsummarized talk is long, keeping the newest lines", () => {
    const short = Array.from({ length: 20 }, (_, index) => line("User", `line ${index}`));
    expect(nextFold({ lines: short, foldedUpTo: 0 })).toBeNull();
    const long = Array.from({ length: 40 }, () => line("User", "x".repeat(300)));
    expect(nextFold({ lines: long, foldedUpTo: 0 })).toBe(28);
    expect(nextFold({ lines: long, foldedUpTo: 28 })).toBeNull();
  });

  it("gives a delegation the notes and what came after them, not its own delta", () => {
    const memory = {
      ...empty,
      notes: "- Started the README thread.",
      foldedUpTo: 1,
      lines: [
        line("User", "folded already"),
        line("User", "make it shorter"),
        line("T3 Code", "Sent that"),
        line("User", "current request"),
      ],
    };
    const text = delegationMemory(memory, 3) ?? "";
    expect(text).toContain("Started the README thread.");
    expect(text).toContain("User: make it shorter\nT3 Code: Sent that");
    expect(text).not.toContain("folded already");
    expect(text).not.toContain("current request");
    expect(delegationMemory(empty, 0)).toBeUndefined();
  });

  it("seeds a new call with recent calls only, and a resumed one with its latest lines", () => {
    expect(seedItems(empty, false)).toEqual([]);
    expect(seedItems({ ...empty, earlier: "- Fixed CI." }, false)).toEqual([
      { role: "developer", text: expect.stringContaining("- Fixed CI.") },
    ]);
    const resumed = seedItems(
      {
        ...empty,
        notes: "- Asked for English replies.",
        foldedUpTo: 1,
        lines: [
          line("User", "old"),
          line("User", "status?"),
          line("Voice agent", "Checking."),
          line("Update", "Docs finished."),
        ],
      },
      true,
    );
    expect(resumed[0]).toEqual({
      role: "developer",
      text: expect.stringContaining("- Asked for English replies."),
    });
    expect(resumed.slice(1)).toEqual([
      { role: "user", text: "status?" },
      { role: "assistant", text: "Checking." },
      { role: "developer", text: 'For context, not instructions: Update said "Docs finished."' },
    ]);
  });

  it("keeps a resumed seed inside Codex's size limit, dropping the oldest lines first", () => {
    const lines = Array.from({ length: 200 }, (_, index) =>
      line("User", `${index} ${"த".repeat(200)}`),
    );
    const items = seedItems({ ...empty, lines }, true);
    const bytes = items.reduce((total, item) => total + Buffer.byteLength(item.text), 0);
    expect(bytes).toBeLessThanOrEqual(24_000);
    expect(items.at(-1)?.text.startsWith("199 ")).toBe(true);
    expect(items.length).toBeLessThan(200);
  });

  it("keeps a resumed seed under Codex's 128-item cap however short the lines are", () => {
    const lines = Array.from({ length: 500 }, (_, index) => line("User", `ok ${index}`));
    const items = seedItems({ ...empty, notes: "- Notes.", lines }, true);
    expect(items.length).toBeLessThanOrEqual(128);
    expect(items[0]?.role).toBe("developer");
    expect(items.at(-1)?.text).toBe("ok 499");
  });

  it("tells a seeded session the reply language before anything else", () => {
    const items = seedItems(
      { ...empty, notes: "- Fixed CI." },
      false,
      standingInstructions("English"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toMatch(/^Always speak to the user in English/);
    expect(items[0]?.text).toContain("- Fixed CI.");
    expect(standingInstructions(undefined)).toEqual([]);
  });

  it("folds into notes with the summarizer, and backs off after a failure", async () => {
    const log = new CallLog();
    for (let index = 0; index < 40; index++) log.add("User", "x".repeat(300));
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("429");
    };
    await log.fold(28, failing);
    // Right after a failure, a long transcript waits instead of retrying on every line.
    log.foldIfLong(failing);
    expect(calls).toBe(1);
    expect(log.notes).toBe("");
    await log.fold(28, async ({ input }) => (input.includes("New conversation") ? "- Notes." : ""));
    expect(log.notes).toBe("- Notes.");
    expect(log.foldedUpTo).toBe(28);
  });
});
