import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type ProjectGoalUpsertInput,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectGoalService from "./ProjectGoalService.ts";

const project = {
  id: ProjectId.make("project-1"),
  title: "Acme",
  workspaceRoot: "/repo/acme",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const input = (overrides: Partial<ProjectGoalUpsertInput> = {}): ProjectGoalUpsertInput => ({
  projectId: project.id,
  objective: "Ship billing",
  successCriteria: ["Tests pass"],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  maxSessions: 5,
  maxFailureStreak: 3,
  creationSource: "web",
  ...overrides,
});

const dependencies = (launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"]) =>
  Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome(project as never),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
    }),
    Scheduler.layer,
  );

const baseLayer = (launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"]) =>
  ProjectGoalService.layer.pipe(Layer.provide(dependencies(launch)));

it.effect("saves one goal per project and applies status changes", () =>
  Effect.gen(function* () {
    const service = yield* ProjectGoalService.ProjectGoalService;
    const created = yield* service.upsert(input());
    assert.equal(created.goal.objective, "Ship billing");
    assert.equal(created.goal.status, "active");
    assert.equal(created.goal.phase, "planning");

    const updated = yield* service.upsert(input({ objective: "Ship billing safely" }));
    assert.equal(updated.goal.id, created.goal.id);
    assert.equal(updated.goal.objective, "Ship billing safely");

    const listed = yield* service.list();
    assert.equal(listed.goals.length, 1);

    const paused = yield* service.setStatus({ goalId: created.goal.id, status: "paused" });
    assert.equal(paused.goal.status, "paused");

    const resumed = yield* service.setStatus({ goalId: created.goal.id, status: "active" });
    assert.equal(resumed.goal.status, "active");

    const achieved = yield* service.setStatus({ goalId: created.goal.id, status: "achieved" });
    assert.equal(achieved.goal.status, "achieved");

    const restarted = yield* service.setStatus({ goalId: created.goal.id, status: "active" });
    assert.equal(restarted.goal.status, "active");
    assert.equal(restarted.goal.phase, "planning");
    assert.equal(restarted.goal.sessionCount, 0);

    const removed = yield* service.delete({ goalId: created.goal.id });
    assert.equal(removed.goalId, created.goal.id);
    assert.deepEqual((yield* service.list()).goals, []);
  }).pipe(
    Effect.provide(
      baseLayer(() => Effect.die("unused")).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
  ),
);

it.effect("starts a session and advances the goal from its final report", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const launched = yield* Deferred.make<ThreadId>();
    const launchCalls = yield* Ref.make(0);
    const threadId = ThreadId.make("thread-1");

    const layer = ProjectGoalService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome(project as never),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launchCalls, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(launched, threadId)),
                Effect.as({
                  threadId,
                  resumed: false,
                  projection: {
                    thread: { latestRunId: "run-1" },
                    runs: [],
                    messages: [],
                  },
                }),
              ) as never,
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadProjection: () =>
              Effect.succeed({
                thread: { latestRunId: "run-1" },
                runs: [{ id: "run-1", threadId, ordinal: 1, status: "completed" }],
                messages: [
                  {
                    role: "assistant",
                    streaming: false,
                    text: [
                      "Done.",
                      "```t3-orchestrator",
                      JSON.stringify({ status: "achieved", summary: "Built it" }),
                      "```",
                    ].join("\n"),
                    updatedAt: "2026-01-01T00:00:06.000Z",
                  },
                ],
              } as never),
            getThreadShell: () =>
              Effect.succeed({
                lastError: null,
                pendingBackgroundTasks: [],
              } as never),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.empty,
          }),
          Scheduler.layer,
        ),
      ),
    );

    const context = yield* Layer.build(layer);
    yield* Effect.gen(function* () {
      const service = yield* ProjectGoalService.ProjectGoalService;
      yield* service.start();
      const goal = (yield* service.upsert(input())).goal;
      yield* service.runNow({ goalId: goal.id });
      yield* TestClock.adjust("6 seconds");
      assert.equal(yield* Deferred.await(launched), threadId);
      assert.equal(yield* Ref.get(launchCalls), 1);

      // The reservation lands before the launch; the thread binding lands after it returns.
      const [sessionRow] = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM project_goal_sessions WHERE goal_id = ${goal.id}
      `;
      assert.isDefined(sessionRow);
      yield* sql`
        UPDATE project_goal_sessions
        SET thread_id = ${threadId}, run_id = 'run-1'
        WHERE session_id = ${sessionRow!.session_id}
      `;
      yield* sql`
        UPDATE project_goals SET current_thread_id = ${threadId} WHERE goal_id = ${goal.id}
      `;

      yield* service.handleThreadRunEnded(threadId);
      yield* service.drain;

      const [row] = yield* sql<{
        phase: string;
        status: string;
        current_thread_id: string | null;
        current_session_id: string | null;
        last_summary: string | null;
      }>`SELECT phase, status, current_thread_id, current_session_id, last_summary
         FROM project_goals WHERE goal_id = ${goal.id}`;
      assert.equal(row?.phase, "verifying");
      assert.equal(row?.status, "active");
      assert.isNull(row?.current_thread_id);
      assert.isNull(row?.current_session_id);
      assert.equal(row?.last_summary, "Built it");

      const sessions = yield* sql<{
        status: string;
        thread_id: string | null;
        report_json: string | null;
      }>`SELECT status, thread_id, report_json FROM project_goal_sessions WHERE goal_id = ${goal.id}`;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.status, "completed");
      assert.equal(sessions[0]?.thread_id, threadId);
      assert.include(sessions[0]?.report_json ?? "", "achieved");
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
