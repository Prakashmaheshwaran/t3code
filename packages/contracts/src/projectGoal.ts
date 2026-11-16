import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectGoalId,
  ProjectGoalSessionId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * A project goal is the durable mission the server's orchestrator keeps working on. Each
 * autonomous session ends with a report, and the orchestrator decides what the next session does.
 */
export const ProjectGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "achieved",
  "cancelled",
]);
export type ProjectGoalStatus = typeof ProjectGoalStatus.Type;

/** A session that only plans, sessions that execute, and a final independent verification. */
export const ProjectGoalPhase = Schema.Literals(["planning", "executing", "verifying"]);
export type ProjectGoalPhase = typeof ProjectGoalPhase.Type;

export const ProjectGoalSessionStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type ProjectGoalSessionStatus = typeof ProjectGoalSessionStatus.Type;

/** The minimum gap between an active goal's sessions, so a fast session cannot spin. */
export const PROJECT_GOAL_MIN_SESSION_GAP_MS = 30_000;
/** A session that runs longer than this is ended and treated as a failure. */
export const PROJECT_GOAL_SESSION_TIMEOUT_MS = 3 * 60 * 60 * 1_000;
export const PROJECT_GOAL_DEFAULT_MAX_SESSIONS = 12;
export const PROJECT_GOAL_MAX_SESSIONS = 100;
export const PROJECT_GOAL_DEFAULT_MAX_FAILURE_STREAK = 3;

/** The report an orchestrator session ends with, in a `t3-orchestrator` fenced block. */
export const ProjectGoalReport = Schema.Struct({
  status: Schema.Literals(["continue", "achieved", "blocked"]),
  summary: Schema.String,
  plan: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
  blockers: Schema.optional(Schema.Array(Schema.String)),
  evidence: Schema.optional(Schema.Array(Schema.String)),
});
export type ProjectGoalReport = typeof ProjectGoalReport.Type;

const SuccessCriteria = Schema.Array(Schema.String).check(Schema.isMaxLength(50));
const ProjectGoalMaxSessions = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: PROJECT_GOAL_MAX_SESSIONS }),
);
const ProjectGoalMaxFailureStreak = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }));

export const ProjectGoal = Schema.Struct({
  id: ProjectGoalId,
  projectId: ProjectId,
  objective: TrimmedNonEmptyString,
  successCriteria: SuccessCriteria,
  status: ProjectGoalStatus,
  phase: ProjectGoalPhase,
  /** The working plan carried between sessions; every session may replace it. */
  plan: Schema.NullOr(Schema.String),
  lastSummary: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  maxSessions: ProjectGoalMaxSessions,
  maxFailureStreak: ProjectGoalMaxFailureStreak,
  sessionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failureStreak: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  currentSessionId: Schema.NullOr(ProjectGoalSessionId),
  currentThreadId: Schema.NullOr(ThreadId),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  lastSessionAt: Schema.NullOr(IsoDateTime),
  /** When the orchestrator may start the next session, or null while it waits on a person. */
  nextActionAt: Schema.NullOr(IsoDateTime),
});
export type ProjectGoal = typeof ProjectGoal.Type;

export const ProjectGoalSession = Schema.Struct({
  id: ProjectGoalSessionId,
  goalId: ProjectGoalId,
  projectId: ProjectId,
  phase: ProjectGoalPhase,
  status: ProjectGoalSessionStatus,
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  report: Schema.NullOr(ProjectGoalReport),
  summary: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectGoalSession = typeof ProjectGoalSession.Type;

/** One goal per project, with an id derived from it so retries cannot create a second. */
export function projectGoalIdForProject(projectId: ProjectId): ProjectGoalId {
  return ProjectGoalId.make(`goal:${projectId}`);
}

export const ProjectGoalListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type ProjectGoalListInput = typeof ProjectGoalListInput.Type;

export const ProjectGoalListResult = Schema.Struct({
  goals: Schema.Array(ProjectGoal),
});
export type ProjectGoalListResult = typeof ProjectGoalListResult.Type;

export const ProjectGoalUpsertInput = Schema.Struct({
  projectId: ProjectId,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  successCriteria: Schema.optional(SuccessCriteria),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  maxSessions: Schema.optional(ProjectGoalMaxSessions),
  maxFailureStreak: Schema.optional(ProjectGoalMaxFailureStreak),
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ProjectGoalUpsertInput = typeof ProjectGoalUpsertInput.Type;

export const ProjectGoalSetStatusInput = Schema.Struct({
  goalId: ProjectGoalId,
  status: ProjectGoalStatus,
});
export type ProjectGoalSetStatusInput = typeof ProjectGoalSetStatusInput.Type;

export const ProjectGoalDeleteInput = Schema.Struct({
  goalId: ProjectGoalId,
});
export type ProjectGoalDeleteInput = typeof ProjectGoalDeleteInput.Type;

export const ProjectGoalDeleteResult = Schema.Struct({
  goalId: ProjectGoalId,
});
export type ProjectGoalDeleteResult = typeof ProjectGoalDeleteResult.Type;

export const ProjectGoalRunNowInput = Schema.Struct({
  goalId: ProjectGoalId,
});
export type ProjectGoalRunNowInput = typeof ProjectGoalRunNowInput.Type;

export const ProjectGoalMutationResult = Schema.Struct({
  goal: ProjectGoal,
});
export type ProjectGoalMutationResult = typeof ProjectGoalMutationResult.Type;

export const ProjectGoalRunNowResult = ProjectGoalMutationResult;
export type ProjectGoalRunNowResult = typeof ProjectGoalRunNowResult.Type;

export const ProjectGoalListSessionsInput = Schema.Struct({
  goalId: ProjectGoalId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type ProjectGoalListSessionsInput = typeof ProjectGoalListSessionsInput.Type;

export const ProjectGoalListSessionsResult = Schema.Struct({
  sessions: Schema.Array(ProjectGoalSession),
});
export type ProjectGoalListSessionsResult = typeof ProjectGoalListSessionsResult.Type;

export class ProjectGoalError extends Schema.TaggedError<ProjectGoalError>()("ProjectGoalError", {
  message: Schema.String,
  goalId: Schema.optional(ProjectGoalId),
  cause: Schema.optional(Schema.Defect()),
}) {}
