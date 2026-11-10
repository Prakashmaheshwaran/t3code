import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  VOICE_PROVIDERS,
  loadChatGptModels,
  setDelegatorModel,
  setGrokVoice,
  setVoiceProvider,
  useGrokVoiceStore,
  type VoiceProvider,
} from "./call";

const PROVIDER_HELP: Record<VoiceProvider, string> = {
  grok: "Uses the Grok CLI's sign-in on this computer (run `grok`). Calls count against your Grok plan.",
  chatgpt:
    "Runs through the Codex CLI's app-server with its ChatGPT sign-in (run `codex login`) and your plan's voice allowance. Unofficial: Codex's voice service isn't a public API.",
};

const SERVER_DEFAULT = "__default__";

/** Which realtime voice the call button starts, how it sounds, and what it thinks with. */
export function VoiceCallSettings() {
  const { provider, voice, delegatorModel, models, defaultModel, modelsError } = useGrokVoiceStore(
    useShallow((state) => ({
      provider: state.provider,
      voice: state.voice,
      delegatorModel: state.delegatorModel,
      models: state.chatgptModels,
      defaultModel: state.chatgptDefaultModel,
      modelsError: state.chatgptModelsError,
    })),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the model list lives on the environment's Codex login
  useEffect(() => {
    if (provider === "chatgpt" && models === null) void loadChatGptModels();
  }, [provider, models]);

  const modelName = (id: string | null) =>
    models?.find((model) => model.id === id)?.name ?? id ?? "Loading…";

  return (
    <SettingsSection id="voice-calls" title="Voice calls">
      <SettingsRow
        title="Provider"
        description={PROVIDER_HELP[provider]}
        control={
          <Select
            value={provider}
            onValueChange={(value) => {
              if (value === "grok" || value === "chatgpt") setVoiceProvider(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Voice call provider">
              <SelectValue>{VOICE_PROVIDERS[provider].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(VOICE_PROVIDERS) as VoiceProvider[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {VOICE_PROVIDERS[id].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Voice"
        description="Applies to your next call."
        control={
          <Select
            value={voice}
            onValueChange={(value) => {
              if (typeof value === "string") setGrokVoice(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Voice">
              <SelectValue>{voice}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_PROVIDERS[provider].voices.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {provider === "chatgpt" ? (
        <SettingsRow
          title="Thinking model"
          description={
            modelsError ??
            "The Codex model that finds threads, sends work, and answers approvals during a call. Uses your ChatGPT plan, not the voice allowance."
          }
          control={
            <Select
              value={delegatorModel ?? SERVER_DEFAULT}
              onValueChange={(value) => {
                if (typeof value === "string")
                  setDelegatorModel(value === SERVER_DEFAULT ? null : value);
              }}
            >
              <SelectTrigger size="sm" aria-label="Thinking model">
                <SelectValue>
                  {delegatorModel
                    ? modelName(delegatorModel)
                    : `Default (${modelName(defaultModel)})`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={SERVER_DEFAULT}>Default ({modelName(defaultModel)})</SelectItem>
                {(models ?? []).map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
