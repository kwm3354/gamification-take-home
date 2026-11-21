import { describe, expect, it } from "vitest";
import { backOfficeHash } from "./back-office-link.ts";
import { parseAdminHash } from "./admin/routes.ts";

describe("backOfficeHash", () => {
  it("opens the player page when the player id is known", () => {
    const route = parseAdminHash(backOfficeHash("t-alpha", "3f2a-uuid"));
    expect(route).toEqual({ section: "players", id: "3f2a-uuid", query: { tenant: "t-alpha" } });
  });

  it("opens the overview when there is no player yet", () => {
    const route = parseAdminHash(backOfficeHash("t-alpha", null));
    expect(route).toEqual({ section: "overview", id: null, query: { tenant: "t-alpha" } });
  });

  it("leaves the tenant out when it is not known", () => {
    expect(backOfficeHash("", null)).toBe("#/admin/overview");
  });
});
