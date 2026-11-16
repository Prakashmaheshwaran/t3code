import { describe, expect, it } from "vite-plus/test";
import type { ProjectGoal } from "@t3tools/contracts";

import { decideGoalTransition } from "./GoalDecision.ts";
import { composeProjectGoalPrompt, projectGoalThreadTitle } from "./GoalPrompt.ts";
import { parseProjectGoalReport } from "./GoalReport.ts";

const goal = (overrides: Partial<ProjectGoal> = {}): ProjectGoal => ({
  id: "goal:project-1" as ProjectGoal["id"],
  projectId: "project-1" as ProjectGoal["projectId"],
  objective: "Ship billing",
  successCriteria: ["Tests pass"],
  status: "active",
  phase: "planning",
  plan: null,
  lastSummary: null,
  lastError: null,
  modelSelection: { instanceId: "codex" as never, model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  maxSessions: 5,
  maxFailureStreak: 3,
  sessionCount: 1,
  failureStreak: 0,
  currentSessionId: null,
  currentThreadId: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastSessionAt: "2026-01-01T00:00:00.000Z",
  nextActionAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("parseProjectGoalReport", () => {
  it("reads the last valid report block", () => {
    const text = [
      "Working.",
      "```t3-orchestrator",
      JSON.stringify({ status: "continue", summary: "First" }),
      "```",
      "Then.",
      "```t3-orchestrator",
      JSON.stringify({ status: "achieved", summary: "Done", evidence: ["npm test"] }),
      "```",
    ].join("\n");

    expect(parseProjectGoalReport(text)).toEqual({
      status: "achieved",
      summary: "Done",
      evidence: ["npm test"],
    });
  });

  it("ignores a malformed block and keeps scanning backwards", () => {
    const text = [
      "```t3-orchestrator",
      JSON.stringify({ status: "continue", summary: "Good" }),
      "```",
      "```t3-orchestrator",
      "{not json",
      "```",
    ].join("\n");

    expect(parseProjectGoalReport(text)?.summary).toBe("Good");
  });

  it("returns null without a report", () => {
    expect(parseProjectGoalReport("All done, promise.")).toBeNull();
  });
});

describe("decideGoalTransition", () => {
  it("moves a planned goal into execution and keeps the plan", () => {
    const transition = decideGoalTransition(goal(), 1, {
      runStatus: "completed",
      report: { status: "continue", summary: "Plan ready", plan: "1. Do it" },
      error: null,
    });

    expect(transition).toMatchObject({
      status: "active",
      phase: "executing",
      plan: "1. Do it",
      nextSession: true,
      failureStreak: 0,
    });
  });

  it("verifies a claimed success instead of finishing immediately", () => {
    const transition = decideGoalTransition(goal({ phase: "executing" }), 2, {
      runStatus: "completed",
      report: { status: "achieved", summary: "Built" },
      error: null,
    });

    expect(transition).toMatchObject({ status: "active", phase: "verifying", nextSession: true });
  });

  it("finishes when the verifier confirms the goal", () => {
    const transition = decideGoalTransition(goal({ phase: "verifying" }), 3, {
      runStatus: "completed",
      report: { status: "achieved", summary: "Verified" },
      error: null,
    });

    expect(transition).toMatchObject({ status: "achieved", nextSession: false });
  });

  it("sends verification gaps back to execution", () => {
    const transition = decideGoalTransition(goal({ phase: "verifying" }), 3, {
      runStatus: "completed",
      report: { status: "continue", summary: "Missing coverage", nextStep: "Add tests" },
      error: null,
    });

    expect(transition).toMatchObject({
      status: "active",
      phase: "executing",
      nextSession: true,
      lastSummary: "Missing coverage",
    });
  });

  it("blocks when a session reports a human is needed", () => {
    const transition = decideGoalTransition(goal(), 1, {
      runStatus: "completed",
      report: { status: "blocked", summary: "Needs a key", blockers: ["Missing API key"] },
      error: null,
    });

    expect(transition).toMatchObject({
      status: "blocked",
      lastError: "Missing API key",
      nextSession: false,
    });
  });

  it("counts a missing report as a failed attempt", () => {
    const first = decideGoalTransition(goal(), 1, {
      runStatus: "completed",
      report: null,
      error: null,
    });
    expect(first).toMatchObject({ status: "active", failureStreak: 1, nextSession: true });

    const last = decideGoalTransition(goal({ failureStreak: 2 }), 1, {
      runStatus: "failed",
      report: null,
      error: "Provider crashed",
    });
    expect(last).toMatchObject({
      status: "blocked",
      failureStreak: 3,
      lastError: "Provider crashed Stopped after 3 attempts in a row.",
    });
  });

  it("stops when the session budget is spent", () => {
    const transition = decideGoalTransition(goal({ sessionCount: 5 }), 5, {
      runStatus: "completed",
      report: { status: "continue", summary: "Still working" },
      error: null,
    });

    expect(transition).toMatchObject({ status: "blocked", nextSession: false });
  });

  it("does not start another session for a paused goal", () => {
    const transition = decideGoalTransition(goal({ status: "paused" }), 1, {
      runStatus: "completed",
      report: { status: "continue", summary: "Still working" },
      error: null,
    });

    expect(transition).toMatchObject({ status: "paused", nextSession: false });
  });
});

describe("composeProjectGoalPrompt", () => {
  it("carries the goal, plan, criteria, history, and report protocol", () => {
    const prompt = composeProjectGoalPrompt({
      goal: {
        objective: "Ship billing",
        successCriteria: ["Tests pass", "Old API works"],
        plan: "1. Migrate",
        maxSessions: 5,
        sessionCount: 2,
      },
      projectLabel: "Acme",
      phase: "executing",
      sessionNumber: 2,
      history: [{ phase: "planning", status: "completed", summary: "Planned", report: null }],
    });

    expect(prompt).toContain("Ship billing");
    expect(prompt).toContain("Old API works");
    expect(prompt).toContain("1. Migrate");
    expect(prompt).toContain("Planned");
    expect(prompt).toContain("```t3-orchestrator");
    expect(prompt).toContain("session 2 of at most 5");
  });

  it("makes a sidebar title out of a long objective", () => {
    expect(projectGoalThreadTitle("Fix\nsecond line")).toBe("Goal: Fix");
    expect(projectGoalThreadTitle("Fix", 1)).toBe("Goal: Fix");
    expect(projectGoalThreadTitle("Fix", 3)).toBe("Goal: Fix (3)");
    expect(projectGoalThreadTitle("x".repeat(100)).length).toBeLessThanOrEqual(70);
    expect(projectGoalThreadTitle("x".repeat(100), 12).length).toBeLessThanOrEqual(70);
  });
});
