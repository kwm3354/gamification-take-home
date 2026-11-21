/** Plain text for audit `changes`, and for values whose exact shape the page does not rely on. */

function isFromTo(v: unknown): v is { from: unknown; to: unknown } {
  return typeof v === "object" && v !== null && "from" in v && "to" in v;
}

/** One value on one line. */
export function plain(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The lines `field: from -> to` of an audit row. Accepts `{ field: { from, to } }` and
 * `[{ field, from, to }]`. Anything else is shown as `key: value` lines or one line of text.
 */
export function changeLines(changes: unknown): string[] {
  if (changes === null || changes === undefined) return [];
  if (Array.isArray(changes) && changes.every((c) => typeof c === "object" && c !== null && "field" in c)) {
    return changes.map(
      (c: { field: unknown; from?: unknown; to?: unknown }) => `${plain(c.field)}: ${plain(c.from)} -> ${plain(c.to)}`,
    );
  }
  if (typeof changes === "object" && !Array.isArray(changes)) {
    const entries = Object.entries(changes as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([, v]) => isFromTo(v))) {
      return entries.map(
        ([k, v]) => `${k}: ${plain((v as { from: unknown }).from)} -> ${plain((v as { to: unknown }).to)}`,
      );
    }
    return entries.map(([k, v]) => `${k}: ${plain(v)}`);
  }
  return [plain(changes)];
}
