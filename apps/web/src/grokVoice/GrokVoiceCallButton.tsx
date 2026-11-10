import { PhoneIcon, PhoneOffIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toggleGrokVoiceCall, useGrokVoiceStore } from "./call";

/** Starts or ends a Grok voice call from the composer, where touch devices can reach it. */
export function GrokVoiceCallButton(props: { readonly shortcutLabel: string | null }) {
  const inCall = useGrokVoiceStore((state) => state.status !== "idle");
  const label = inCall ? "End voice call" : "Start voice call";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={inCall}
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleGrokVoiceCall}
            className="shrink-0"
          >
            {inCall ? <PhoneOffIcon /> : <PhoneIcon />}
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
