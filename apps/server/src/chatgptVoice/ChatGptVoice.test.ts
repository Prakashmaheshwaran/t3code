import { describe, expect, it } from "vite-plus/test";

import { parseCodexAuth } from "./ChatGptVoice.ts";

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("parseCodexAuth", () => {
  it("reads the ChatGPT login, taking the account from the token when the file omits it", () => {
    const access = jwt({
      exp: 1_800_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    });
    expect(
      parseCodexAuth(JSON.stringify({ tokens: { access_token: access, refresh_token: "r" } })),
    ).toEqual({ token: access, accountId: "acct-1", expiresAt: 1_800_000_000_000, refresh: "r" });
  });

  it.each([
    ["an API-key login", { OPENAI_API_KEY: "sk-x", tokens: null }],
    ["no account", { tokens: { access_token: jwt({}) } }],
  ])("returns undefined for %s", (_name, file) => {
    expect(parseCodexAuth(JSON.stringify(file))).toBeUndefined();
  });
});
