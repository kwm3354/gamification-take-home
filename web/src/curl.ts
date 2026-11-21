import type { LogEntry } from "./types.ts";

const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** A curl command that repeats the logged call. */
export function toCurl(entry: LogEntry): string {
  const parts = ["curl", "-s", "-i", "-X", entry.method, quote(entry.url)];
  for (const [name, value] of Object.entries(entry.requestHeaders)) {
    parts.push("-H", quote(`${name}: ${value}`));
  }
  if (entry.requestBody !== null) parts.push("-d", quote(entry.requestBody));
  return parts.join(" ");
}
