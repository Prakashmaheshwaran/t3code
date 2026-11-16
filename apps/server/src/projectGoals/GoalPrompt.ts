import type { ProjectGoal, ProjectGoalPhase, ProjectGoalSession } from "@t3tools/contracts";

import { PROJECT_GOAL_REPORT_FENCE } from "./GoalReport.ts";

const MAX_HISTORY = 5;
const MAX_TEXT = 2_000;
const MAX_PROMPT_CHARS = 24_000;

export interface GoalSessionBrief {
  readonly goal: Pick<
    ProjectGoal,
    "objective" | "successCriteria" | "plan" | "maxSessions" | "sessionCount"
  >;
  readonly projectLabel: string;
  readonly phase: ProjectGoalPhase;
  readonly sessionNumber: number;
  readonly history: ReadonlyArray<
    Pick<ProjectGoalSession, "phase" | "status" | "summary" | "report">
  >;
}

function clip(value: string, max = MAX_TEXT): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function reportProtocol(phase: ProjectGoalPhase): string {
  const meaning =
    phase === "verifying"
      ? 'In this verification session "achieved" means you independently confirmed every success criterion; "continue" lists the gaps that remain.'
      : '"achieved" means the goal is fully met and the next session will independently verify it.';
  return [
    "## Required final report",
    "End your turn with exactly one fenced block, after all work and prose. The orchestrator reads it to decide what happens next.",
    `\`\`\`${PROJECT_GOAL_REPORT_FENCE}`,
    '{"status":"continue","summary":"What changed and what remains, in 1-3 sentences.","plan":"Optional updated plan.","nextStep":"The single most useful next step.","blockers":[],"evidence":["Tests or checks you ran."]}',
    "```",
    `\`status\` is "continue", "achieved", or "blocked". Use "blocked" only when a human must intervene (missing credentials, a decision only the user can make, or repeated failure). ${meaning}`,
    "Never leave the block out. A session without it is treated as a failed attempt.",
  ].join("\n");
}

function phaseInstructions(phase: ProjectGoalPhase): string {
  switch (phase) {
    case "planning":
      return [
        "## This session: planning",
        "Inspect the project enough to commit to a concrete plan. Write the plan into `plan` in your report.",
        "Do not stop at a plan when the first step is small and safe: begin implementing it in this same session.",
        "If the project already contains the work, verify it and report `achieved`.",
      ].join("\n");
    case "executing":
      return [
        "## This session: execution",
        "Carry the goal forward. Follow the existing plan, adapt it when evidence says otherwise, and make real changes.",
        "Run the relevant checks or tests before you stop. Leave the workspace in a working state.",
        "When the success criteria are all met, report `achieved`; the next session will verify your work independently.",
      ].join("\n");
    case "verifying":
      return [
        "## This session: independent verification",
        "You are a fresh verifier. Do not trust the previous sessions' claims; inspect the actual workspace.",
        "Check every success criterion directly. Run the tests or checks that prove them.",
        "Change code only for a trivial, obviously correct fix. Otherwise report `continue` with the gaps in `nextStep` and `blockers`.",
        "Report `achieved` only when every criterion is demonstrably met.",
      ].join("\n");
  }
}

function historySection(brief: GoalSessionBrief): string {
  const recent = brief.history.slice(-MAX_HISTORY);
  if (recent.length === 0) return "## Prior sessions\nThis is the first session for this goal.";
  const lines = recent.map((session, index) => {
    const summary = session.summary ?? session.report?.summary ?? "No summary.";
    const next = session.report?.nextStep;
    return [
      `${index + 1}. ${session.phase} · ${session.status}: ${clip(summary, 600)}`,
      next === undefined || next.trim() === "" ? null : `   Next then: ${clip(next, 400)}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  });
  return `## Prior sessions\n${lines.join("\n")}`;
}

function criteriaSection(brief: GoalSessionBrief): string {
  if (brief.goal.successCriteria.length === 0) {
    return "## Success criteria\nNone were listed. Use the objective itself, and be conservative before claiming the goal is achieved.";
  }
  return [
    "## Success criteria",
    ...brief.goal.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join("\n");
}

/**
 * The mission brief for one orchestrator session. It carries the durable plan and recent
 * outcomes, so every session starts with the project's history even in a fresh context.
 */
export function composeProjectGoalPrompt(brief: GoalSessionBrief): string {
  const plan =
    brief.goal.plan === null || brief.goal.plan.trim() === ""
      ? "No plan yet. This goal has not been planned."
      : clip(brief.goal.plan, 6_000);
  const prompt = [
    "# T3 Code project orchestrator",
    `You are an autonomous session working toward a durable goal for the project "${brief.projectLabel}".`,
    `This is session ${brief.sessionNumber} of at most ${brief.goal.maxSessions}.`,
    "The orchestrator starts a fresh session each time a previous one ends, so this conversation is your whole context. Make it count.",
    "",
    "## Goal",
    brief.goal.objective,
    "",
    criteriaSection(brief),
    "",
    "## Current plan",
    plan,
    "",
    historySection(brief),
    "",
    phaseInstructions(brief.phase),
    "",
    "## Rules",
    "- Work only inside this project's workspace. Do not run destructive commands outside it.",
    "- Do not ask the user questions. Make a reasonable decision and record the assumption in your report.",
    "- Do not open a pull request unless the goal asks for one.",
    "- Keep the final report accurate. Claiming progress you did not make ends the goal on a false success.",
    "",
    reportProtocol(brief.phase),
  ].join("\n");
  return prompt.length <= MAX_PROMPT_CHARS ? prompt : `${prompt.slice(0, MAX_PROMPT_CHARS - 1)}…`;
}

/** A short thread title that stays recognizable in the sidebar and names later sessions. */
export function projectGoalThreadTitle(objective: string, sessionNumber?: number): string {
  const firstLine = objective.trim().split(/\r?\n/u)[0] ?? "Project goal";
  const title = `Goal: ${firstLine.length <= 56 ? firstLine : `${firstLine.slice(0, 55)}…`}`;
  return sessionNumber === undefined || sessionNumber <= 1 ? title : `${title} (${sessionNumber})`;
}
