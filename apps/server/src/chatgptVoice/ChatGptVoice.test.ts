import { describe, expect, it } from "vite-plus/test";

import { codexTokenIdentity } from "./ChatGptVoice.ts";

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("codexTokenIdentity", () => {
  it("reads the ChatGPT account and expiry from a Codex token", () => {
    expect(
      codexTokenIdentity(
        jwt({
          exp: 1_800_000_000,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
      ),
    ).toEqual({ accountId: "acct-1", expiresAt: 1_800_000_000_000 });
  });

  it.each([
    ["no account", jwt({ exp: 1 })],
    ["not a JWT", "opaque"],
  ])("returns undefined for %s", (_name, token) => {
    expect(codexTokenIdentity(token)).toBeUndefined();
  });
});
