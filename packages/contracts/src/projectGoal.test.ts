import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import {
  ProjectGoalReport,
  ProjectGoalUpsertInput,
  projectGoalIdForProject,
} from "./projectGoal.ts";

const isProjectGoalUpsert = Schema.is(ProjectGoalUpsertInput);

describe("project goals", () => {
  it("derives one stable id per project", () => {
    const projectId = ProjectId.make("project-1");
    expect(projectGoalIdForProject(projectId)).toBe("goal:project-1");
    expect(projectGoalIdForProject(projectId)).toBe(projectGoalIdForProject(projectId));
  });

  it("requires the objective, project, and model on save", () => {
    const decode = Schema.decodeUnknownExit(ProjectGoalUpsertInput);
    const base = {
      projectId: "project-1",
      objective: "Ship billing",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    };

    expect(isProjectGoalUpsert(base)).toBe(true);
    expect(isProjectGoalUpsert({ ...base, objective: "   " })).toBe(false);
    expect(isProjectGoalUpsert({ ...base, projectId: "" })).toBe(false);
    expect(decode({ ...base, modelSelection: { instanceId: "codex" } })._tag).toBe("Failure");
  });

  it("accepts the three report outcomes and rejects an unknown one", () => {
    const decode = Schema.decodeUnknownExit(ProjectGoalReport);
    for (const status of ["continue", "achieved", "blocked"] as const) {
      expect(decode({ status, summary: "Worked" })._tag).toBe("Success");
    }
    expect(decode({ status: "done", summary: "Worked" })._tag).toBe("Failure");
    expect(decode({ status: "continue" })._tag).toBe("Failure");
  });
});
