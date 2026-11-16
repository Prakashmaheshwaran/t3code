# Project orchestrator

The orchestrator turns a project into a standing mission. Give it an objective and success
criteria, and T3 Code keeps starting fresh sessions in that project until the goal is verified,
blocked, or out of budget. Goals are durable server state: they survive restarts and keep running
while no client is open.

Open **Settings → Orchestrator** to set a goal for a project.

## Setting a goal

Each project has at most one goal. A goal has:

- **Objective**: what the project should achieve.
- **Success criteria**: one per line. The verifier checks each one.
- **Session budget**: the maximum number of sessions to spend before stopping.
- **Failure limit**: how many failed or silent sessions in a row stop the goal.
- **Model and permissions**: the provider and runtime mode every session uses.

Sessions run in the project's checkout, so work from one session is visible to the next. The
orchestrator does not create a worktree per session.

## How a goal advances

1. **Planning** starts the first session. It inspects the project, writes a concrete plan, and
   begins the first safe step. The plan is carried into later sessions.
2. **Execution** sessions continue the plan and carry the goal forward. A session ends with a
   report: what changed, what remains, and whether the goal looks complete.
3. **Verification** starts when an execution session claims the goal is done. A fresh session
   inspects the actual workspace and checks every success criterion. Only a verifier can finish
   the goal; if it finds gaps, execution resumes with those gaps as the next step.

Every session gets a mission brief with the objective, criteria, plan, and summaries from recent
sessions, even though each one starts with a fresh context. A session that ends without a report
counts as a failed attempt.

## Reports

Each session ends with a fenced `t3-orchestrator` block containing JSON:

```json
{
  "status": "continue",
  "summary": "What changed and what remains.",
  "plan": "Optional updated plan.",
  "nextStep": "The most useful next step.",
  "blockers": [],
  "evidence": ["npm test"]
}
```

`status` is `continue`, `achieved`, or `blocked`. `blocked` means a person must intervene, such as a
missing credential or a decision only the user can make.

## Controls

- **Pause** stops new sessions. A session already running finishes and records its report.
- **Resume** continues a paused goal.
- **Start again** resets a finished or blocked goal's budget and plan while keeping its session
  history.
- **Start session now** skips the cooldown when the goal is active and idle.
- **Sessions** shows every session, its report, and a link to its thread.
- **Delete goal** removes the goal and its history. It does not stop a session already running.

A blocked goal explains why: a failure streak, an exhausted budget, a missing credential, or a
decision only you can make. Fix the cause, then resume or start again.

## Limits

- Goals run at most three sessions at a time across projects.
- Each goal runs one session at a time.
- Sessions older than the orchestrator timeout are treated as failed and the goal moves on.
