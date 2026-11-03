import { supabaseAdmin } from "../../db/client";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; codes: string[] }>();

/** Permission codes granted to a role (cached briefly; cleared when an admin edits a role). */
export async function getRolePermissions(roleId: string): Promise<string[]> {
  const hit = cache.get(roleId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.codes;

  const { data, error } = await supabaseAdmin
    .from("role_permissions")
    .select("permissions(code)")
    .eq("role_id", roleId);
  if (error) throw new Error(error.message);

  const codes = (data ?? [])
    .map((row) => (row.permissions as unknown as { code?: string } | null)?.code)
    .filter((c): c is string => Boolean(c));
  cache.set(roleId, { at: Date.now(), codes });
  return codes;
}

export function clearPermissionCache(): void {
  cache.clear();
}
