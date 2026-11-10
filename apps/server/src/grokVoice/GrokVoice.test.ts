import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { parseGrokAuth } from "./GrokVoice.ts";

describe("parseGrokAuth", () => {
  it("picks the credential that expires last", () => {
    const login = parseGrokAuth(
      JSON.stringify({
        "https://auth.x.ai::old": { key: "old-token", expires_at: "2026-01-01T00:00:00Z" },
        "https://auth.x.ai::new": {
          key: "new-token",
          auth_mode: "oidc",
          expires_at: "2026-11-10T11:07:22.898220Z",
        },
      }),
    );
    expect(login && Redacted.value(login.token)).toBe("new-token");
    expect(login?.expiresAt).toBe(Date.parse("2026-11-10T11:07:22.898220Z"));
  });

  it("treats a key without an expiry as long-lived", () => {
    expect(parseGrokAuth(JSON.stringify({ a: { key: "k" } }))?.expiresAt).toBe(Infinity);
  });

  it.each([["not json"], ["[]"], [JSON.stringify({ a: { key: "" } })], [JSON.stringify({})]])(
    "returns undefined for an unusable file: %s",
    (text) => {
      expect(parseGrokAuth(text)).toBeUndefined();
    },
  );
});
