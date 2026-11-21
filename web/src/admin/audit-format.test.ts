import { describe, expect, it } from "vitest";
import { changeLines } from "./audit-format.ts";

describe("audit change lines", () => {
  it("writes field: from -> to for a map of changes", () => {
    expect(
      changeLines({ status: { from: "submitting", to: "issued" }, platformRef: { from: null, to: "manual" } }),
    ).toEqual(["status: submitting -> issued", "platformRef: null -> manual"]);
  });

  it("accepts a list of changes", () => {
    expect(changeLines([{ field: "status", from: "created", to: "reserved" }])).toEqual([
      "status: created -> reserved",
    ]);
  });

  it("shows other facts as key: value lines and anything else as text", () => {
    expect(changeLines({ outcome: "issued", note: "ok" })).toEqual(["outcome: issued", "note: ok"]);
    expect(changeLines(null)).toEqual([]);
    expect(changeLines("text")).toEqual(["text"]);
  });
});
