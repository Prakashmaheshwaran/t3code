import { type OrchestrationV2ThreadProjection, ProjectGoalReport } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** The fence an orchestrator session ends with. Kept short so it survives long transcripts. */
export const PROJECT_GOAL_REPORT_FENCE = "t3-orchestrator";

const decodeReportJson = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectGoalReport));

/**
 * Reads the last report block a session wrote. Sessions may quote earlier reports, so the last
 * valid block wins. A malformed block is ignored rather than treated as a report.
 */
export function parseProjectGoalReport(text: string): ProjectGoalReport | null {
  const blocks = [
    ...text.matchAll(
      new RegExp("```" + PROJECT_GOAL_REPORT_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "giu"),
    ),
  ];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const decoded = decodeReportJson(blocks[index]?.[1]?.trim() ?? "");
    if (decoded._tag === "Some") return decoded.value;
  }
  return null;
}

/** The last assistant message, without streaming placeholders. */
export function lastAssistantMessage(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
): string | null {
  let latest: { text: string; at: number } | null = null;
  for (const message of projection.messages) {
    if (message.role !== "assistant" || message.streaming || message.text.trim() === "") continue;
    const at = DateTime.toEpochMillis(message.updatedAt);
    if (latest === null || at >= latest.at) latest = { text: message.text, at };
  }
  return latest?.text ?? null;
}
