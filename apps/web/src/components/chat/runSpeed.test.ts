import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveRunSpeeds, formatTokensPerSecond, formatTtft } from "./runSpeed";

const at = (ms: number) => DateTime.makeUnsafe(ms);

function fixture(input: { outputTokens?: number; itemStart?: number; status?: string }) {
  return {
    runs: [
      {
        id: "run-1",
        activeAttemptId: "attempt-1",
        status: input.status ?? "completed",
        startedAt: at(0),
        completedAt: at(6000),
      },
    ],
    providerTurns: [
      {
        id: "turn-1",
        runAttemptId: "attempt-1",
        ordinal: 1,
        startedAt: at(100),
        completedAt: at(5100),
        ...(input.outputTokens === undefined
          ? {}
          : {
              turnTokenUsage: {
                usageScope: "main_agent",
                usageStatus: "complete",
                hasSubagents: false,
                inputTokens: 10,
                outputTokens: input.outputTokens,
              },
            }),
      },
    ],
    turnItems: [
      { type: "user_message", providerTurnId: "turn-1", startedAt: at(50) },
      {
        type: "assistant_message",
        providerTurnId: "turn-1",
        startedAt: at(input.itemStart ?? 1100),
      },
      { type: "reasoning", providerTurnId: "turn-1", startedAt: at(2000) },
    ],
  } as unknown as Parameters<typeof deriveRunSpeeds>[0];
}

describe("deriveRunSpeeds", () => {
  it("measures from the provider turn start to the first model output", () => {
    const speed = deriveRunSpeeds(fixture({ outputTokens: 400 })).get("run-1" as never);
    expect(speed?.ttftMs).toBe(1000);
    expect(speed?.tokensPerSecond).toBe(100);
  });

  it("leaves the rate out without a token count", () => {
    const speed = deriveRunSpeeds(fixture({})).get("run-1" as never);
    expect(speed?.ttftMs).toBe(1000);
    expect(speed?.tokensPerSecond).toBeNull();
  });

  it("skips runs that are not finished", () => {
    expect(deriveRunSpeeds(fixture({ status: "running" })).size).toBe(0);
  });
});

describe("formatting", () => {
  it("reads naturally", () => {
    expect(formatTtft(640)).toBe("640ms");
    expect(formatTtft(2340)).toBe("2.3s");
    expect(formatTtft(42_000)).toBe("42s");
    expect(formatTokensPerSecond(7.25)).toBe("7.3 tok/s");
    expect(formatTokensPerSecond(87.6)).toBe("88 tok/s");
  });
});
