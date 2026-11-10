import { supabaseAdmin } from "../../db/client";

/** Pages inside the admin portal's menus that a platform role can be kept out of. */
export const PAGES: { key: string; area: string; label: string }[] = [
  { key: "schools.applications", area: "schools", label: "School applications" },
  { key: "schools.approval", area: "schools", label: "Approving schools" },
  { key: "schools.campuses", area: "schools", label: "Campuses" },
  { key: "schools.documents", area: "schools", label: "School documents" },
  { key: "schools.admins", area: "schools", label: "School admin accounts" },
  { key: "subscriptions.renewals", area: "subscriptions", label: "Renewals and renewal invoices" },
  { key: "subscriptions.discounts", area: "subscriptions", label: "Coupons, offers and special pricing" },
  { key: "subscriptions.billing_rules", area: "subscriptions", label: "Billing rules" },
  { key: "modules.config", area: "modules", label: "Dependencies and feature flags" },
  { key: "modules.pricing", area: "modules", label: "Module pricing and bundles" },
  { key: "modules.releases", area: "modules", label: "Module releases" },
  { key: "users.login_activity", area: "users", label: "Login activity and sessions" },
  { key: "users.student_accounts", area: "users", label: "Student accounts" },
  { key: "users.parent_accounts", area: "users", label: "Parent accounts" },
];

/** Which restrictable page a request belongs to, or null. `parts` is the path split on "/". */
export function pageKeyFor(parts: string[]): string | null {
  const [a, b, c] = parts;
  if (a === "applications") return "schools.applications";
  if (a === "campuses") return "schools.campuses";
  if (a === "schools") {
    if (c === "approve") return "schools.approval";
    if (c === "documents") return "schools.documents";
    if (c === "admins" || c === "primary-admin" || c === "admin-access") return "schools.admins";
  }
  if (a === "subscriptions") {
    if (b === "renewals" || (b === "schools" && (parts[3] === "renew" || parts[3] === "renewal-preview"))) return "subscriptions.renewals";
    if (b === "coupons" || b === "offers" || b === "special-pricing") return "subscriptions.discounts";
    if (b === "billing-settings") return "subscriptions.billing_rules";
  }
  if (a === "module-config") {
    if (b === "dependencies" || b === "flags") return "modules.config";
    if (b === "pricing" || b === "bundles") return "modules.pricing";
    if (b === "releases") return "modules.releases";
  }
  if (a === "login-activity") return "users.login_activity";
  if (a === "student-accounts") return "users.student_accounts";
  if (a === "parent-accounts") return "users.parent_accounts";
  return null;
}

const cache = new Map<string, { at: number; denied: Set<string> }>();
const TTL_MS = 30_000;

export async function deniedPages(roleId: string): Promise<Set<string>> {
  const hit = cache.get(roleId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.denied;
  const { data } = await supabaseAdmin.from("role_page_denials").select("page_key").eq("role_id", roleId);
  const denied = new Set(((data ?? []) as { page_key: string }[]).map((r) => r.page_key));
  cache.set(roleId, { at: Date.now(), denied });
  return denied;
}

export function clearPageCache(): void {
  cache.clear();
}
