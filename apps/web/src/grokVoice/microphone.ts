import { getClientSettings } from "../hooks/useSettings";

const VOICE_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** The microphone chosen in Settings → Voice, falling back to the system default if it's gone. */
export async function openCallMicrophone() {
  const deviceId = getClientSettings().voiceMicrophone;
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...VOICE_CONSTRAINTS, deviceId: { exact: deviceId } },
      });
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "OverconstrainedError") throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: VOICE_CONSTRAINTS });
}

const SILENCE_WARNING_MS = 8000;

/** Names the microphone in use, and says so once if it stays silent. */
export function watchMicrophone(stream: MediaStream, note: (text: string) => void) {
  const label = stream.getAudioTracks()[0]?.label || "the default microphone";
  note(`Listening on ${label}.`);
  const startedAt = Date.now();
  let heard = false;
  let warned = false;
  return (level: number) => {
    if (level > 0.02) heard = true;
    else if (!heard && !warned && Date.now() - startedAt > SILENCE_WARNING_MS) {
      warned = true;
      note(
        `No sound from ${label} yet. Pick the right microphone in Settings → Voice, or check it isn't muted.`,
      );
    }
  };
}
