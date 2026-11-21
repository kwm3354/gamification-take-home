import { describe, expect, it } from "vitest";
import { SECTIONS, buildAdminHash, isAdminHash, parseAdminHash } from "./routes.ts";

describe("admin routes", () => {
  it("reads #/admin alone as the overview", () => {
    expect(parseAdminHash("#/admin")).toEqual({ section: "overview", id: null, query: {} });
    expect(parseAdminHash("#/admin/")).toEqual({ section: "overview", id: null, query: {} });
  });

  it("parses and rebuilds every section", () => {
    for (const section of SECTIONS) {
      const hash = `#/admin/${section}`;
      expect(parseAdminHash(hash)).toEqual({ section, id: null, query: {} });
      expect(buildAdminHash({ section })).toBe(hash);
    }
  });

  it("parses and rebuilds the detail routes", () => {
    for (const section of ["redemptions", "players", "events"] as const) {
      const hash = `#/admin/${section}/3f2a9c10-aaaa-bbbb-cccc-1234567890ab`;
      const route = parseAdminHash(hash);
      expect(route).toEqual({ section, id: "3f2a9c10-aaaa-bbbb-cccc-1234567890ab", query: {} });
      expect(buildAdminHash({ section, id: route?.id ?? null })).toBe(hash);
    }
  });

  it("keeps filters in the hash query and round-trips them", () => {
    const route = parseAdminHash("#/admin/redemptions?status=submitting&playerId=p%201");
    expect(route).toEqual({
      section: "redemptions",
      id: null,
      query: { status: "submitting", playerId: "p 1" },
    });
    expect(buildAdminHash(route ?? { section: "overview" })).toBe(
      "#/admin/redemptions?status=submitting&playerId=p+1",
    );
  });

  it("drops empty filter values", () => {
    expect(buildAdminHash({ section: "spins", query: { status: "", playerId: "x" } })).toBe(
      "#/admin/spins?playerId=x",
    );
    expect(parseAdminHash("#/admin/spins?status=")?.query).toEqual({});
  });

  it("rejects unknown sections, details on sections without one, and extra segments", () => {
    expect(parseAdminHash("#/admin/nothing")).toBeNull();
    expect(parseAdminHash("#/admin/spins/abc")).toBeNull();
    expect(parseAdminHash("#/admin/redemptions/a/b")).toBeNull();
    expect(parseAdminHash("#/admin/redemptions/%E0%A4%A")).toBeNull();
  });

  it("tells admin hashes from the player page", () => {
    expect(isAdminHash("#/admin/alerts")).toBe(true);
    expect(isAdminHash("#/admin?x=1")).toBe(true);
    expect(isAdminHash("#/play")).toBe(false);
    expect(isAdminHash("#/administrator")).toBe(false);
    expect(parseAdminHash("#/play")).toBeNull();
  });
});
