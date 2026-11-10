import { createHash } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { clearEntitlementCache, loadSchoolAccess } from "../../lib/entitlements";
import { getSetting, getSettings, updateSettings } from "./settings.service";

export const CATEGORIES = ["Academic", "Administrative", "Communication", "Advanced"] as const;
export const BUILD_STATUSES = ["live", "beta", "planned"] as const;
const LIVE_STATUSES = ["Trial", "Active", "Overdue"];

// ═════════════ dependencies ═════════════
export async function getDependencyMap(): Promise<Map<string, string[]>> {
  const rows = check(await supabaseAdmin.from("module_dependencies").select("module_code, requires_code")) as { module_code: string; requires_code: string }[];
  const m = new Map<string, string[]>();
  rows.forEach((r) => m.set(r.module_code, [...(m.get(r.module_code) ?? []), r.requires_code]));
  return m;
}

/** Codes in `wanted` whose requirements are not also in `wanted`. */
export function missingDependencies(wanted: Set<string>, deps: Map<string, string[]>): { module: string; requires: string }[] {
  const out: { module: string; requires: string }[] = [];
  for (const code of wanted) for (const req of deps.get(code) ?? []) if (!wanted.has(req)) out.push({ module: code, requires: req });
  return out;
}

async function names(): Promise<Map<string, string>> {
  const rows = check(await supabaseAdmin.from("modules").select("code, name")) as { code: string; name: string }[];
  return new Map(rows.map((r) => [r.code, r.name]));
}

/** Throws a readable error if the set leaves some module without what it needs. */
export async function assertDependenciesMet(wanted: Set<string>, context: string) {
  const miss = missingDependencies(wanted, await getDependencyMap());
  if (!miss.length) return;
  const n = await names();
  throw new HttpError(409, `${context}: ${miss.map((m) => `${n.get(m.module) ?? m.module} needs ${n.get(m.requires) ?? m.requires}`).join("; ")}.`);
}

export async function listDependencies() {
  const [mods, deps] = await Promise.all([
    supabaseAdmin.from("modules").select("code, name, category, sort_order").order("sort_order"),
    getDependencyMap(),
  ]);
  return (check(mods) as { code: string; name: string; category: string }[]).map((m) => ({ ...m, requires: deps.get(m.code) ?? [] }));
}

export async function setDependencies(code: string, requires: string[]) {
  const mods = (check(await supabaseAdmin.from("modules").select("code")) as { code: string }[]).map((m) => m.code);
  if (!mods.includes(code)) throw new HttpError(404, "Module not found.");
  const bad = requires.filter((r) => !mods.includes(r) || r === code);
  if (bad.length) throw new HttpError(400, `Not a valid requirement: ${bad.join(", ")}`);

  // refuse a loop: following the requirements from any of them must never lead back to this module
  const map = await getDependencyMap();
  map.set(code, requires);
  const seen = new Set<string>();
  const stack = [...requires];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === code) throw new HttpError(400, "That would make modules wait on each other in a circle.");
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(map.get(c) ?? []));
  }
  check(await supabaseAdmin.from("module_dependencies").delete().eq("module_code", code).select("module_code"));
  if (requires.length) check(await supabaseAdmin.from("module_dependencies").insert(requires.map((requires_code) => ({ module_code: code, requires_code }))).select("module_code"));
  clearEntitlementCache();
  return listDependencies();
}

// ═════════════ catalogue details & meta ═════════════
export async function updateMeta(code: string, patch: { category?: (typeof CATEGORIES)[number]; build_status?: (typeof BUILD_STATUSES)[number]; description?: string }) {
  const row = check(await supabaseAdmin.from("modules").update(patch).eq("code", code).select("code").maybeSingle());
  if (!row) throw new HttpError(404, "Module not found.");
  return getModuleDetails(code);
}

export async function getModuleDetails(code: string) {
  const mod = check(await supabaseAdmin.from("modules").select("*").eq("code", code).maybeSingle()) as Record<string, unknown> | null;
  if (!mod) throw new HttpError(404, "Module not found.");
  const [plans, planMods, deps, flags, releases, bundles, schools, overrides] = await Promise.all([
    supabaseAdmin.from("plans").select("id, code, name, sort_order").order("sort_order"),
    supabaseAdmin.from("plan_modules").select("plan_id").eq("module_code", code),
    getDependencyMap(),
    supabaseAdmin.from("feature_flags").select("*").eq("module_code", code).order("created_at"),
    supabaseAdmin.from("module_releases").select("*").eq("module_code", code).order("created_at", { ascending: false }),
    supabaseAdmin.from("module_bundles").select("id, name, module_codes").contains("module_codes", [code]),
    supabaseAdmin.from("platform_school_overview").select("id, name, code, plan_code, status").in("status", LIVE_STATUSES).order("name"),
    supabaseAdmin.from("institution_modules").select("institution_id, enabled").eq("module_code", code),
  ]);
  const inPlan = new Set((check(planMods) as { plan_id: string }[]).map((p) => p.plan_id));
  const allPlans = check(plans) as { id: string; code: string; name: string }[];
  const planCodes = new Set(allPlans.filter((p) => inPlan.has(p.id)).map((p) => p.code));
  const ov = new Map((check(overrides) as { institution_id: string; enabled: boolean }[]).map((o) => [o.institution_id, o.enabled]));
  const live = check(schools) as { id: string; name: string; code: string; plan_code: string | null; status: string }[];
  const withAccess = live.filter((s) => {
    if (!mod.is_enabled) return false;
    if (mod.is_core) return true;
    const o = ov.get(s.id);
    return o !== undefined ? o : !!s.plan_code && planCodes.has(s.plan_code);
  });
  const n = await names();
  const dependents = [...deps.entries()].filter(([, req]) => req.includes(code)).map(([m]) => ({ code: m, name: n.get(m) ?? m }));
  return {
    module: mod,
    plans: allPlans.map((p) => ({ code: p.code, name: p.name, included: planCodes.has(p.code) })),
    requires: (deps.get(code) ?? []).map((c) => ({ code: c, name: n.get(c) ?? c })),
    required_by: dependents,
    flags: check(flags), releases: check(releases), bundles: check(bundles),
    schools: { live: live.length, with_access: withAccess.length, list: withAccess.slice(0, 50).map((s) => ({ id: s.id, name: s.name, code: s.code })) },
  };
}

// ═════════════ settings ═════════════
export const MODULE_SETTING_KEYS = ["modules.allow_addons", "modules.show_locked"] as const;
export async function getModuleSettings() {
  const all = await getSettings();
  return { settings: Object.fromEntries(MODULE_SETTING_KEYS.map((k) => [k, all[k] ?? true])) };
}
export async function updateModuleSettings(values: Record<string, unknown>, profileId?: string) {
  const bad = Object.keys(values).filter((k) => !(MODULE_SETTING_KEYS as readonly string[]).includes(k));
  if (bad.length) throw new HttpError(400, `Not a module setting: ${bad.join(", ")}`);
  await updateSettings(values, profileId);
  return getModuleSettings();
}

// ═════════════ allocation (assign a whole set at once) ═════════════
/**
 * Makes a school's modules exactly `codes` (plus the core ones). Anything the plan already gives is left to the plan;
 * everything else is stored as an override, so the school follows plan changes where it can.
 */
export async function assignSchoolModules(institutionId: string, codes: string[], actorProfileId?: string) {
  const access = await loadSchoolAccess(institutionId);
  const known = new Map(access.modules.map((m) => [m.code, m]));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) throw new HttpError(400, `Unknown module(s): ${unknown.join(", ")}`);

  const wanted = new Set([...codes, ...access.modules.filter((m) => m.is_core).map((m) => m.code)]);
  await assertDependenciesMet(wanted, "That set of modules does not work together");

  const addons = [...wanted].filter((c) => !known.get(c)!.via_plan && !known.get(c)!.is_core);
  if (addons.length && !(await getSetting<boolean>("modules.allow_addons", true))) {
    throw new HttpError(409, "Add-on modules are switched off in Module configuration, so only what the plan includes can be assigned.");
  }

  const rows: { institution_id: string; module_code: string; enabled: boolean; set_by: string | null; set_at: string }[] = [];
  const clear: string[] = [];
  for (const m of access.modules) {
    if (m.is_core) continue;
    const on = wanted.has(m.code);
    if (on && m.via_plan) clear.push(m.code);
    else if (!on && !m.via_plan) clear.push(m.code);
    else rows.push({ institution_id: institutionId, module_code: m.code, enabled: on, set_by: actorProfileId ?? null, set_at: new Date().toISOString() });
  }
  if (clear.length) check(await supabaseAdmin.from("institution_modules").delete().eq("institution_id", institutionId).in("module_code", clear).select("module_code"));
  if (rows.length) check(await supabaseAdmin.from("institution_modules").upsert(rows, { onConflict: "institution_id,module_code" }).select("module_code"));
  clearEntitlementCache(institutionId);
  const result = await loadSchoolAccess(institutionId);
  return { planCode: result.planCode, studentLimit: result.studentLimit, modules: result.modules };
}

// ═════════════ pricing ═════════════
export async function listPricing() {
  const [mods, bundles] = await Promise.all([
    supabaseAdmin.from("modules").select("code, name, category, is_core, addon_price_paise, sort_order").order("sort_order"),
    supabaseAdmin.from("module_bundles").select("*").order("created_at", { ascending: false }),
  ]);
  return { modules: check(mods), bundles: check(bundles) };
}
export async function setAddonPrice(code: string, paise: number) {
  const row = check(await supabaseAdmin.from("modules").update({ addon_price_paise: paise }).eq("code", code).select("code, addon_price_paise").maybeSingle());
  if (!row) throw new HttpError(404, "Module not found.");
  return row;
}

export const bundleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  module_codes: z.array(z.string().trim().min(1)).min(2, "A bundle needs at least two modules.").max(30),
  price_per_student_paise: z.number().int().min(0).max(10_000_000),
  is_active: z.boolean().optional(),
});

export async function saveBundle(id: string | null, input: Partial<z.infer<typeof bundleSchema>>) {
  if (input.module_codes) {
    const known = new Set((check(await supabaseAdmin.from("modules").select("code")) as { code: string }[]).map((m) => m.code));
    const bad = input.module_codes.filter((c) => !known.has(c));
    if (bad.length) throw new HttpError(400, `Unknown module(s): ${bad.join(", ")}`);
    if (new Set(input.module_codes).size !== input.module_codes.length) throw new HttpError(400, "A module is listed twice.");
  }
  const q = id ? supabaseAdmin.from("module_bundles").update(input).eq("id", id) : supabaseAdmin.from("module_bundles").insert(input);
  const row = check(await q.select().maybeSingle());
  if (!row) throw new HttpError(404, "Bundle not found.");
  return row;
}
export async function deleteBundle(id: string) {
  check(await supabaseAdmin.from("module_bundles").delete().eq("id", id).select("id"));
  return { success: true };
}

// ═════════════ feature flags ═════════════
export const flagSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,60}$/, "Use 3-60 lowercase letters, digits, . _ or -."),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  module_code: z.string().trim().min(1).nullable().optional(),
  rollout_percent: z.number().int().min(0).max(100),
  enabled: z.boolean().optional(),
});

/** The same school always gets the same answer for a flag, so a rollout never flickers. */
export function inRollout(key: string, institutionId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const n = createHash("sha256").update(`${key}:${institutionId}`).digest().readUInt32BE(0) % 100;
  return n < percent;
}

export async function listFlags() {
  const [flags, schools] = await Promise.all([
    supabaseAdmin.from("feature_flags").select("*, modules:module_code(name)").order("created_at", { ascending: false }),
    supabaseAdmin.from("institutions").select("id").in("status", LIVE_STATUSES).is("deleted_at", null),
  ]);
  const ids = (check(schools) as { id: string }[]).map((s) => s.id);
  return (check(flags) as { key: string; enabled: boolean; rollout_percent: number }[]).map((f) => ({
    ...f,
    schools_reached: f.enabled ? ids.filter((id) => inRollout(f.key, id, f.rollout_percent)).length : 0,
    live_schools: ids.length,
  }));
}
export async function saveFlag(id: string | null, input: Partial<z.infer<typeof flagSchema>>) {
  const q = id ? supabaseAdmin.from("feature_flags").update(input).eq("id", id) : supabaseAdmin.from("feature_flags").insert(input);
  const res = await q.select().maybeSingle();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "A flag with that key already exists.");
    if (res.error.code === "23503") throw new HttpError(400, "Unknown module.");
    throw new HttpError(500, res.error.message);
  }
  if (!res.data) throw new HttpError(404, "Flag not found.");
  return res.data;
}
export async function deleteFlag(id: string) {
  check(await supabaseAdmin.from("feature_flags").delete().eq("id", id).select("id"));
  return { success: true };
}
/** Flags that are on for this school. */
export async function flagsForSchool(institutionId: string): Promise<string[]> {
  const rows = check(await supabaseAdmin.from("feature_flags").select("key, rollout_percent").eq("enabled", true)) as { key: string; rollout_percent: number }[];
  return rows.filter((f) => inRollout(f.key, institutionId, f.rollout_percent)).map((f) => f.key);
}

// ═════════════ releases ═════════════
export const releaseSchema = z.object({
  module_code: z.string().trim().min(1),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/, "Use a version like 1.2.0."),
  notes: z.string().trim().min(3, "Say what changed.").max(5000),
  status: z.enum(["planned", "rolling_out", "live", "rolled_back"]).default("planned"),
  rollout_percent: z.number().int().min(0).max(100).default(0),
});

export async function listReleases(query: Record<string, unknown>) {
  let q = supabaseAdmin.from("module_releases").select("*, modules:module_code(name, category)").order("created_at", { ascending: false }).limit(200);
  if (typeof query.module === "string" && /^[a-z0-9_]{1,40}$/.test(query.module)) q = q.eq("module_code", query.module);
  return check(await q);
}

async function syncVersion(code: string) {
  const live = check(
    await supabaseAdmin.from("module_releases").select("version").eq("module_code", code).eq("status", "live").order("released_at", { ascending: false }).limit(1)
  ) as { version: string }[];
  await supabaseAdmin.from("modules").update({ version: live[0]?.version ?? null }).eq("code", code);
}

export async function createRelease(input: z.infer<typeof releaseSchema>, profileId?: string) {
  const status = input.status;
  const pct = status === "live" ? 100 : status === "planned" ? 0 : input.rollout_percent;
  const res = await supabaseAdmin
    .from("module_releases")
    .insert({ ...input, rollout_percent: pct, released_at: status === "live" ? new Date().toISOString() : null, created_by: profileId ?? null })
    .select()
    .single();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, `Version ${input.version} already exists for this module.`);
    if (res.error.code === "23503") throw new HttpError(400, "Unknown module.");
    throw new HttpError(500, res.error.message);
  }
  await syncVersion(input.module_code);
  return res.data;
}

export async function updateRelease(id: string, patch: { status?: "planned" | "rolling_out" | "live" | "rolled_back"; rollout_percent?: number; notes?: string }) {
  const cur = check(await supabaseAdmin.from("module_releases").select("module_code, status").eq("id", id).maybeSingle()) as { module_code: string; status: string } | null;
  if (!cur) throw new HttpError(404, "Release not found.");
  const update: Record<string, unknown> = { ...patch };
  if (patch.status === "live") { update.rollout_percent = 100; update.released_at = new Date().toISOString(); }
  if (patch.status === "planned") update.rollout_percent = 0;
  if (patch.status === "rolled_back") update.rollout_percent = 0;
  const row = check(await supabaseAdmin.from("module_releases").update(update).eq("id", id).select().single());
  await syncVersion(cur.module_code);
  return row;
}
