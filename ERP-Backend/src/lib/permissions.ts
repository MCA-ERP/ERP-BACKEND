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
  limitCache.clear();
}

const limitCache = new Map<string, { at: number; modules: string[] | null }>();

/** Modules a role is limited to, or null when it may open every module its school has. */
export async function getRoleModuleLimit(roleId: string): Promise<string[] | null> {
  const hit = limitCache.get(roleId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules;
  const { data } = await supabaseAdmin.from("role_modules").select("module_code").eq("role_id", roleId);
  const rows = ((data ?? []) as { module_code: string }[]).map((r) => r.module_code);
  const modules = rows.length ? rows : null;
  limitCache.set(roleId, { at: Date.now(), modules });
  return modules;
}
