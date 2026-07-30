import { describe, expect, it } from "vitest";
import { isAllowedClientRedirectUri } from "../../apps/control-plane/src/oauth";

describe("client metadata redirect URIs", () => {
  it.each([
    "https://claude.ai/oauth/callback",
    "http://localhost:3118/callback",
    "http://127.0.0.1:33418/callback",
    "http://[::1]:8080/callback",
  ])("allows %s", (uri) => expect(isAllowedClientRedirectUri(uri)).toBe(true));

  it.each([
    "http://evil.example/callback",
    "http://192.168.1.10/callback",
    "http://localhost.evil.example/callback",
    "ftp://localhost/callback",
    "not-a-url",
  ])("rejects %s", (uri) => expect(isAllowedClientRedirectUri(uri)).toBe(false));
});
