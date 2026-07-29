import { describe, expect, it } from "vitest";
import { requireAdmin, requireProjectAccess } from "../../packages/core/src/authorization";

const owner = { id: "owner", username: "owner", isAdmin: false, status: "active" as const };
const admin = { id: "admin", username: "admin", isAdmin: true, status: "active" as const };

describe("authorization", () => {
  it("allows only owners and administrators to access projects", () => {
    expect(() => requireProjectAccess(owner, "owner")).not.toThrow();
    expect(() => requireProjectAccess(admin, "someone")).not.toThrow();
    expect(() => requireProjectAccess(owner, "someone")).toThrow(/access/i);
  });

  it("requires an active administrator", () => {
    expect(() => requireAdmin(admin)).not.toThrow();
    expect(() => requireAdmin(owner)).toThrow(/administrator/i);
    expect(() => requireAdmin({ ...admin, status: "disabled" as const })).toThrow(/not active/i);
  });
});
