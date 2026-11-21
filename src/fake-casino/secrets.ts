import type { DemoTenant } from "../tenants/demo-tenants.ts";

/**
 * The secrets the fake casino currently signs with, when they differ from the demo file. This stands
 * for "the casino's engineer pastes the new key into the casino's configuration". Per fake casino
 * process; the shared demo data is never changed.
 */
export class SecretOverrides {
  private readonly byTenant = new Map<string, { webhookSecret?: string; tokenSecret?: string }>();

  set(tenantId: string, secrets: { webhookSecret?: string; tokenSecret?: string }): void {
    this.byTenant.set(tenantId, { ...this.byTenant.get(tenantId), ...secrets });
  }

  /** The tenant as this casino knows it now. */
  apply(tenant: DemoTenant): DemoTenant {
    return { ...tenant, ...this.byTenant.get(tenant.id) };
  }
}

/** Validates the body of `PUT /control/tenants/:tenantId/secrets`. Returns an error text or the secrets. */
export function parseSecretsBody(body: unknown): string | { webhookSecret?: string; tokenSecret?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const out: { webhookSecret?: string; tokenSecret?: string } = {};
  for (const key of ["webhookSecret", "tokenSecret"] as const) {
    const v = b[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length < 8) return `${key} must be a string of at least 8 characters`;
    out[key] = v;
  }
  if (out.webhookSecret === undefined && out.tokenSecret === undefined) {
    return "webhookSecret or tokenSecret is required";
  }
  return out;
}
