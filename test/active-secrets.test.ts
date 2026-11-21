import { describe, expect, test } from "vitest";
import { activeSecrets } from "../src/tenants/active-secrets.ts";

const now = new Date("2026-11-21T10:00:00Z");
const later = new Date("2026-11-21T11:00:00Z");
const earlier = new Date("2026-11-21T09:00:00Z");

describe("activeSecrets (plain code)", () => {
  test("no previous secret: only the current one", () => {
    expect(activeSecrets("new", null, null, now)).toEqual(["new"]);
  });
  test("previous secret before its time: both, current first", () => {
    expect(activeSecrets("new", "old", later, now)).toEqual(["new", "old"]);
  });
  test("previous secret after its time: only the current one", () => {
    expect(activeSecrets("new", "old", earlier, now)).toEqual(["new"]);
  });
  test("the end time itself is already too late", () => {
    expect(activeSecrets("new", "old", now, now)).toEqual(["new"]);
  });
  test("a previous secret with no end time is not valid", () => {
    expect(activeSecrets("new", "old", null, now)).toEqual(["new"]);
  });
  test("an end time with no previous secret gives only the current one", () => {
    expect(activeSecrets("new", null, later, now)).toEqual(["new"]);
  });
});
