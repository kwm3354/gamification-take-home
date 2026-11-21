import { describe, expect, it } from "vitest";
import { type Action, type Role, can, canSee } from "./roles.ts";
import { SECTIONS } from "./routes.ts";

// The table of "Admin sign-in and roles" in docs/contracts.md, row by row.
const TABLE: Record<Action, Record<Role, boolean>> = {
  read: { tenant_viewer: true, tenant_admin: true, platform_admin: true },
  resolve: { tenant_viewer: false, tenant_admin: true, platform_admin: true },
  propose: { tenant_viewer: false, tenant_admin: true, platform_admin: true },
  decide: { tenant_viewer: false, tenant_admin: false, platform_admin: true },
  see_other_tenant: { tenant_viewer: false, tenant_admin: false, platform_admin: true },
  manage_keys: { tenant_viewer: false, tenant_admin: true, platform_admin: true },
};

describe("roles", () => {
  for (const [action, row] of Object.entries(TABLE) as [Action, Record<Role, boolean>][]) {
    for (const [role, allowed] of Object.entries(row) as [Role, boolean][]) {
      it(`${role} ${allowed ? "can" : "cannot"} ${action}`, () => {
        expect(can(role, action)).toBe(allowed);
      });
    }
  }

  it("shows the waiting changes of all tenants to the platform admin only", () => {
    expect(canSee("platform_admin", "changes")).toBe(true);
    expect(canSee("tenant_admin", "changes")).toBe(false);
    expect(canSee("tenant_viewer", "changes")).toBe(false);
  });

  it("shows every other section to every role", () => {
    for (const section of SECTIONS.filter((s) => s !== "changes")) {
      for (const role of ["platform_admin", "tenant_admin", "tenant_viewer"] as const) {
        expect(canSee(role, section)).toBe(true);
      }
    }
  });
});
