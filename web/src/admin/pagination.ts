/** State of a list read page by page with `nextCursor`. */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Paged<T> {
  items: T[];
  /** The cursor to send as `before`; null when there is nothing more. */
  next: string | null;
  /** False until the first page has arrived. */
  loaded: boolean;
}

export function emptyPaged<T>(): Paged<T> {
  return { items: [], next: null, loaded: false };
}

/** Adds a page. A row already present (same cursor) is not added again. */
export function appendPage<T extends { cursor: string }>(state: Paged<T>, page: Page<T>): Paged<T> {
  const seen = new Set(state.items.map((x) => x.cursor));
  const fresh = page.items.filter((x) => !seen.has(x.cursor));
  return { items: [...state.items, ...fresh], next: page.nextCursor, loaded: true };
}

export function canLoadMore<T>(state: Paged<T>): boolean {
  return state.loaded && state.next !== null;
}
