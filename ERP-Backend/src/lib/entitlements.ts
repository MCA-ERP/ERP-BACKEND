import { supabaseAdmin } from "../../db/client";
import { check } from "./db";

export interface ModuleAccess {
  code: string;
  name: string;
  is_core: boolean;
  globally_enabled: boolean;
  /** included in the school's current plan */
  via_plan: boolean;
  /** per-school override: true = forced on, false = forced off, null = follow the plan */
  override: boolean | null;
  effective: boolean;
}

export interface SchoolAccess {
  status: string;
  planCode: string | null;
  studentLimit: number | null;
  modules: ModuleAccess[];
}

/** Compute, from the database, what a school may use right now. */
export async function loadSchoolAccess(institutionId: string): Promise<SchoolAccess> {
  const [inst, sub, mods, overrides] = await Promise.all([
    supabaseAdmin.from("institutions").select("status").eq("id", institutionId).maybeSingle(),
    supabaseAdmin
      .from("subscriptions")
      .select("plan_id, plans:plan_id(code, student_limit)")
      .eq("institution_id", institutionId)
      .eq("is_current", true)
      .maybeSingle(),
    supabaseAdmin.from("modules").select("code, name, is_core, is_enabled").order("sort_order"),
    supabaseAdmin.from("institution_modules").select("module_code, enabled").eq("institution_id", institutionId),
  ]);

  const institution = check(inst) as { status: string } | null;
  const subscription = check(sub) as unknown as { plan_id: string; plans: { code: string; student_limit: number | null } | null } | null;

  let planModules = new Set<string>();
  if (subscription) {
    const rows = check(
      await supabaseAdmin.from("plan_modules").select("module_code").eq("plan_id", subscription.plan_id)
    ) as { module_code: string }[];
    planModules = new Set(rows.map((r) => r.module_code));
  }

  const overrideMap = new Map(
    (check(overrides) as { module_code: string; enabled: boolean }[]).map((o) => [o.module_code, o.enabled])
  );

  const modules = (check(mods) as { code: string; name: string; is_core: boolean; is_enabled: boolean }[]).map((m) => {
    const override = overrideMap.has(m.code) ? overrideMap.get(m.code)! : null;
    const via_plan = m.is_core || planModules.has(m.code);
    const allowed = m.is_core ? true : override !== null ? override : via_plan;
    return {
      code: m.code,
      name: m.name,
      is_core: m.is_core,
      globally_enabled: m.is_enabled,
      via_plan,
      override,
      effective: m.is_enabled && allowed,
    };
  });

  return {
    status: institution?.status ?? "Suspended",
    planCode: subscription?.plans?.code ?? null,
    studentLimit: subscription?.plans?.student_limit ?? null,
    modules,
  };
}

// ── short-lived cache for the per-request check ─────────────
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: { status: string; modules: string[] } }>();

/** Status and enabled module codes for a school (cached for a minute). */
export async function getEntitlements(institutionId: string): Promise<{ status: string; modules: string[] }> {
  const hit = cache.get(institutionId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const access = await loadSchoolAccess(institutionId);
  const value = { status: access.status, modules: access.modules.filter((m) => m.effective).map((m) => m.code) };
  cache.set(institutionId, { at: Date.now(), value });
  return value;
}

/** Call after changing a school's status, plan, overrides, or any module/plan mapping. */
export function clearEntitlementCache(institutionId?: string): void {
  if (institutionId) cache.delete(institutionId);
  else cache.clear();
}
