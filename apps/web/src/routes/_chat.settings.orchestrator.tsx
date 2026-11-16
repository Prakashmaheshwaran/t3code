import { createFileRoute } from "@tanstack/react-router";

import { ProjectGoalsSettings } from "../components/settings/ProjectGoalsSettings";

export const Route = createFileRoute("/_chat/settings/orchestrator")({
  component: SettingsOrchestratorRoute,
});

function SettingsOrchestratorRoute() {
  return <ProjectGoalsSettings />;
}
