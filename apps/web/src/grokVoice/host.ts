// What a Grok voice call needs from this client's own state: the thread on screen, thread
// status for announcements, and an agent's last reply. Everything else runs on the server.

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails, environmentThreadShells } from "../state/threads";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";

export function readViewedThreadRef(router: AnyRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  return resolveActiveThreadRouteRef(target, draft);
}

export function threadStatus(shell: EnvironmentThreadShell) {
  const status = resolveSidebarThreadStatus(shell);
  return status === "ready" && shell.latestRun?.status === "failed" ? "failed" : status;
}

/** Waits for a just-launched thread to reach this client; an unknown thread id routes to a draft. */
export async function openThread(
  router: AnyRouter,
  environmentId: EnvironmentId,
  threadId: string,
) {
  const ref = scopeThreadRef(environmentId, threadId as never);
  const shellAtom = environmentThreadShells.threadShellAtom(ref);
  const known = await new Promise<boolean>((resolve) => {
    if (appAtomRegistry.get(shellAtom)) return resolve(true);
    let release = () => {};
    const timer = setTimeout(() => {
      release();
      resolve(false);
    }, 8000);
    release = appAtomRegistry.subscribe(shellAtom, (shell) => {
      if (!shell) return;
      clearTimeout(timer);
      queueMicrotask(release);
      resolve(true);
    });
  });
  if (!known) return false;
  await router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  return true;
}

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

/** The agent's last reply in a thread, for announcing what it did. */
export async function lastAgentReply(ref: ScopedThreadRef) {
  const projection = (await loadThread(ref))?.projection;
  if (!projection) return "";
  for (const row of projection.visibleTurnItems.toReversed()) {
    const item = row.item;
    if (item.type !== "assistant_message") continue;
    const text = item.textOmitted
      ? (projection.messages.find((message) => message.id === item.messageId)?.text ?? "")
      : item.text;
    if (text.trim()) return text.trim();
  }
  return "";
}
