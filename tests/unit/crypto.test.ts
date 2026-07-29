import { describe, expect, it } from "vitest";
import {
  decryptValue,
  encryptValue,
  hashToken,
  randomToken,
  safeTokenEqual,
} from "../../packages/core/src/crypto";

describe("secret storage", () => {
  it("encrypts with unique nonces and authenticates ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const first = encryptValue("private-value", key);
    const second = encryptValue("private-value", key);
    expect(first.ciphertext.equals(Buffer.from("private-value"))).toBe(false);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(decryptValue(first, key)).toBe("private-value");
    first.authTag[0] ^= 1;
    expect(() => decryptValue(first, key)).toThrow();
  });

  it("hashes session tokens and compares without plaintext storage", () => {
    const token = randomToken();
    const digest = hashToken(token);
    expect(digest).not.toContain(token);
    expect(safeTokenEqual(digest, token)).toBe(true);
    expect(safeTokenEqual(digest, `${token}x`)).toBe(false);
  });
});
