import { buildAdminHash } from "./admin/routes.ts";

/**
 * The back office page for the player on screen. Before the player exists on our side there is no id,
 * so the link goes to the tenant's overview. `tenant` is read by the back office for a platform admin.
 */
export function backOfficeHash(tenantId: string, playerId: string | null): string {
  const query = { tenant: tenantId };
  return playerId
    ? buildAdminHash({ section: "players", id: playerId, query })
    : buildAdminHash({ section: "overview", query });
}
