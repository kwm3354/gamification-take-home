/**
 * Who may do what. The one place where roles are decided. Plain code.
 *
 * | Action        | tenant_viewer | tenant_admin | platform_admin |
 * | read          | own tenant    | own tenant   | any tenant     |
 * | resolve       | no            | own tenant   | any tenant     |
 * | propose_wheel | no            | own tenant   | any tenant     |
 * | decide_change | no            | no           | yes            |
 *
 * `read` is also the question "may this person see this tenant at all?". A no there is a 404
 * (so the existence of a tenant does not leak); a no on any other action is a 403.
 */
export type Role = "platform_admin" | "tenant_admin" | "tenant_viewer";
export type Action = "read" | "resolve" | "propose_wheel" | "decide_change";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
}

export function can(admin: AdminUser, action: Action, tenantId: string | null): boolean {
  if (action === "decide_change") return admin.role === "platform_admin";
  const sees = admin.role === "platform_admin" || (tenantId !== null && admin.tenantId === tenantId);
  if (!sees) return false;
  if (action === "read") return true;
  return admin.role === "platform_admin" || admin.role === "tenant_admin";
}
