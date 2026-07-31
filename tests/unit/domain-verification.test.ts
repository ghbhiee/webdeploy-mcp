import { describe, expect, it } from "vitest";
import { addressSetsOverlap } from "../../packages/core/src/projects";

describe("Domain DNS verification", () => {
  it("verifies when the domain shares an address with the platform host", () => {
    expect(addressSetsOverlap(["202.91.34.98"], ["202.91.34.98"])).toBe(true);
    expect(addressSetsOverlap(["1.2.3.4", "202.91.34.98"], ["202.91.34.98"])).toBe(true);
  });

  it("rejects when addresses differ or the domain does not resolve", () => {
    expect(addressSetsOverlap(["1.2.3.4"], ["202.91.34.98"])).toBe(false);
    expect(addressSetsOverlap([], ["202.91.34.98"])).toBe(false);
    expect(addressSetsOverlap(["202.91.34.98"], [])).toBe(false);
  });
});
