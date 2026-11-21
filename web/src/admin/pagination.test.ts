import { describe, expect, it } from "vitest";
import { appendPage, canLoadMore, emptyPaged } from "./pagination.ts";

const row = (n: number) => ({ id: `id-${n}`, cursor: `c${n}` });

describe("cursor pagination state", () => {
  it("starts empty and not loaded, so no 'Load more' is offered", () => {
    const s = emptyPaged<ReturnType<typeof row>>();
    expect(s).toEqual({ items: [], next: null, loaded: false });
    expect(canLoadMore(s)).toBe(false);
  });

  it("appends pages in order and keeps the cursor of the last one", () => {
    let s = appendPage(emptyPaged<ReturnType<typeof row>>(), { items: [row(1), row(2)], nextCursor: "c2" });
    expect(canLoadMore(s)).toBe(true);
    s = appendPage(s, { items: [row(3)], nextCursor: "c3" });
    expect(s.items.map((r) => r.id)).toEqual(["id-1", "id-2", "id-3"]);
    expect(s.next).toBe("c3");
  });

  it("does not add a row twice when pages overlap", () => {
    let s = appendPage(emptyPaged<ReturnType<typeof row>>(), { items: [row(1), row(2)], nextCursor: "c2" });
    s = appendPage(s, { items: [row(2), row(3)], nextCursor: "c3" });
    expect(s.items.map((r) => r.id)).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("stops when nextCursor is null", () => {
    let s = appendPage(emptyPaged<ReturnType<typeof row>>(), { items: [row(1)], nextCursor: "c1" });
    s = appendPage(s, { items: [row(2)], nextCursor: null });
    expect(s.next).toBeNull();
    expect(canLoadMore(s)).toBe(false);
  });

  it("is loaded after an empty first page, with nothing more to load", () => {
    const s = appendPage(emptyPaged<ReturnType<typeof row>>(), { items: [], nextCursor: null });
    expect(s.loaded).toBe(true);
    expect(canLoadMore(s)).toBe(false);
  });
});
