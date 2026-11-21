/** Hash routes of the back office. A route and its filters are a link that can be shared and reloaded. */

export const SECTIONS = [
  "overview",
  "alerts",
  "redemptions",
  "stuck",
  "players",
  "events",
  "spins",
  "settings",
  "changes",
  "outbox",
  "audit",
] as const;

export type Section = (typeof SECTIONS)[number];

/** Sections whose rows open a detail page at `#/admin/<section>/<id>`. */
const WITH_DETAIL: ReadonlySet<Section> = new Set(["redemptions", "players", "events"]);

export interface AdminRoute {
  section: Section;
  id: string | null;
  query: Record<string, string>;
}

const PREFIX = "#/admin";

export function isAdminHash(hash: string): boolean {
  return hash === PREFIX || hash.startsWith(`${PREFIX}/`) || hash.startsWith(`${PREFIX}?`);
}

/** Parses a hash. `#/admin` alone is the overview. Returns null for an unknown section or extra segments. */
export function parseAdminHash(hash: string): AdminRoute | null {
  if (!isAdminHash(hash)) return null;
  const rest = hash.slice(PREFIX.length);
  const q = rest.indexOf("?");
  const pathPart = q === -1 ? rest : rest.slice(0, q);
  const queryPart = q === -1 ? "" : rest.slice(q + 1);
  const segments = pathPart.split("/").filter((x) => x !== "");
  const name = segments[0] ?? "overview";
  const section = SECTIONS.find((s) => s === name);
  if (!section || segments.length > 2) return null;
  const rawId = segments[1];
  if (rawId !== undefined && !WITH_DETAIL.has(section)) return null;
  let id: string | null = null;
  if (rawId !== undefined) {
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return null;
    }
  }
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(queryPart)) if (v !== "") query[k] = v;
  return { section, id, query };
}

/** The hash for a route. Empty filter values are left out. */
export function buildAdminHash(route: {
  section: Section;
  id?: string | null;
  query?: Record<string, string>;
}): string {
  let hash = `${PREFIX}/${route.section}`;
  if (route.id) hash += `/${encodeURIComponent(route.id)}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(route.query ?? {})) if (v !== "") params.set(k, v);
  const text = params.toString();
  return text ? `${hash}?${text}` : hash;
}
