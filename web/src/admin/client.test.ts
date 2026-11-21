import { describe, expect, it } from "vitest";
import { toCallRecord } from "./client.ts";

describe("call record for the Requests panel", () => {
  it("keeps method, path, status and time, and nothing else", () => {
    const record = toCallRecord(
      {
        at: 5,
        actor: "admin -> us",
        method: "POST",
        url: "/admin/auth/login",
        status: 200,
        durationMs: 12,
        requestHeaders: { Authorization: "Bearer secret-token" },
        requestBody: '{"email":"a@b.c","password":"secret-password"}',
        responseBody: '{"token":"secret-token"}',
        error: null,
        tag: null,
      },
      1,
    );
    expect(record).toEqual({ id: 1, at: 5, method: "POST", path: "/admin/auth/login", status: 200, ms: 12 });
    expect(JSON.stringify(record)).not.toMatch(/secret/);
  });

  it("reduces a full URL to path and query", () => {
    const record = toCallRecord(
      {
        at: 0,
        actor: "admin -> us",
        method: "GET",
        url: "http://x:1/admin/t/redemptions?status=issued",
        status: null,
        durationMs: 0,
        requestHeaders: {},
        requestBody: null,
        responseBody: null,
        error: "x",
        tag: null,
      },
      2,
    );
    expect(record.path).toBe("/admin/t/redemptions?status=issued");
    expect(record.status).toBeNull();
  });
});
