import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectGoal,
  ProjectGoalPhase,
  ProjectGoalReport,
  ProjectGoalSession,
  ProjectGoalStatus,
  ProjectGoalUpsertInput,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  AuthOrchestrationOperateScope,
  PROJECT_GOAL_MAX_SESSIONS,
  ProviderInstanceId as ProviderInstanceIdSchema,
  clampManagedRuntimeMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironment } from "../../state/environments";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { readEnvironmentScope } from "~/state/session";
import { useManagedPolicy } from "~/state/managedPolicy";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { scheduledTaskDefaultModel } from "./scheduledTasksSettings.logic";

const STATUS_VARIANT: Record<
  ProjectGoalStatus,
  "success" | "info" | "warning" | "error" | "outline"
> = {
  active: "info",
  paused: "outline",
  blocked: "error",
  achieved: "success",
  cancelled: "outline",
};

const PHASE_LABEL: Record<ProjectGoalPhase, string> = {
  planning: "Planning",
  executing: "Executing",
  verifying: "Verifying",
};

const STATUS_LABEL: Record<ProjectGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  achieved: "Achieved",
  cancelled: "Cancelled",
};

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceIdSchema.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

function reportLine(report: ProjectGoalReport | null): string | null {
  if (report === null) return null;
  if (report.nextStep?.trim()) return report.nextStep;
  if (report.blockers?.length) return report.blockers.join(" · ");
  return null;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ProjectGoalsSettings({
  environmentId,
}: {
  readonly environmentId?: EnvironmentId;
}) {
  const { environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    goal: ProjectGoal | null;
    projectId: ProjectId | null;
  } | null>(null);
  const defaultEnvironment =
    environment ?? connectedEnvironments[0] ?? environments[0] ?? undefined;
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Orchestrator"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={connectedEnvironments.length === 0}
            onClick={() => {
              if (defaultEnvironment === undefined) return;
              setEditor({
                environmentId: defaultEnvironment.environmentId,
                goal: null,
                projectId: null,
              });
            }}
          >
            <PlusIcon className="size-3" />
            New goal
          </Button>
        }
      >
        <div className="space-y-8">
          {environments.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TargetIcon />
                </EmptyMedia>
                <EmptyTitle>No environments available</EmptyTitle>
                <EmptyDescription>Connect an environment to run project goals.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            environments.map((entry) => (
              <ProjectGoalEnvironmentSection
                key={entry.environmentId}
                environmentId={
                  environmentId !== undefined && environmentId === entry.environmentId
                    ? environmentId
                    : entry.environmentId
                }
                onEdit={(goal) =>
                  setEditor({
                    environmentId: entry.environmentId,
                    goal,
                    projectId: goal.projectId,
                  })
                }
                onCreate={(projectId) =>
                  setEditor({
                    environmentId: entry.environmentId,
                    goal: null,
                    projectId,
                  })
                }
              />
            ))
          )}
        </div>
      </SettingsSection>
      {editor ? (
        <ProjectGoalEditorDialog
          key={`${editor.environmentId}:${editor.goal?.id ?? editor.projectId ?? "new"}`}
          environmentId={editor.environmentId}
          goal={editor.goal}
          initialProjectId={editor.projectId}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ProjectGoalEnvironmentSection({
  environmentId,
  onEdit,
  onCreate,
}: {
  readonly environmentId: EnvironmentId;
  readonly onEdit: (goal: ProjectGoal) => void;
  readonly onCreate: (projectId: ProjectId | null) => void;
}) {
  const environment = useEnvironment(environmentId);
  const projects = useProjects();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig != null;
  const supportsGoals = environment?.serverConfig?.environment.capabilities.projectGoals === true;
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.projectGoalsLive({ environmentId, input: {} }) : null,
  );
  const goals = query.data?.goals ?? [];
  const projectsForEnvironment = projects.filter(
    (project) => project.environmentId === environmentId,
  );
  const projectTitle = (projectId: ProjectId) =>
    projectsForEnvironment.find((project) => project.id === projectId)?.title ?? "Project";
  const projectsWithoutGoal = projectsForEnvironment.filter(
    (project) => !goals.some((goal) => goal.projectId === project.id),
  );
  return (
    <SettingsSection
      title={environment?.label ?? "Environment"}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!connected || !supportsGoals}
          onClick={() => onCreate(projectsWithoutGoal[0]?.id ?? null)}
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      }
    >
      {!connected ? (
        <SettingsRow title="This environment is not connected." />
      ) : !supportsGoals ? (
        <SettingsRow
          title="This server does not support project goals."
          description="Update the server to use the orchestrator."
        />
      ) : query.error ? (
        <SettingsRow title={query.error} />
      ) : goals.length === 0 ? (
        <SettingsRow
          title="No project goals yet"
          description="Give a project a standing objective and T3 Code keeps starting sessions until it is done."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={projectsWithoutGoal.length === 0}
              onClick={() => onCreate(projectsWithoutGoal[0]?.id ?? null)}
            >
              Set a goal
            </Button>
          }
        />
      ) : (
        goals.map((goal) => (
          <ProjectGoalRow
            key={goal.id}
            environmentId={environmentId}
            goal={goal}
            projectTitle={projectTitle(goal.projectId)}
            onEdit={() => onEdit(goal)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ProjectGoalRow({
  environmentId,
  goal,
  projectTitle,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly goal: ProjectGoal;
  readonly projectTitle: string;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.setProjectGoalStatus.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const setStatus = useAtomCommand(serverEnvironment.setProjectGoalStatus, {
    label: "project goal status",
  });
  const runNow = useAtomCommand(serverEnvironment.runProjectGoalNow, {
    label: "project goal run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteProjectGoal, {
    label: "project goal delete",
  });

  const act = async (action: "resume" | "pause" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result =
      action === "delete"
        ? await remove({ environmentId, input: { goalId: goal.id } })
        : action === "run"
          ? await runNow({ environmentId, input: { goalId: goal.id } })
          : await setStatus({
              environmentId,
              input: {
                goalId: goal.id,
                status: action === "pause" ? "paused" : "active",
              },
            });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update the project goal",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  const live = goal.status === "active";
  const finished =
    goal.status === "achieved" || goal.status === "cancelled" || goal.status === "blocked";
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate">{projectTitle}</span>
          <Badge variant={STATUS_VARIANT[goal.status]}>{STATUS_LABEL[goal.status]}</Badge>
          {live ? <Badge variant="outline">{PHASE_LABEL[goal.phase]}</Badge> : null}
          <span className="text-xs font-normal text-muted-foreground">
            {goal.sessionCount}/{goal.maxSessions} sessions
          </span>
        </span>
      }
      description={
        <span className="block space-y-1">
          <span className="line-clamp-2">{goal.objective}</span>
          {goal.successCriteria.length > 0 ? (
            <span className="block text-xs text-muted-foreground">
              {goal.successCriteria.length} success{" "}
              {goal.successCriteria.length === 1 ? "criterion" : "criteria"}
            </span>
          ) : null}
        </span>
      }
      status={
        <div className="space-y-1">
          {goal.currentThreadId !== null ? (
            <span className="flex items-center gap-2">
              <ActivityIcon className="size-3 animate-pulse" />
              <ProjectGoalThreadLink
                environmentId={environmentId}
                threadId={goal.currentThreadId}
              />
            </span>
          ) : live ? (
            <span>
              {goal.nextActionAt === null ? "Ready for the next session" : "Next session"}{" "}
              {goal.nextActionAt === null ? null : (
                <span>{formatTimestamp(goal.nextActionAt)}</span>
              )}
            </span>
          ) : null}
          {goal.lastSummary ? (
            <span className="line-clamp-2 text-muted-foreground">{goal.lastSummary}</span>
          ) : null}
          {goal.lastError ? <span className="block text-destructive">{goal.lastError}</span> : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={`Actions for ${projectTitle}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {live ? (
                <MenuItem onClick={() => void act("pause")}>
                  <PauseIcon />
                  Pause
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void act("resume")}>
                  <RefreshCwIcon />
                  {finished ? "Start again" : "Resume"}
                </MenuItem>
              )}
              <MenuItem
                disabled={!live || goal.currentSessionId !== null}
                onClick={() => void act("run")}
              >
                <PlayIcon />
                Start session now
              </MenuItem>
              <MenuItem onClick={() => setHistoryOpen(true)}>
                <HistoryIcon />
                Sessions
              </MenuItem>
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                Delete goal
              </MenuItem>
            </MenuPopup>
          </Menu>
          {historyOpen ? (
            <ProjectGoalSessionsDialog
              environmentId={environmentId}
              goal={goal}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}
        </div>
      }
    />
  );
}

function ProjectGoalThreadLink({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: NonNullable<ProjectGoal["currentThreadId"]>;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const title = useQuietThreadShell(ref)?.title.trim();
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className="max-w-64 truncate underline underline-offset-2 hover:text-foreground"
    >
      {title || "Open session"}
    </Link>
  );
}

function ProjectGoalSessionsDialog({
  environmentId,
  goal,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly goal: ProjectGoal;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.projectGoalSessions({
      environmentId,
      input: { goalId: goal.id, limit: 50 },
    }),
  );
  const sessions = query.data?.sessions ?? [];
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Goal sessions</DialogTitle>
          <DialogDescription>
            Every session the orchestrator started for this goal, newest first.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.error ? (
            <p className="text-sm text-destructive">{query.error}</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <SessionEntry key={session.id} environmentId={environmentId} session={session} />
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SessionEntry({
  environmentId,
  session,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: ProjectGoalSession;
}) {
  const next = reportLine(session.report);
  return (
    <div className="rounded-md border border-border/60 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            session.status === "completed"
              ? "success"
              : session.status === "running"
                ? "info"
                : "error"
          }
        >
          {session.status}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {PHASE_LABEL[session.phase]} · {formatTimestamp(session.startedAt)}
        </span>
        {session.threadId !== null ? (
          <ProjectGoalThreadLink environmentId={environmentId} threadId={session.threadId} />
        ) : null}
      </div>
      {session.summary ? <p className="mt-2">{session.summary}</p> : null}
      {next ? <p className="mt-1 text-xs text-muted-foreground">Next: {next}</p> : null}
      {session.error ? <p className="mt-1 text-xs text-destructive">{session.error}</p> : null}
    </div>
  );
}

interface GoalDraft {
  readonly projectId: string;
  readonly objective: string;
  readonly criteria: string;
  readonly maxSessions: string;
  readonly maxFailureStreak: string;
  readonly modelKey: string;
  readonly runtimeMode: RuntimeMode;
}

function draftFromGoal(goal: ProjectGoal): GoalDraft {
  return {
    projectId: goal.projectId,
    objective: goal.objective,
    criteria: goal.successCriteria.join("\n"),
    maxSessions: String(goal.maxSessions),
    maxFailureStreak: String(goal.maxFailureStreak),
    modelKey: `${goal.modelSelection.instanceId}:${goal.modelSelection.model}`,
    runtimeMode: goal.runtimeMode,
  };
}

function ProjectGoalEditorDialog({
  environmentId: initialEnvironmentId,
  goal,
  initialProjectId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly goal: ProjectGoal | null;
  readonly initialProjectId: ProjectId | null;
  readonly onClose: () => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig != null;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const projects = useProjects();
  const goalsQuery = useEnvironmentQuery(
    connected ? serverEnvironment.projectGoalsLive({ environmentId, input: {} }) : null,
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertProjectGoal.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertProjectGoal, {
    label: "project goal upsert",
  });
  const managedPolicy = useManagedPolicy(environmentId);

  const projectsForEnvironment = projects
    .filter((project) => project.environmentId === environmentId)
    .filter((project) => {
      if (scope.kind === "unavailable") return false;
      if (scope.kind === "project" || scope.kind === "checkout") {
        return scope.members.some(
          (member) => member.environmentId === environmentId && member.id === project.id,
        );
      }
      return true;
    });
  const available =
    goal === null
      ? projectsForEnvironment
      : projectsForEnvironment.filter(
          (project) =>
            project.id === goal.projectId ||
            !goalsQuery.data?.goals.some((entry) => entry.projectId === project.id),
        );
  const selectedProject =
    available.find((project) => project.id === (initialProjectId ?? "")) ?? available[0];
  const [draft, setDraft] = useState<GoalDraft>(() =>
    goal !== null
      ? draftFromGoal(goal)
      : {
          projectId: initialProjectId ?? "",
          objective: "",
          criteria: "",
          maxSessions: "25",
          maxFailureStreak: "3",
          modelKey: "",
          runtimeMode:
            settings && selectedProject
              ? resolveProjectSettings(settings, selectedProject.id, selectedProject).settings
                  .defaultRuntimeMode
              : "full-access",
        },
  );
  const project =
    available.find((candidate) => candidate.id === draft.projectId) ?? selectedProject;
  const instanceEntries = settings
    ? providerInstanceEntriesFor(providers, settings, project?.id ?? null)
    : [];
  const modelOptionsByInstance = settings
    ? getCustomModelOptionsByInstance(settings, providers, undefined, undefined)
    : new Map();
  const activeSelection =
    (draft.modelKey ? splitModelKey(draft.modelKey) : null) ??
    (settings ? scheduledTaskDefaultModel(settings, project ?? null, instanceEntries) : null);
  const [submitting, setSubmitting] = useState(false);

  const save = async () => {
    if (submitting || !connected || !canOperate || !settings) return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (!project || activeSelection === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Goal is incomplete",
          description: "Choose a project, an objective, and a model.",
        }),
      );
      return;
    }
    const maxSessions = Number(draft.maxSessions);
    const maxFailureStreak = Number(draft.maxFailureStreak);
    const objective = draft.objective.trim();
    if (objective === "") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Objective is required",
          description: "Describe what the orchestrator should achieve.",
        }),
      );
      return;
    }
    if (
      !Number.isSafeInteger(maxSessions) ||
      maxSessions < 1 ||
      maxSessions > PROJECT_GOAL_MAX_SESSIONS
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Invalid session budget",
          description: `Use a whole number between 1 and ${PROJECT_GOAL_MAX_SESSIONS}.`,
        }),
      );
      return;
    }
    if (!Number.isSafeInteger(maxFailureStreak) || maxFailureStreak < 1 || maxFailureStreak > 20) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Invalid failure limit",
          description: "Use a whole number between 1 and 20.",
        }),
      );
      return;
    }
    const input: ProjectGoalUpsertInput = {
      projectId: project.id,
      objective,
      successCriteria: draft.criteria
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      modelSelection: activeSelection,
      runtimeMode: clampManagedRuntimeMode(managedPolicy, draft.runtimeMode) ?? draft.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      maxSessions,
      maxFailureStreak,
      creationSource: "web",
    };
    setSubmitting(true);
    const result = await upsert({ environmentId, input });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save the project goal",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{goal === null ? "Set a project goal" : "Edit project goal"}</DialogTitle>
          <DialogDescription>
            The orchestrator starts a session in the project, reviews its report, then starts the
            next session until the goal is verified, blocked, or out of budget.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset className="min-w-0 space-y-4" disabled={submitting}>
            <Field label="Environment" htmlFor="project-goal-environment">
              <Select
                value={environmentId}
                disabled={goal !== null}
                onValueChange={(id) => {
                  const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  setDraft((current) => ({ ...current, projectId: "", modelKey: "" }));
                }}
              >
                <SelectTrigger id="project-goal-environment" size="sm">
                  <SelectValue>{environment?.label ?? "Unavailable environment"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((entry) => (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label="Project" htmlFor="project-goal-project">
              <Select
                value={project?.id ?? ""}
                disabled={goal !== null}
                onValueChange={(id) =>
                  setDraft((current) => ({ ...current, projectId: id ?? "", modelKey: "" }))
                }
              >
                <SelectTrigger id="project-goal-project" size="sm">
                  <SelectValue>{project?.title ?? "Choose a project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {available.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id} label={entry.title}>
                      {entry.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label="Objective" htmlFor="project-goal-objective">
              <Textarea
                id="project-goal-objective"
                value={draft.objective}
                rows={5}
                placeholder="Ship the billing migration end to end, keep the API compatible, and leave the test suite green."
                onChange={(event) =>
                  setDraft((current) => ({ ...current, objective: event.target.value }))
                }
              />
            </Field>

            <Field
              label="Success criteria"
              hint="One per line. The verifier checks each one before the goal can finish."
              htmlFor="project-goal-criteria"
            >
              <Textarea
                id="project-goal-criteria"
                value={draft.criteria}
                rows={4}
                placeholder={"All tests pass\nNo TypeScript errors\nThe old API still works"}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, criteria: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Session budget" htmlFor="project-goal-max-sessions">
                <Input
                  id="project-goal-max-sessions"
                  inputMode="numeric"
                  value={draft.maxSessions}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxSessions: event.target.value }))
                  }
                />
              </Field>
              <Field label="Failure limit" htmlFor="project-goal-max-failures">
                <Input
                  id="project-goal-max-failures"
                  inputMode="numeric"
                  value={draft.maxFailureStreak}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxFailureStreak: event.target.value }))
                  }
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model">
                <div>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    disabled={submitting || !connected}
                    activeInstanceId={
                      activeSelection?.instanceId ??
                      instanceEntries[0]?.instanceId ??
                      ("" as ProviderInstanceId)
                    }
                    model={activeSelection?.model ?? ""}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onInstanceModelChange={(instanceId, model) =>
                      setDraft((current) => ({
                        ...current,
                        modelKey: `${instanceId}:${model}`,
                      }))
                    }
                  />
                </div>
              </Field>
              <Field label="Permissions" htmlFor="project-goal-runtime-mode">
                <Select
                  value={draft.runtimeMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      runtimeMode: value as RuntimeMode,
                    }))
                  }
                >
                  <SelectTrigger id="project-goal-runtime-mode" size="sm">
                    <SelectValue>{runtimeModeConfig[draft.runtimeMode].label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {runtimeModeOptions.map((mode) => (
                      <SelectItem key={mode} value={mode} label={runtimeModeConfig[mode].label}>
                        {runtimeModeConfig[mode].label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            <p className="text-xs text-muted-foreground">
              Sessions run in the project checkout at{" "}
              <code className="rounded bg-muted px-1">{project?.workspaceRoot ?? "…"}</code>. The
              orchestrator stops starting sessions when the budget runs out or a human is needed.
            </p>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={submitting || !canOperate}>
            {goal === null ? "Start goal" : "Save goal"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
