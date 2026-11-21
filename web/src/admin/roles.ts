import type { Section } from "./routes.ts";

export type Role = "platform_admin" | "tenant_admin" | "tenant_viewer";

export type Action = "read" | "resolve" | "propose" | "decide" | "see_other_tenant";

/** A courtesy copy of the server's table in docs/contracts.md. The server is the authority. */
const ALLOWED: Record<Action, readonly Role[]> = {
  read: ["tenant_viewer", "tenant_admin", "platform_admin"],
  resolve: ["tenant_admin", "platform_admin"],
  propose: ["tenant_admin", "platform_admin"],
  decide: ["platform_admin"],
  see_other_tenant: ["platform_admin"],
};

export function can(role: Role, action: Action): boolean {
  return ALLOWED[action].includes(role);
}

/** The menu items a role sees. "changes" (all tenants' waiting changes) is for the platform team only. */
export function canSee(role: Role, section: Section): boolean {
  return section === "changes" ? can(role, "decide") : can(role, "read");
}

export function roleLabel(role: Role): string {
  switch (role) {
    case "platform_admin":
      return "Platform admin";
    case "tenant_admin":
      return "Tenant admin";
    case "tenant_viewer":
      return "Tenant viewer";
  }
}
