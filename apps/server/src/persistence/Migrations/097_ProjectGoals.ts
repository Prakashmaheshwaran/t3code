import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_goals (
      goal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      success_criteria_json TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      plan TEXT,
      last_summary TEXT,
      last_error TEXT,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      workspace_strategy_json TEXT NOT NULL,
      max_sessions INTEGER NOT NULL,
      max_failure_streak INTEGER NOT NULL,
      session_count INTEGER NOT NULL,
      failure_streak INTEGER NOT NULL,
      current_session_id TEXT,
      current_thread_id TEXT,
      created_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      last_session_at TEXT,
      next_action_at TEXT
    )
  `;
  // One goal per project: the orchestrator is the project's single durable mission.
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_goals_project
    ON project_goals(project_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_project_goals_due
    ON project_goals(status, next_action_at)
    WHERE status = 'active'`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_project_goals_current_thread
    ON project_goals(current_thread_id)
    WHERE current_thread_id IS NOT NULL`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_goal_sessions (
      session_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES project_goals(goal_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      report_json TEXT,
      summary TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_project_goal_sessions_goal
    ON project_goal_sessions(goal_id, started_at DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_project_goal_sessions_running
    ON project_goal_sessions(status)
    WHERE status = 'running'`;
});
