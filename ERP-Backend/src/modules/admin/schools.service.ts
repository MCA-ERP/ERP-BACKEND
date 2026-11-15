import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { clearEntitlementCache } from "../../lib/entitlements";
import { createUser } from "./admin.service";
import { getSetting } from "./settings.service";
import { emitEvent } from "../integrations/events";
import { notifySchoolSafely } from "../messaging/messaging.service";
import { parsePage, safeSearch } from "../../lib/query";

export const SCHOOL_STATUSES = ["Pending", "Trial", "Active", "Overdue", "Suspended", "Expired", "Inactive"] as const;
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

/** Status groups used by the Schools tabs and the dashboard. */
const GROUPS: Record<string, SchoolStatus[]> = {
  pending: ["Pending"],
  active: ["Active", "Trial"],
  inactive: ["Overdue", "Suspended", "Expired", "Inactive"],
  suspended: ["Suspended"],
};


const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// ─────────────────────────────────────────────
//  Plans
// ─────────────────────────────────────────────
export async function listPlans(includeInactive = false) {
  let q = supabaseAdmin
    .from("plans")
    .select("id, code, name, price_per_student_paise, student_limit, staff_limit, campus_limit, storage_gb, sort_order, is_active")
    .order("sort_order", { ascending: true });
  if (!includeInactive) q = q.eq("is_active", true);
  return check(await q);
}

async function planByCode(code: string): Promise<{ id: string }> {
  const plan = check(
    await supabaseAdmin.from("plans").select("id").eq("code", code).eq("is_active", true).maybeSingle()
  ) as { id: string } | null;
  if (!plan) throw new HttpError(400, `Unknown plan '${code}'.`);
  return plan;
}

// ─────────────────────────────────────────────
//  Dashboard (all read models in one round trip)
// ─────────────────────────────────────────────
export async function getDashboardSummary() {
  const [schools, userCounts, plans, teamRes, pendingUsers] = await Promise.all([
    supabaseAdmin
      .from("platform_school_overview")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000),
    supabaseAdmin.from("platform_user_counts").select("institution_id, role, n"),
    listPlans(),
    supabaseAdmin
      .from("user_profiles")
      .select("*", { count: "exact", head: true })
      .is("institution_id", null)
      .eq("status", "active"),
    supabaseAdmin.from("user_profiles").select("*", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    schools: check(schools),
    userCounts: check(userCounts),
    plans,
    platformTeam: teamRes.count ?? 0,
    pendingUsers: pendingUsers.count ?? 0,
  };
}

// ─────────────────────────────────────────────
//  Schools
// ─────────────────────────────────────────────
export async function listSchools(query: Record<string, unknown>) {
  const p = parsePage(query);
  const group = typeof query.group === "string" ? GROUPS[query.group] : undefined;

  const apply = (q: any) => {
    const search = safeSearch(query.search);
    if (search) q = q.or(`name.ilike.%${search}%,code.ilike.%${search}%,city.ilike.%${search}%`);
    if (query.plan) q = q.eq("plan_code", String(query.plan));
    if (query.board) q = q.eq("board", String(query.board));
    if (query.state) q = q.eq("state", String(query.state));
    return q;
  };

  let list = apply(
    supabaseAdmin.from("platform_school_overview").select("*", { count: "exact" })
  )
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (group) list = list.in("status", group);
  else if (query.status) list = list.eq("status", String(query.status));

  const groupCount = (statuses: SchoolStatus[]) =>
    apply(supabaseAdmin.from("platform_school_overview").select("*", { count: "exact", head: true })).in("status", statuses);

  const [res, pending, active, inactive, suspended] = await Promise.all([
    list,
    groupCount(GROUPS.pending),
    groupCount(GROUPS.active),
    groupCount(GROUPS.inactive),
    groupCount(GROUPS.suspended),
  ]);
  const items = check(res);

  return {
    items,
    total: res.count ?? 0,
    page: p.page,
    pageSize: p.pageSize,
    counts: {
      all: (pending.count ?? 0) + (active.count ?? 0) + (inactive.count ?? 0),
      pending: pending.count ?? 0,
      active: active.count ?? 0,
      inactive: inactive.count ?? 0,
      suspended: suspended.count ?? 0,
    },
  };
}

export async function getSchool(id: string) {
  const [overview, institution, campuses, history, users] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("*").eq("id", id).maybeSingle(),
    supabaseAdmin.from("institutions").select("address, website, logo_url, gst_number").eq("id", id).maybeSingle(),
    supabaseAdmin.from("campuses").select("id, code, name, city, state").eq("institution_id", id).order("created_at"),
    supabaseAdmin
      .from("subscriptions")
      .select("id, started_on, renews_on, trial_ends_on, ended_on, is_current, plans:plan_id(code, name)")
      .eq("institution_id", id)
      .order("created_at", { ascending: false }),
    supabaseAdmin.from("platform_user_counts").select("role, n").eq("institution_id", id),
  ]);

  const school = check(overview);
  if (!school) throw new HttpError(404, "School not found.");
  return {
    school: { ...school, ...(check(institution) ?? {}) },
    campuses: check(campuses),
    subscriptions: check(history),
    userCounts: check(users),
  };
}

export interface SchoolInput {
  code?: string;
  name: string;
  type?: string;
  board?: string | null;
  city?: string | null;
  state?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  address?: string | null;
  website?: string | null;
  gst_number?: string | null;
  plan_code?: string;
  status?: "Pending" | "Trial" | "Active";
  /** Optional first administrator for the school. */
  admin?: { first_name: string; last_name: string; email: string; password: string };
}

export async function createSchool(input: SchoolInput, actorProfileId?: string) {
  const code = (input.code || input.name.replace(/[^a-zA-Z]/g, "").substring(0, 3)).toUpperCase();
  if (code.length < 2) throw new HttpError(400, "School code must be at least 2 characters.");

  const trialDays = await getSetting<number>("general.trial_days", 14);
  const status = input.status ?? "Trial";
  const plan = await planByCode(input.plan_code ?? "standard");
  const { plan_code: _p, status: _s, code: _c, admin, ...fields } = input;

  const inst = check(
    await supabaseAdmin.from("institutions").insert({ ...fields, code, status }).select("id").single()
  ) as { id: string };

  const sub = await supabaseAdmin.from("subscriptions").insert({
    institution_id: inst.id,
    plan_id: plan.id,
    trial_ends_on: status === "Trial" ? addDays(trialDays) : null,
    renews_on: status === "Active" ? addDays(365) : null,
    created_by: actorProfileId ?? null,
  });
  if (sub.error) {
    await supabaseAdmin.from("institutions").delete().eq("id", inst.id);
    throw new HttpError(500, sub.error.message);
  }

  if (admin) {
    try {
      await createUser({ ...admin, role: "InstitutionAdmin", institution_id: inst.id, must_change_password: true });
    } catch (err) {
      // do not leave a half-created school behind
      await supabaseAdmin.from("institutions").delete().eq("id", inst.id);
      throw err;
    }
    // the welcome email never contains the password: the administrator was given it separately
    notifySchoolSafely("welcome", inst.id, { admin_name: admin.first_name }, { onlyEmail: { email: admin.email, name: admin.first_name }, relatedType: "school", relatedId: inst.id, dedupe: `welcome:${inst.id}`, channels: ["email"] });
  }
  const created = await getSchool(inst.id);
  emitEvent("school.registered", { id: inst.id, code: created.school.code, name: created.school.name, status: created.school.status, plan: created.school.plan_code });
  return created;
}

export async function updateSchool(id: string, patch: Partial<SchoolInput>) {
  const { plan_code: _p, status: _s, code: _c, ...fields } = patch;
  const data = check(
    await supabaseAdmin.from("institutions").update(fields).eq("id", id).is("deleted_at", null).select("id").maybeSingle()
  );
  if (!data) throw new HttpError(404, "School not found.");
  return getSchool(id);
}

export async function setSchoolStatus(id: string, status: SchoolStatus) {
  if (status === "Pending") throw new HttpError(400, "A school cannot be moved back to Pending.");

  const current = check(
    await supabaseAdmin.from("institutions").select("status").eq("id", id).is("deleted_at", null).maybeSingle()
  ) as { status: SchoolStatus } | null;
  if (!current) throw new HttpError(404, "School not found.");
  if (current.status === status) return getSchool(id);
  const trialDays = await getSetting<number>("general.trial_days", 14);

  check(await supabaseAdmin.from("institutions").update({ status }).eq("id", id).select("id").single());
  clearEntitlementCache(id);
  emitEvent("school.status_changed", { id, from: current.status, to: status });

  // keep the current subscription's dates consistent with the new status
  const sub = check(
    await supabaseAdmin.from("subscriptions").select("id, renews_on, trial_ends_on").eq("institution_id", id).eq("is_current", true).maybeSingle()
  ) as { id: string; renews_on: string | null; trial_ends_on: string | null } | null;
  if (sub) {
    const patch: Record<string, string | null> = {};
    if (status === "Trial" && !sub.trial_ends_on) patch.trial_ends_on = addDays(trialDays);
    if (status === "Active") {
      patch.trial_ends_on = null;
      if (!sub.renews_on) patch.renews_on = addDays(365);
    }
    if (Object.keys(patch).length) {
      check(await supabaseAdmin.from("subscriptions").update(patch).eq("id", sub.id).select("id").single());
    }
  }
  return getSchool(id);
}

export async function changeSchoolPlan(id: string, planCode: string, actorProfileId?: string) {
  const plan = await planByCode(planCode);
  const current = check(
    await supabaseAdmin
      .from("subscriptions")
      .select("id, plan_id, renews_on, trial_ends_on")
      .eq("institution_id", id)
      .eq("is_current", true)
      .maybeSingle()
  ) as { id: string; plan_id: string; renews_on: string | null; trial_ends_on: string | null } | null;

  if (current?.plan_id === plan.id) return getSchool(id);

  const exists = check(await supabaseAdmin.from("institutions").select("id").eq("id", id).maybeSingle());
  if (!exists) throw new HttpError(404, "School not found.");

  if (current) {
    check(
      await supabaseAdmin
        .from("subscriptions")
        .update({ is_current: false, ended_on: addDays(0) })
        .eq("id", current.id)
        .select("id")
        .single()
    );
  }
  const res = await supabaseAdmin.from("subscriptions").insert({
    institution_id: id,
    plan_id: plan.id,
    renews_on: current?.renews_on ?? null,
    trial_ends_on: current?.trial_ends_on ?? null,
    created_by: actorProfileId ?? null,
  });
  if (res.error) {
    // restore the previous subscription so the school is never left without one
    if (current) await supabaseAdmin.from("subscriptions").update({ is_current: true, ended_on: null }).eq("id", current.id);
    throw new HttpError(500, res.error.message);
  }
  clearEntitlementCache(id);
  emitEvent("subscription.changed", { school_id: id, plan: planCode });
  return getSchool(id);
}
