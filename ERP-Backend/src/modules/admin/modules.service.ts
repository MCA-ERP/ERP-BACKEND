import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { clearEntitlementCache, loadSchoolAccess } from "../../lib/entitlements";
import { HttpError } from "../../lib/http-error";

const LIVE_STATUSES = ["Trial", "Active", "Overdue"];

interface ModuleRow {
  code: string;
  name: string;
  description: string | null;
  is_core: boolean;
  is_enabled: boolean;
  sort_order: number;
}

async function allModules(): Promise<ModuleRow[]> {
  return check(
    await supabaseAdmin
      .from("modules")
      .select("code, name, description, is_core, is_enabled, sort_order")
      .order("sort_order")
  ) as ModuleRow[];
}

async function plansWithModules() {
  const [plans, mappings] = await Promise.all([
    supabaseAdmin.from("plans").select("id, code, name, sort_order").order("sort_order"),
    supabaseAdmin.from("plan_modules").select("plan_id, module_code"),
  ]);
  const byPlan = new Map<string, string[]>();
  (check(mappings) as { plan_id: string; module_code: string }[]).forEach((m) =>
    byPlan.set(m.plan_id, [...(byPlan.get(m.plan_id) ?? []), m.module_code])
  );
  return (check(plans) as { id: string; code: string; name: string; sort_order: number }[]).map((p) => ({
    ...p,
    module_codes: byPlan.get(p.id) ?? [],
  }));
}

/** Catalogue with the cheapest plan that includes each module and how many live schools can use it. */
export async function listModules() {
  const [modules, plans, schools, overrides] = await Promise.all([
    allModules(),
    plansWithModules(),
    supabaseAdmin
      .from("subscriptions")
      .select("institution_id, plan_id, institutions!inner(status)")
      .eq("is_current", true)
      .in("institutions.status", LIVE_STATUSES),
    supabaseAdmin.from("institution_modules").select("institution_id, module_code, enabled"),
  ]);

  const live = check(schools) as unknown as { institution_id: string; plan_id: string }[];
  const overrideMap = new Map<string, boolean>();
  (check(overrides) as { institution_id: string; module_code: string; enabled: boolean }[]).forEach((o) =>
    overrideMap.set(`${o.institution_id}:${o.module_code}`, o.enabled)
  );
  const planById = new Map(plans.map((p) => [p.id, p]));

  return {
    liveSchools: live.length,
    modules: modules.map((m) => {
      const includedIn = plans.filter((p) => p.module_codes.includes(m.code));
      const withAccess = live.filter((s) => {
        if (!m.is_enabled) return false;
        if (m.is_core) return true;
        const o = overrideMap.get(`${s.institution_id}:${m.code}`);
        return o !== undefined ? o : planById.get(s.plan_id)?.module_codes.includes(m.code) ?? false;
      }).length;
      return { ...m, min_plan: includedIn[0]?.name ?? null, schools_with_access: withAccess };
    }),
  };
}

export async function setModuleEnabled(code: string, enabled: boolean) {
  const mod = check(
    await supabaseAdmin.from("modules").select("code, is_core").eq("code", code).maybeSingle()
  ) as { code: string; is_core: boolean } | null;
  if (!mod) throw new HttpError(404, "Module not found.");
  if (mod.is_core && !enabled) throw new HttpError(400, "A core module cannot be switched off.");

  check(await supabaseAdmin.from("modules").update({ is_enabled: enabled }).eq("code", code).select("code").single());
  clearEntitlementCache();
  return { code, is_enabled: enabled };
}

export async function getPlanMatrix() {
  const [modules, plans] = await Promise.all([allModules(), plansWithModules()]);
  return { modules, plans };
}

export async function setPlanModules(planCode: string, moduleCodes: string[]) {
  const plan = check(
    await supabaseAdmin.from("plans").select("id").eq("code", planCode).maybeSingle()
  ) as { id: string } | null;
  if (!plan) throw new HttpError(404, "Plan not found.");

  const modules = await allModules();
  const known = new Set(modules.map((m) => m.code));
  const unknown = moduleCodes.filter((c) => !known.has(c));
  if (unknown.length) throw new HttpError(400, `Unknown module(s): ${unknown.join(", ")}`);

  // core modules are part of every plan
  const wanted = Array.from(new Set([...moduleCodes, ...modules.filter((m) => m.is_core).map((m) => m.code)]));

  check(await supabaseAdmin.from("plan_modules").delete().eq("plan_id", plan.id));
  const res = await supabaseAdmin.from("plan_modules").insert(wanted.map((module_code) => ({ plan_id: plan.id, module_code })));
  if (res.error) throw new HttpError(500, res.error.message);

  clearEntitlementCache();
  return { plan_code: planCode, module_codes: wanted };
}

export async function getSchoolModules(institutionId: string) {
  const exists = check(await supabaseAdmin.from("institutions").select("id").eq("id", institutionId).maybeSingle());
  if (!exists) throw new HttpError(404, "School not found.");
  const access = await loadSchoolAccess(institutionId);
  return { planCode: access.planCode, studentLimit: access.studentLimit, modules: access.modules };
}

/** enabled: true = grant, false = revoke, null = follow the plan again */
export async function setSchoolModuleOverride(
  institutionId: string,
  code: string,
  enabled: boolean | null,
  actorProfileId?: string
) {
  const mod = check(
    await supabaseAdmin.from("modules").select("is_core").eq("code", code).maybeSingle()
  ) as { is_core: boolean } | null;
  if (!mod) throw new HttpError(404, "Module not found.");
  if (mod.is_core) throw new HttpError(400, "A core module is always on and cannot be overridden.");

  if (enabled === null) {
    check(
      await supabaseAdmin.from("institution_modules").delete().eq("institution_id", institutionId).eq("module_code", code)
    );
  } else {
    check(
      await supabaseAdmin
        .from("institution_modules")
        .upsert(
          { institution_id: institutionId, module_code: code, enabled, set_by: actorProfileId ?? null, set_at: new Date().toISOString() },
          { onConflict: "institution_id,module_code" }
        )
        .select("module_code")
        .single()
    );
  }
  clearEntitlementCache(institutionId);
  return getSchoolModules(institutionId);
}
