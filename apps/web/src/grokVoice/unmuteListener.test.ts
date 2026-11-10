import { describe, expect, it } from "vite-plus/test";

import { isMuteCommand, mentionsUnmute } from "./unmuteListener";

describe("voice mute commands", () => {
  it.each([
    "Mute.",
    "mute yourself",
    "Okay, mute.",
    "Go on mute",
    "please mute the mic",
    "Stop listening.",
    "Mute, mute.",
    "can you mute",
    "mute now please",
  ])("mutes on %j", (text) => expect(isMuteCommand(text)).toBe(true));

  it.each([
    "Can you mute the notifications in the settings thread?",
    "unmute",
    "minute",
    "",
    "I am on mute",
    "the mute button is broken",
  ])("ignores %j", (text) => expect(isMuteCommand(text)).toBe(false));

  it.each(["unmute", "Un-mute please", "okay un mute"])("hears unmute in %j", (text) =>
    expect(mentionsUnmute(text)).toBe(true),
  );

  it.each(["mute", "minute", "commute"])("does not hear unmute in %j", (text) =>
    expect(mentionsUnmute(text)).toBe(false),
  );
});
