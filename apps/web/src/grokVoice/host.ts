import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { grokVoiceRespond } from "@t3tools/client-runtime/voice-input";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { newMessageId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { readProject, readThreadShell, readThreadShells } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { rankThreads, type DelegatorHost, type DelegatorThread } from "./delegator";

const EXCERPT = 600;

export function readViewedThreadRef(router: AnyRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  return resolveActiveThreadRouteRef(target, draft);
}

export function describeThread(shell: EnvironmentThreadShell): DelegatorThread {
  let status: string = resolveSidebarThreadStatus(shell);
  if (status === "ready" && shell.latestRun?.status === "failed") status = "failed";
  return {
    id: shell.id,
    title: shell.title,
    project: readProject(scopeProjectRef(shell.environmentId, shell.projectId))?.title,
    status,
    updatedAt: shell.updatedAt,
  };
}

const clip = (text: string) =>
  text.length > EXCERPT ? `${text.slice(0, EXCERPT)}… (${text.length} chars)` : text;

/** Thread details stream lazily; hold the atom mounted until the projection arrives. */
function loadThread(ref: ScopedThreadRef) {
  const atom = environmentThreadDetails.threadAtom(ref);
  return new Promise<EnvironmentThread | null>((resolve) => {
    let release = () => {};
    const timer = setTimeout(() => {
      release();
      resolve(appAtomRegistry.get(atom));
    }, 4000);
    release = appAtomRegistry.subscribe(
      atom,
      (value) => {
        if (value === null) return;
        clearTimeout(timer);
        queueMicrotask(release);
        resolve(value);
      },
      { immediate: true },
    );
  });
}

function messageText(
  projection: EnvironmentThread["projection"],
  item: { text: string; messageId: string; textOmitted?: unknown },
) {
  return item.textOmitted
    ? (projection.messages.find((message) => message.id === item.messageId)?.text ?? "")
    : item.text;
}

/** The agent's last reply in a thread, for announcing what it did. */
export async function lastAgentReply(ref: ScopedThreadRef) {
  const projection = (await loadThread(ref))?.projection;
  if (!projection) return "";
  for (const row of projection.visibleTurnItems.toReversed()) {
    if (row.item.type === "assistant_message") return messageText(projection, row.item).trim();
  }
  return "";
}

function liveApproval(projection: EnvironmentThread["projection"]) {
  return derivePendingThreadRequests(projection)
    .approvals.filter((approval) => approval.responseCapability === "live")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/** Binds the delegator's tools to one environment: the one the call started in. */
export function createBrowserHost(input: {
  router: AnyRouter;
  environmentId: EnvironmentId;
  watch: (ref: ScopedThreadRef) => void;
}): DelegatorHost {
  const { router, environmentId } = input;
  const refFor = (threadId: string) => scopeThreadRef(environmentId, threadId as never);
  const shellFor = (threadId: string) => {
    const shell = readThreadShell(refFor(threadId));
    if (!shell) throw new Error(`No thread with id ${threadId}. Use list_threads first.`);
    return shell;
  };
  const listed = () =>
    readThreadShells()
      .filter(
        (shell) =>
          shell.environmentId === environmentId &&
          shell.archivedAt === null &&
          isListedThreadLineage(shell.lineage),
      )
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    viewed: () => {
      const ref = readViewedThreadRef(router);
      if (!ref || ref.environmentId !== environmentId) return undefined;
      const shell = readThreadShell(ref);
      return shell ? describeThread(shell) : undefined;
    },
    listThreads: async (query, limit) =>
      rankThreads(listed().map(describeThread), query).slice(0, limit),
    readThread: async (threadId, limit) => {
      const shell = shellFor(threadId);
      const loaded = await loadThread(refFor(threadId));
      const projection = loaded?.projection;
      const messages: { role: string; text: string }[] = [];
      for (const row of projection?.visibleTurnItems ?? []) {
        const item = row.item;
        if (item.type !== "user_message" && item.type !== "assistant_message") continue;
        const text = projection ? messageText(projection, item) : "";
        if (text.trim())
          messages.push({
            role: item.type === "user_message" ? "user" : "agent",
            text: clip(text),
          });
      }
      if (messages.length === 0 && shell.source.latestVisibleMessage)
        messages.push({
          role: shell.source.latestVisibleMessage.role,
          text: clip(shell.source.latestVisibleMessage.text),
        });
      const approval = projection ? liveApproval(projection) : undefined;
      return {
        thread: describeThread(shell),
        messages: messages.slice(-limit),
        ...(approval
          ? {
              pendingApproval: {
                kind: approval.requestKind,
                detail: approval.detail ? clip(approval.detail) : undefined,
                reason: approval.reason,
              },
            }
          : {}),
      };
    },
    sendMessage: async (threadId, text, delivery) => {
      const shell = shellFor(threadId);
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.startTurn,
        {
          environmentId,
          input: {
            threadId: shell.id,
            message: { messageId: newMessageId(), role: "user", text, attachments: [] },
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            dispatchMode: delivery,
            createdAt: new Date().toISOString(),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return delivery === "queue" ? "queued" : "sent";
    },
    interrupt: async (threadId) => {
      const shell = shellFor(threadId);
      if (!shell.runtime?.activeRunId) return "not running";
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.interruptTurn,
        { environmentId, input: { threadId: shell.id } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return "stopped";
    },
    answerApproval: async (threadId, decision, feedback) => {
      const shell = shellFor(threadId);
      const projection = (await loadThread(refFor(threadId)))?.projection;
      const approval = projection ? liveApproval(projection) : undefined;
      if (!approval) return "nothing to approve";
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.respondToApproval,
        {
          environmentId,
          input: {
            threadId: shell.id,
            requestId: approval.requestId,
            decision,
            ...(feedback && approval.supportsFeedback ? { feedback } : {}),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return decision === "accept" ? "approved" : "declined";
    },
    openThread: async (threadId) => {
      shellFor(threadId);
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(refFor(threadId)),
      });
      return "opened";
    },
    respond: async (request) => {
      const prepared = readPreparedConnection(environmentId);
      if (!prepared) throw new Error("This environment isn't connected.");
      return runEnvironmentSpeech(grokVoiceRespond(prepared, request));
    },
    watch: (threadId) => input.watch(refFor(threadId)),
  };
}
