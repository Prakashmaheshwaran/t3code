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
  setGrokVoice,
  setVoiceProvider,
  useGrokVoiceStore,
  type VoiceProvider,
} from "./call";

const PROVIDER_HELP: Record<VoiceProvider, string> = {
  grok: "Uses the Grok CLI's sign-in on this computer (run `grok`). Calls count against your Grok plan.",
  chatgpt:
    "Uses the Codex CLI's ChatGPT sign-in on this computer (run `codex login`) and your plan's voice allowance. Unofficial: it relies on the same private service the Codex app uses.",
};

/** Which realtime voice the call button starts, and how it sounds. */
export function VoiceCallSettings() {
  const { provider, voice } = useGrokVoiceStore(
    useShallow((state) => ({ provider: state.provider, voice: state.voice })),
  );
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
    </SettingsSection>
  );
}
