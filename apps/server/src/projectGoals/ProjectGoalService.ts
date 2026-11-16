import {
  CommandId,
  MessageId,
  PROJECT_GOAL_DEFAULT_MAX_FAILURE_STREAK,
  PROJECT_GOAL_DEFAULT_MAX_SESSIONS,
  PROJECT_GOAL_MIN_SESSION_GAP_MS,
  PROJECT_GOAL_SESSION_TIMEOUT_MS,
  type ProjectGoal,
  ProjectGoal as ProjectGoalSchema,
  ProjectGoalDeleteResult,
  ProjectGoalError,
  type ProjectGoalId,
  type ProjectGoalListResult,
  type ProjectGoalListSessionsInput,
  type ProjectGoalListSessionsResult,
  type ProjectGoalMutationResult,
  type ProjectGoalReport,
  ProjectGoalReport as ProjectGoalReportSchema,
  type ProjectGoalRunNowResult,
  type ProjectGoalSession,
  ProjectGoalSession as ProjectGoalSessionSchema,
  type ProjectGoalSessionId,
  type ProjectGoalSetStatusInput,
  ProjectGoalSessionId as ProjectGoalSessionIdSchema,
  type ProjectGoalUpsertInput,
  type ProjectId,
  type ThreadId,
  projectGoalIdForProject,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { isTerminalRunStatus } from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { decideGoalTransition, type GoalSessionOutcome } from "./GoalDecision.ts";
import { composeProjectGoalPrompt, projectGoalThreadTitle } from "./GoalPrompt.ts";
import { lastAssistantMessage, parseProjectGoalReport } from "./GoalReport.ts";

/** Goals across projects run in parallel, but the machine has finite capacity. */
const MAX_CONCURRENT_GOAL_SESSIONS = 3;
const LAUNCH_GRACE_MS = 2 * 60_000;
const SWEEP_LIMIT = 8;
const MIN_SESSION_GAP_MS = PROJECT_GOAL_MIN_SESSION_GAP_MS;

interface ProjectGoalRow {
  readonly goal_id: string;
  readonly project_id: string;
  readonly objective: string;
  readonly success_criteria_json: string;
  readonly status: string;
  readonly phase: string;
  readonly plan: string | null;
  readonly last_summary: string | null;
  readonly last_error: string | null;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly workspace_strategy_json: string;
  readonly max_sessions: number;
  readonly max_failure_streak: number;
  readonly session_count: number;
  readonly failure_streak: number;
  readonly current_session_id: string | null;
  readonly current_thread_id: string | null;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly last_session_at: string | null;
  readonly next_action_at: string | null;
}

interface ProjectGoalSessionRow {
  readonly session_id: string;
  readonly goal_id: string;
  readonly project_id: string;
  readonly phase: string;
  readonly status: string;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly report_json: string | null;
  readonly summary: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

const isProjectGoalError = Schema.is(ProjectGoalError);
const decodeGoal = Schema.decodeUnknownEffect(ProjectGoalSchema);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSession = Schema.decodeUnknownEffect(ProjectGoalSessionSchema);
const decodeCriteriaJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectGoalSchema.fields.successCriteria),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectGoalSchema.fields.modelSelection),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectGoalSchema.fields.workspaceStrategy),
);
const decodeReportJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectGoalReportSchema));

export class ProjectGoalService extends Context.Service<
  ProjectGoalService,
  {
    readonly list: () => Effect.Effect<ProjectGoalListResult, ProjectGoalError>;
    readonly subscribeList: () => Stream.Stream<ProjectGoalListResult, ProjectGoalError>;
    readonly upsert: (
      input: ProjectGoalUpsertInput,
    ) => Effect.Effect<ProjectGoalMutationResult, ProjectGoalError>;
    readonly setStatus: (
      input: ProjectGoalSetStatusInput,
    ) => Effect.Effect<ProjectGoalMutationResult, ProjectGoalError>;
    readonly delete: (input: {
      readonly goalId: ProjectGoalId;
    }) => Effect.Effect<ProjectGoalDeleteResult, ProjectGoalError>;
    readonly runNow: (input: {
      readonly goalId: ProjectGoalId;
    }) => Effect.Effect<ProjectGoalRunNowResult, ProjectGoalError>;
    readonly listSessions: (
      input: ProjectGoalListSessionsInput,
    ) => Effect.Effect<ProjectGoalListSessionsResult, ProjectGoalError>;
    /** Starts the event reactor and the scheduler sweep. Idempotent per layer build. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Queues a final review when one of this service's session threads ends its run. */
    readonly handleThreadRunEnded: (threadId: ThreadId) => Effect.Effect<void>;
    /** Waits until queued session finalizations have finished. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/projectGoals/ProjectGoalService") {}

function goalError(
  message: string,
  input?: { readonly goalId?: ProjectGoalId; readonly cause?: unknown },
) {
  return new ProjectGoalError({
    message,
    ...(input?.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

const iso = (value: DateTime.DateTime): string => DateTime.formatIso(DateTime.toUtc(value));

function errorMessage(error: unknown): string {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  return failure instanceof Error ? failure.message : String(failure);
}

function addMilliseconds(value: string, milliseconds: number): string {
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(value), { milliseconds }));
}

function sessionStatusForTerminal(
  status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back",
): ProjectGoalSession["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
  }
}

const decodeGoalRow: (row: ProjectGoalRow) => Effect.Effect<ProjectGoal, ProjectGoalError> =
  Effect.fn("ProjectGoalService.decodeGoalRow")(function* (row: ProjectGoalRow) {
    const fieldError = (cause: unknown) =>
      goalError("Could not decode a project goal row.", {
        goalId: row.goal_id as ProjectGoalId,
        cause,
      });
    const successCriteria = yield* decodeCriteriaJson(row.success_criteria_json).pipe(
      Effect.mapError(fieldError),
    );
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json).pipe(
      Effect.mapError(fieldError),
    );
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json).pipe(
      Effect.mapError(fieldError),
    );
    return yield* decodeGoal({
      id: row.goal_id,
      projectId: row.project_id,
      objective: row.objective,
      successCriteria,
      status: row.status,
      phase: row.phase,
      plan: row.plan,
      lastSummary: row.last_summary,
      lastError: row.last_error,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      workspaceStrategy,
      maxSessions: row.max_sessions,
      maxFailureStreak: row.max_failure_streak,
      sessionCount: row.session_count,
      failureStreak: row.failure_streak,
      currentSessionId: row.current_session_id,
      currentThreadId: row.current_thread_id,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      lastSessionAt: row.last_session_at,
      nextActionAt: row.next_action_at,
    }).pipe(
      Effect.mapError((cause) =>
        goalError("Could not decode a project goal row.", {
          goalId: row.goal_id as ProjectGoalId,
          cause,
        }),
      ),
    );
  });

const decodeSessionRow = Effect.fn("ProjectGoalService.decodeSessionRow")(function* (
  row: ProjectGoalSessionRow,
) {
  const report =
    row.report_json === null
      ? null
      : yield* decodeReportJson(row.report_json).pipe(
          Effect.mapError((cause) =>
            goalError("Could not decode a project goal session report.", {
              goalId: row.goal_id as ProjectGoalId,
              cause,
            }),
          ),
        );
  return yield* decodeSession({
    id: row.session_id,
    goalId: row.goal_id,
    projectId: row.project_id,
    phase: row.phase,
    status: row.status,
    threadId: row.thread_id,
    runId: row.run_id,
    report,
    summary: row.summary,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }).pipe(
    Effect.mapError((cause) =>
      goalError("Could not decode a project goal session.", {
        goalId: row.goal_id as ProjectGoalId,
        cause,
      }),
    ),
  );
});

export const layer = Layer.effect(
  ProjectGoalService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* Orchestrator.OrchestratorV2;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const scheduler = yield* Scheduler.Scheduler;

    const startPermit = yield* Semaphore.make(1);
    const finalizing = yield* Ref.make<ReadonlySet<string>>(new Set());
    const changesPubSub = yield* PubSub.sliding<void>(1);
    let started = false;

    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const listRows = () =>
      sql<ProjectGoalRow>`
        SELECT * FROM project_goals ORDER BY created_at DESC, goal_id ASC
      `.pipe(NodeSqliteClient.readOnly);

    const loadGoalRow = (goalId: ProjectGoalId) =>
      sql<ProjectGoalRow>`
        SELECT * FROM project_goals WHERE goal_id = ${goalId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          goalError("Could not load the project goal.", { goalId, cause }),
        ),
      );

    const loadGoalRowForProject = (projectId: ProjectId) =>
      sql<ProjectGoalRow>`
        SELECT * FROM project_goals WHERE project_id = ${projectId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          goalError("Could not load the project goal for this project.", { cause }),
        ),
      );

    const loadGoal = (goalId: ProjectGoalId) =>
      loadGoalRow(goalId).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeGoalRow(rows[0]),
        ),
      );

    const loadSession = (sessionId: ProjectGoalSessionId) =>
      sql<ProjectGoalSessionRow>`
        SELECT * FROM project_goal_sessions WHERE session_id = ${sessionId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => goalError("Could not load a goal session.", { cause })),
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeSessionRow(rows[0]),
        ),
      );

    const saveGoal: (goal: ProjectGoal) => Effect.Effect<void, ProjectGoalError> = (goal) =>
      sql`
        INSERT INTO project_goals (
          goal_id, project_id, objective, success_criteria_json, status, phase, plan,
          last_summary, last_error, model_selection_json, runtime_mode, interaction_mode,
          workspace_strategy_json, max_sessions, max_failure_streak, session_count,
          failure_streak, current_session_id, current_thread_id, created_by, creation_source,
          created_at, updated_at, started_at, last_session_at, next_action_at
        ) VALUES (
          ${goal.id}, ${goal.projectId}, ${goal.objective}, ${encodeJson(goal.successCriteria)},
          ${goal.status}, ${goal.phase}, ${goal.plan}, ${goal.lastSummary}, ${goal.lastError},
          ${encodeJson(goal.modelSelection)}, ${goal.runtimeMode}, ${goal.interactionMode},
          ${encodeJson(goal.workspaceStrategy)}, ${goal.maxSessions}, ${goal.maxFailureStreak},
          ${goal.sessionCount}, ${goal.failureStreak}, ${goal.currentSessionId},
          ${goal.currentThreadId}, ${goal.createdBy}, ${goal.creationSource}, ${goal.createdAt},
          ${goal.updatedAt}, ${goal.startedAt}, ${goal.lastSessionAt}, ${goal.nextActionAt}
        )
        ON CONFLICT (goal_id) DO UPDATE SET
          objective = excluded.objective,
          success_criteria_json = excluded.success_criteria_json,
          status = excluded.status,
          phase = excluded.phase,
          plan = excluded.plan,
          last_summary = excluded.last_summary,
          last_error = excluded.last_error,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          workspace_strategy_json = excluded.workspace_strategy_json,
          max_sessions = excluded.max_sessions,
          max_failure_streak = excluded.max_failure_streak,
          session_count = excluded.session_count,
          failure_streak = excluded.failure_streak,
          current_session_id = excluded.current_session_id,
          current_thread_id = excluded.current_thread_id,
          updated_at = excluded.updated_at,
          started_at = excluded.started_at,
          last_session_at = excluded.last_session_at,
          next_action_at = excluded.next_action_at
      `.pipe(
        Effect.mapError((cause) =>
          goalError("Could not save the project goal.", { goalId: goal.id, cause }),
        ),
      );

    const runningSessionCount = () =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM project_goal_sessions WHERE status = 'running'
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows[0]?.count ?? 0),
      );

    const list: ProjectGoalService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, decodeGoalRow, { concurrency: 1 })),
        Effect.map((goals) => ({ goals })),
        Effect.mapError((cause) =>
          isProjectGoalError(cause) ? cause : goalError("Could not list project goals.", { cause }),
        ),
      );

    const subscribeList: ProjectGoalService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ProjectGoalService["Service"]["upsert"] = Effect.fn("ProjectGoalService.upsert")(
      function* (input) {
        const project = yield* projects
          .getById(input.projectId)
          .pipe(
            Effect.mapError((cause) =>
              goalError("Could not resolve the project for this goal.", { cause }),
            ),
          );
        if (Option.isNone(project)) {
          return yield* goalError("Project not found.");
        }
        const now = iso(yield* DateTime.now);
        const [existingRow] = yield* loadGoalRowForProject(input.projectId);
        const existing = existingRow === undefined ? null : yield* decodeGoalRow(existingRow);
        const goal: ProjectGoal =
          existing === null
            ? {
                id: projectGoalIdForProject(input.projectId),
                projectId: input.projectId,
                objective: input.objective,
                successCriteria: input.successCriteria ?? [],
                status: "active",
                phase: "planning",
                plan: null,
                lastSummary: null,
                lastError: null,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                workspaceStrategy: input.workspaceStrategy,
                maxSessions: input.maxSessions ?? PROJECT_GOAL_DEFAULT_MAX_SESSIONS,
                maxFailureStreak: input.maxFailureStreak ?? PROJECT_GOAL_DEFAULT_MAX_FAILURE_STREAK,
                sessionCount: 0,
                failureStreak: 0,
                currentSessionId: null,
                currentThreadId: null,
                createdBy: input.createdBy ?? "user",
                creationSource: input.creationSource ?? "web",
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                lastSessionAt: null,
                nextActionAt: now,
              }
            : {
                ...existing,
                objective: input.objective,
                successCriteria: input.successCriteria ?? existing.successCriteria,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                workspaceStrategy: input.workspaceStrategy,
                maxSessions: input.maxSessions ?? existing.maxSessions,
                maxFailureStreak: input.maxFailureStreak ?? existing.maxFailureStreak,
                updatedAt: now,
                // An active goal with nothing running should act on an edit promptly.
                nextActionAt:
                  existing.status === "active" &&
                  existing.currentSessionId === null &&
                  existing.nextActionAt === null
                    ? now
                    : existing.nextActionAt,
              };
        yield* saveGoal(goal);
        yield* notifyChanged;
        return { goal };
      },
    );

    const setStatus: ProjectGoalService["Service"]["setStatus"] = Effect.fn(
      "ProjectGoalService.setStatus",
    )(function* (input) {
      const goal = yield* loadGoal(input.goalId);
      if (goal === null)
        return yield* goalError("Project goal not found.", { goalId: input.goalId });
      const now = iso(yield* DateTime.now);
      const running = goal.currentSessionId !== null;
      const restart = input.status === "active" && !running;
      const next: ProjectGoal =
        input.status === "paused"
          ? { ...goal, status: "paused", nextActionAt: null, updatedAt: now }
          : input.status === "active"
            ? restart &&
              (goal.status === "achieved" ||
                goal.status === "blocked" ||
                goal.status === "cancelled")
              ? {
                  ...goal,
                  status: "active",
                  phase: "planning",
                  plan: null,
                  lastSummary: null,
                  lastError: null,
                  sessionCount: 0,
                  failureStreak: 0,
                  startedAt: now,
                  lastSessionAt: null,
                  nextActionAt: now,
                  updatedAt: now,
                }
              : { ...goal, status: "active", nextActionAt: running ? null : now, updatedAt: now }
            : {
                ...goal,
                status: input.status,
                nextActionAt: null,
                updatedAt: now,
              };
      yield* saveGoal(next);
      yield* notifyChanged;
      return { goal: next };
    });

    const deleteGoal: ProjectGoalService["Service"]["delete"] = Effect.fn(
      "ProjectGoalService.delete",
    )(function* (input) {
      yield* sql`DELETE FROM project_goals WHERE goal_id = ${input.goalId}`.pipe(
        Effect.mapError((cause) =>
          goalError("Could not delete the project goal.", { goalId: input.goalId, cause }),
        ),
      );
      yield* notifyChanged;
      return ProjectGoalDeleteResult.make({ goalId: input.goalId });
    });

    const runNow: ProjectGoalService["Service"]["runNow"] = Effect.fn("ProjectGoalService.runNow")(
      function* (input) {
        const goal = yield* loadGoal(input.goalId);
        if (goal === null)
          return yield* goalError("Project goal not found.", { goalId: input.goalId });
        if (goal.status !== "active") {
          return yield* goalError("Resume this goal before starting a session.", {
            goalId: input.goalId,
          });
        }
        if (goal.currentSessionId !== null) {
          return yield* goalError("A session is already running for this goal.", {
            goalId: input.goalId,
          });
        }
        const next = {
          ...goal,
          nextActionAt: iso(yield* DateTime.now),
          updatedAt: iso(yield* DateTime.now),
        };
        yield* saveGoal(next);
        yield* notifyChanged;
        return { goal: next };
      },
    );

    const listSessions: ProjectGoalService["Service"]["listSessions"] = Effect.fn(
      "ProjectGoalService.listSessions",
    )(function* (input) {
      const limit = input.limit ?? 20;
      const rows = yield* sql<ProjectGoalSessionRow>`
        SELECT * FROM project_goal_sessions
        WHERE goal_id = ${input.goalId}
        ORDER BY started_at DESC, session_id DESC
        LIMIT ${limit}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          goalError("Could not list goal sessions.", { goalId: input.goalId, cause }),
        ),
      );
      const sessions = yield* Effect.forEach(rows, decodeSessionRow, { concurrency: 1 });
      return { sessions };
    });

    const blockIfBudgetExhausted = (goal: ProjectGoal, now: string) =>
      // A verification session spends no new work; let it confirm a claimed success.
      goal.phase === "verifying"
        ? Effect.succeed(false)
        : goal.sessionCount >= goal.maxSessions
          ? Effect.gen(function* () {
              yield* saveGoal({
                ...goal,
                status: "blocked",
                lastError: `The goal used all ${goal.maxSessions} sessions without being achieved.`,
                currentSessionId: null,
                currentThreadId: null,
                nextActionAt: null,
                updatedAt: now,
              });
              yield* notifyChanged;
              return true;
            })
          : Effect.succeed(false);

    const startGoal = Effect.fn("ProjectGoalService.startGoal")(function* (goalId: ProjectGoalId) {
      yield* startPermit.withPermits(1)(
        Effect.gen(function* () {
          const goal = yield* loadGoal(goalId);
          if (goal === null || goal.status !== "active" || goal.currentSessionId !== null) return;
          const nowDate = yield* DateTime.now;
          const now = iso(nowDate);
          const nowMs = DateTime.toEpochMillis(nowDate);
          if (goal.nextActionAt !== null && Date.parse(goal.nextActionAt) > nowMs) return;
          if (yield* blockIfBudgetExhausted(goal, now)) return;
          if ((yield* runningSessionCount()) >= MAX_CONCURRENT_GOAL_SESSIONS) return;

          const sessionNumber = goal.sessionCount + 1;
          const sessionId = ProjectGoalSessionIdSchema.make(`${goal.id}:${sessionNumber}`);
          const reservedRows = yield* sql<ProjectGoalRow>`
            UPDATE project_goals
            SET session_count = session_count + 1,
                current_session_id = ${sessionId},
                current_thread_id = NULL,
                next_action_at = NULL,
                last_error = NULL,
                started_at = COALESCE(started_at, ${now}),
                updated_at = ${now}
            WHERE goal_id = ${goal.id} AND status = 'active' AND current_session_id IS NULL
            RETURNING *
          `.pipe(
            Effect.mapError((cause) =>
              goalError("Could not reserve a goal session.", { goalId, cause }),
            ),
          );
          if (reservedRows[0] === undefined) return;
          const reserved = yield* decodeGoalRow(reservedRows[0]);

          yield* sql`
            INSERT INTO project_goal_sessions (
              session_id, goal_id, project_id, phase, status, thread_id, run_id,
              report_json, summary, error, started_at, completed_at
            ) VALUES (
              ${sessionId}, ${goal.id}, ${goal.projectId}, ${goal.phase}, 'running', NULL, NULL,
              NULL, NULL, NULL, ${now}, NULL
            )
          `.pipe(
            Effect.mapError((cause) =>
              goalError("Could not record a goal session.", { goalId, cause }),
            ),
          );
          yield* notifyChanged;

          const [projectRow] = yield* sql<{ readonly title: string }>`
            SELECT title FROM projection_projects WHERE project_id = ${goal.projectId} AND deleted_at IS NULL
          `.pipe(
            NodeSqliteClient.readOnly,
            Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly title: string }>),
          );
          const brief = {
            goal: {
              objective: goal.objective,
              successCriteria: goal.successCriteria,
              plan: goal.plan,
              maxSessions: goal.maxSessions,
              sessionCount: reserved.sessionCount,
            },
            projectLabel: projectRow?.title ?? "this project",
            phase: goal.phase,
            sessionNumber,
            history: [] as ReadonlyArray<{
              phase: ProjectGoalSession["phase"];
              status: ProjectGoalSession["status"];
              summary: string | null;
              report: ProjectGoalReport | null;
            }>,
          };
          const historyRows = yield* sql<ProjectGoalSessionRow>`
            SELECT * FROM project_goal_sessions
            WHERE goal_id = ${goal.id} AND session_id != ${sessionId}
            ORDER BY started_at DESC LIMIT 5
          `.pipe(
            NodeSqliteClient.readOnly,
            Effect.orElseSucceed(() => [] as ReadonlyArray<ProjectGoalSessionRow>),
          );
          const history = yield* Effect.forEach(
            historyRows,
            (row) => decodeSessionRow(row).pipe(Effect.orElseSucceed(() => null)),
            { concurrency: 1 },
          );
          const prompt = composeProjectGoalPrompt({
            ...brief,
            history: history.filter((session) => session !== null).reverse(),
          });

          const launched = yield* Effect.exit(
            threadLaunch.launch({
              commandId: CommandId.make(`project-goal:${sessionId}`),
              projectId: goal.projectId,
              title: projectGoalThreadTitle(goal.objective, sessionNumber),
              modelSelection: goal.modelSelection,
              runtimeMode: goal.runtimeMode,
              interactionMode: goal.interactionMode,
              workspaceStrategy: goal.workspaceStrategy,
              initialMessage: {
                messageId: MessageId.make(`project-goal-message:${sessionId}`),
                text: prompt,
                attachments: [],
              },
              createdBy: "system",
              creationSource: "server",
            }),
          );

          if (Exit.isSuccess(launched)) {
            const threadId = launched.value.threadId;
            const runId =
              [...launched.value.projection.runs].sort(
                (left, right) => right.ordinal - left.ordinal,
              )[0]?.id ?? null;
            yield* sql`
              UPDATE project_goal_sessions
              SET thread_id = ${threadId}, run_id = ${runId}
              WHERE session_id = ${sessionId} AND status = 'running'
            `;
            yield* sql`
              UPDATE project_goals
              SET current_thread_id = ${threadId}, last_error = NULL, updated_at = ${now}
              WHERE goal_id = ${goal.id} AND current_session_id = ${sessionId}
            `;
            yield* notifyChanged;
            return;
          }

          const error = errorMessage(launched.cause);
          const transition = decideGoalTransition(
            { ...goal, sessionCount: reserved.sessionCount },
            reserved.sessionCount,
            { runStatus: "failed", report: null, error },
          );
          yield* sql`
            UPDATE project_goal_sessions
            SET status = 'failed', error = ${error}, completed_at = ${now}
            WHERE session_id = ${sessionId}
          `;
          yield* saveGoal({
            ...goal,
            status: transition.status,
            phase: transition.phase,
            plan: transition.plan,
            lastSummary: transition.lastSummary,
            lastError: transition.lastError,
            failureStreak: transition.failureStreak,
            sessionCount: reserved.sessionCount,
            currentSessionId: null,
            currentThreadId: null,
            lastSessionAt: now,
            nextActionAt: transition.nextSession ? addMilliseconds(now, MIN_SESSION_GAP_MS) : null,
            updatedAt: now,
          });
          yield* notifyChanged;
        }),
      );
    });

    const finalizeSession = Effect.fn("ProjectGoalService.finalizeSession")(function* (
      goalId: ProjectGoalId,
      sessionId: ProjectGoalSessionId,
      _trigger: string,
    ) {
      const claimed = yield* Ref.modify(finalizing, (active) =>
        active.has(sessionId)
          ? ([false, active] as const)
          : ([true, new Set(active).add(sessionId)] as const),
      );
      if (!claimed) return;
      yield* Effect.gen(function* () {
        const session = yield* loadSession(sessionId);
        if (session === null || session.status !== "running") return;
        const goal = yield* loadGoal(goalId);
        const nowDate = yield* DateTime.now;
        const now = iso(nowDate);
        if (goal === null) {
          yield* sql`
              UPDATE project_goal_sessions
              SET status = 'cancelled', error = 'The goal was deleted.', completed_at = ${now}
              WHERE session_id = ${sessionId}
            `;
          return;
        }
        if (session.threadId === null) {
          // A launch that crashed before creating its thread has nothing to wait for.
          if (Date.parse(session.startedAt) + LAUNCH_GRACE_MS > DateTime.toEpochMillis(nowDate))
            return;
          yield* failSession(goal, session, "The session never started a thread.", now);
          return;
        }

        const projection = yield* threadManagement
          .getThreadProjection(session.threadId)
          .pipe(Effect.option);
        if (Option.isNone(projection)) {
          yield* failSession(goal, session, "The session's thread was deleted.", now);
          return;
        }
        const runs = projection.value.runs;
        const run =
          session.runId === null
            ? [...runs].sort((left, right) => right.ordinal - left.ordinal)[0]
            : runs.find((candidate) => candidate.id === session.runId);
        if (run === undefined) {
          if (Date.parse(session.startedAt) + LAUNCH_GRACE_MS > DateTime.toEpochMillis(nowDate))
            return;
          yield* failSession(goal, session, "The session never started a run.", now);
          return;
        }
        if (!isTerminalRunStatus(run.status)) {
          if (
            Date.parse(session.startedAt) + PROJECT_GOAL_SESSION_TIMEOUT_MS >
            DateTime.toEpochMillis(nowDate)
          )
            return;
          // End the run too: a stuck session must not keep working beside the next one.
          yield* threadManagement
            .interruptThread({
              projectId: goal.projectId,
              commandId: CommandId.make(`project-goal-timeout:${goal.id}:${run.id}`),
              threadId: session.threadId,
              runId: run.id,
              reason: "This orchestrator session exceeded its time limit.",
            })
            .pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("Could not stop a timed-out project goal session", {
                    goalId: goal.id,
                    cause,
                  }),
              ),
            );
          yield* failSession(
            goal,
            session,
            "The session exceeded the orchestrator time limit.",
            now,
          );
          return;
        }

        const shell = yield* threadManagement.getThreadShell(session.threadId).pipe(Effect.option);
        // Background work outlives the run. Wait for it to settle before judging the session,
        // or a monitor or subagent still finishing would be reported as unfinished work.
        if (
          Option.isSome(shell) &&
          shell.value !== null &&
          (shell.value.pendingBackgroundTasks?.length ?? 0) > 0
        ) {
          // Work that never settles must not pin the goal forever.
          if (
            Date.parse(session.startedAt) + PROJECT_GOAL_SESSION_TIMEOUT_MS <=
            DateTime.toEpochMillis(nowDate)
          )
            yield* failSession(
              goal,
              session,
              "The session's background work exceeded the orchestrator time limit.",
              now,
            );
          return;
        }
        const text = lastAssistantMessage(projection.value);
        const report = text === null ? null : parseProjectGoalReport(text);
        const outcome: GoalSessionOutcome = {
          runStatus: run.status,
          report,
          error: Option.isSome(shell) ? (shell.value?.lastError ?? null) : null,
        };
        const transition = decideGoalTransition(goal, goal.sessionCount, outcome);
        yield* sql`
            UPDATE project_goal_sessions
            SET status = ${sessionStatusForTerminal(run.status)},
                report_json = ${report === null ? null : encodeJson(report)},
                summary = ${report?.summary ?? null},
                error = ${outcome.error},
                completed_at = ${now}
            WHERE session_id = ${sessionId} AND status = 'running'
          `;
        yield* saveGoal({
          ...goal,
          status: transition.status,
          phase: transition.phase,
          plan: transition.plan,
          lastSummary: transition.lastSummary,
          lastError: transition.lastError,
          failureStreak: transition.failureStreak,
          currentSessionId: null,
          currentThreadId: null,
          lastSessionAt: now,
          nextActionAt: transition.nextSession ? addMilliseconds(now, MIN_SESSION_GAP_MS) : null,
          updatedAt: now,
        });
        yield* notifyChanged;
      }).pipe(
        Effect.onExit(() =>
          Ref.update(finalizing, (active) => {
            const next = new Set(active);
            next.delete(sessionId);
            return next;
          }),
        ),
      );
    });

    const failSession = Effect.fn("ProjectGoalService.failSession")(function* (
      goal: ProjectGoal,
      session: ProjectGoalSession,
      reason: string,
      now: string,
    ) {
      const transition = decideGoalTransition(goal, goal.sessionCount, {
        runStatus: "failed",
        report: null,
        error: reason,
      });
      yield* sql`
          UPDATE project_goal_sessions
          SET status = 'failed', error = ${reason}, completed_at = ${now}
          WHERE session_id = ${session.id} AND status = 'running'
        `;
      yield* saveGoal({
        ...goal,
        status: transition.status,
        phase: transition.phase,
        plan: transition.plan,
        lastSummary: transition.lastSummary,
        lastError: transition.lastError,
        failureStreak: transition.failureStreak,
        currentSessionId: null,
        currentThreadId: null,
        lastSessionAt: now,
        nextActionAt: transition.nextSession ? addMilliseconds(now, MIN_SESSION_GAP_MS) : null,
        updatedAt: now,
      });
      yield* notifyChanged;
    });

    const finalizeByThread = Effect.fn("ProjectGoalService.finalizeByThread")(function* (
      threadId: ThreadId,
    ) {
      const goals = yield* sql<ProjectGoalRow>`
          SELECT * FROM project_goals WHERE current_thread_id = ${threadId}
        `.pipe(NodeSqliteClient.readOnly);
      for (const row of goals) {
        const goal = yield* decodeGoalRow(row);
        if (goal.currentSessionId === null) continue;
        yield* finalizeSession(goal.id, goal.currentSessionId, "run");
      }
      const sessions = yield* sql<{ readonly session_id: string; readonly goal_id: string }>`
          SELECT session_id, goal_id FROM project_goal_sessions
          WHERE thread_id = ${threadId} AND status = 'running'
        `.pipe(NodeSqliteClient.readOnly);
      for (const row of sessions) {
        yield* finalizeSession(
          row.goal_id as ProjectGoalId,
          row.session_id as ProjectGoalSessionId,
          "run",
        );
      }
    });

    const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
      finalizeByThread(threadId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Project goal session finalization failed", {
              threadId,
              cause,
            }),
        ),
      ),
    );

    const clearOrphanReservations = Effect.gen(function* () {
      const now = iso(yield* DateTime.now);
      const rows = yield* sql<{ readonly goal_id: string; readonly current_session_id: string }>`
        SELECT goal_id, current_session_id FROM project_goals
        WHERE status = 'active' AND current_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM project_goal_sessions
            WHERE session_id = project_goals.current_session_id AND status = 'running'
          )
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of rows) {
        yield* sql`
          UPDATE project_goals
          SET current_session_id = NULL, current_thread_id = NULL,
              next_action_at = ${now}, updated_at = ${now}
          WHERE goal_id = ${row.goal_id} AND current_session_id = ${row.current_session_id}
        `;
      }
      if (rows.length > 0) yield* notifyChanged;
    });

    const recoverRunningSessions = Effect.gen(function* () {
      const rows = yield* sql<{ readonly session_id: string; readonly goal_id: string }>`
        SELECT session_id, goal_id FROM project_goal_sessions WHERE status = 'running'
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of rows) {
        yield* finalizeSession(
          row.goal_id as ProjectGoalId,
          row.session_id as ProjectGoalSessionId,
          "recovery",
        );
      }
    });

    const startDueGoals = Effect.gen(function* () {
      const now = iso(yield* DateTime.now);
      const rows = yield* sql<{ readonly goal_id: string }>`
        SELECT goal_id FROM project_goals
        WHERE status = 'active' AND current_session_id IS NULL
          AND (next_action_at IS NULL OR next_action_at <= ${now})
        ORDER BY COALESCE(next_action_at, started_at, created_at) ASC
        LIMIT ${SWEEP_LIMIT}
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of rows) {
        yield* startGoal(row.goal_id as ProjectGoalId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not start a project goal session", {
              goalId: row.goal_id,
              cause,
            }),
          ),
        );
      }
    });

    let lastRecoveryAt = 0;
    const sweep = Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (nowMs - lastRecoveryAt >= 60_000) {
        lastRecoveryAt = nowMs;
        yield* clearOrphanReservations;
        yield* recoverRunningSessions;
      }
      yield* startDueGoals;
    });

    const start: ProjectGoalService["Service"]["start"] = Effect.fn("ProjectGoalService.start")(
      function* () {
        if (started) return;
        started = true;
        yield* forkParked(
          Stream.runForEach(engine.streamDomainEvents, (event) =>
            event.type === "run.updated" && isTerminalRunStatus(event.payload.status)
              ? worker.enqueue(event.threadId)
              : Effect.void,
          ).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.logWarning("Project goal event stream failed", { cause }),
            ),
          ),
        );
        yield* scheduler.register(
          "project-goals",
          sweep.pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.logWarning("Project goal sweep failed", { cause }),
            ),
          ),
        );
      },
    );

    return ProjectGoalService.of({
      list,
      subscribeList,
      upsert,
      setStatus,
      delete: deleteGoal,
      runNow,
      listSessions,
      start,
      handleThreadRunEnded: Effect.fn("ProjectGoalService.handleThreadRunEnded")(function* (
        threadId: ThreadId,
      ) {
        yield* worker.enqueue(threadId);
      }),
      drain: worker.drain,
    });
  }),
);
