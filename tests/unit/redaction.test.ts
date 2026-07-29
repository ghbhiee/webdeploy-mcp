import { describe, expect, it } from "vitest";
import { redactObject, redactText } from "../../packages/core/src/redaction";

describe("log redaction", () => {
  it("removes bearer tokens, secret assignments, and known values", () => {
    const output = redactText(
      "Authorization: Bearer abc.def.ghi API_TOKEN=supersecret custom-value",
      ["custom-value"],
    );
    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("supersecret");
    expect(output).not.toContain("custom-value");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts sensitive object keys recursively", () => {
    expect(
      redactObject({ project: "safe", nested: { cookie: "bad", count: 2 }, apiKey: "bad" }),
    ).toEqual({
      project: "safe",
      nested: { cookie: "[REDACTED]", count: 2 },
      apiKey: "[REDACTED]",
    });
  });
});
