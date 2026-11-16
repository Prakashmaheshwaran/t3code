import type {
  ProjectGoal,
  ProjectGoalPhase,
  ProjectGoalReport,
  ProjectGoalStatus,
} from "@t3tools/contracts";

/** A terminal provider run for one orchestrator session. */
export interface GoalSessionOutcome {
  readonly runStatus: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back";
  readonly report: ProjectGoalReport | null;
  readonly error: string | null;
}

export interface GoalTransition {
  readonly status: ProjectGoalStatus;
  readonly phase: ProjectGoalPhase;
  readonly plan: string | null;
  readonly lastSummary: string | null;
  readonly lastError: string | null;
  readonly failureStreak: number;
  /** Whether the orchestrator should start another session after the cooldown. */
  readonly nextSession: boolean;
}

function blocked(
  goal: ProjectGoal,
  reason: string,
  changes: Pick<GoalTransition, "plan" | "lastSummary">,
): GoalTransition {
  return {
    status: "blocked",
    phase: goal.phase,
    plan: changes.plan,
    lastSummary: changes.lastSummary,
    lastError: reason,
    failureStreak: goal.failureStreak,
    nextSession: false,
  };
}

function failureReason(outcome: GoalSessionOutcome): string {
  const detail = outcome.error?.trim();
  if (detail !== undefined && detail !== "") return detail;
  switch (outcome.runStatus) {
    case "failed":
      return "The session failed before reporting back.";
    case "interrupted":
      return "The session was interrupted before reporting back.";
    case "cancelled":
      return "The session was cancelled before reporting back.";
    case "rolled_back":
      return "The session was rolled back before reporting back.";
    case "completed":
      return "The session ended without an orchestrator report.";
  }
}

/**
 * Advances a goal after one session ends. This is the heart of the orchestrator: it decides
 * whether to verify, keep working, block, or finish, and applies the session and failure budgets.
 */
export function decideGoalTransition(
  goal: ProjectGoal,
  sessionCount: number,
  outcome: GoalSessionOutcome,
): GoalTransition {
  if (goal.status !== "active") {
    return {
      status: goal.status,
      phase: goal.phase,
      plan: goal.plan,
      lastSummary: goal.lastSummary,
      lastError: goal.lastError,
      failureStreak: goal.failureStreak,
      nextSession: false,
    };
  }

  const report = outcome.report;
  const lastSummary = report?.summary ?? goal.lastSummary;
  const reportedPlan = report?.plan?.trim();
  const plan = reportedPlan === undefined || reportedPlan === "" ? goal.plan : reportedPlan;

  const fail = (reason: string): GoalTransition => {
    const failureStreak = goal.failureStreak + 1;
    return failureStreak >= goal.maxFailureStreak
      ? {
          status: "blocked",
          phase: goal.phase,
          plan,
          lastSummary,
          lastError: `${reason} Stopped after ${failureStreak} attempts in a row.`,
          failureStreak,
          nextSession: false,
        }
      : {
          status: "active",
          phase: goal.phase,
          plan,
          lastSummary,
          lastError: reason,
          failureStreak,
          nextSession: true,
        };
  };

  if (outcome.runStatus !== "completed") return fail(failureReason(outcome));
  if (report === null) return fail(failureReason(outcome));

  if (report.status === "blocked") {
    const blockers = report.blockers?.filter((entry) => entry.trim() !== "") ?? [];
    return blocked(goal, blockers.length === 0 ? report.summary : blockers.join(" · "), {
      plan,
      lastSummary,
    });
  }

  if (report.status === "achieved") {
    if (goal.phase === "verifying") {
      return {
        status: "achieved",
        phase: goal.phase,
        plan,
        lastSummary,
        lastError: null,
        failureStreak: 0,
        nextSession: false,
      };
    }
    return {
      status: "active",
      phase: "verifying",
      plan,
      lastSummary,
      lastError: null,
      failureStreak: 0,
      nextSession: true,
    };
  }

  if (sessionCount >= goal.maxSessions) {
    return blocked(goal, `The goal used all ${goal.maxSessions} sessions without being achieved.`, {
      plan,
      lastSummary,
    });
  }

  const phase: ProjectGoalPhase = "executing";
  return {
    status: "active",
    phase,
    plan,
    lastSummary,
    lastError: null,
    failureStreak: 0,
    nextSession: true,
  };
}
