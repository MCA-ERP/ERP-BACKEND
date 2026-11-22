import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { apply, compOffs, myLeave } from "../school/leave.service";
import { one, whoAmI } from "./teacher.service";

/** The teacher's own leave, and (for a head of department) the department's leave waiting for their first approval. */
type LR = { id: string; code: string; leave_type: string; from_date: string; to_date: string; days: number; half_day: boolean; reason: string; cover_note: string | null; status: string; created_at: string; level: number; hod_at: string | null };
const SEL = "id, code, leave_type, from_date, to_date, days, half_day, reason, cover_note, status, created_at, level, hod_at";

async function myDepartment(inst: string, me: string) {
  const d = check(await supabaseAdmin.from("hr_departments").select("id, name").eq("institution_id", inst).eq("head_id", me).limit(1)) as { id: string; name: string }[];
  return d[0] ?? null;
}

export async function leaveOverview(inst: string, me: string) {
  const year = (() => { const n = new Date(); const y = n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1; return { from: `${y}-04-01`, to: `${y + 1}-03-31` }; })();
  const [base, rows, comp, who, dept, pol, staff] = await Promise.all([
    myLeave(inst, me),
    supabaseAdmin.from("leave_requests").select(SEL).eq("institution_id", inst).eq("profile_id", me).gte("from_date", year.from).lte("from_date", year.to).order("from_date", { ascending: false }).limit(300),
    compOffs(me),
    whoAmI(inst, me), myDepartment(inst, me),
    supabaseAdmin.from("hr_leave_policy").select("medical_days, earned_notice").eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("hr_staff").select("department").eq("profile_id", me).maybeSingle(),
  ]);
  const items = (check(rows) ?? []) as LR[];
  const p = (check(pol) as { medical_days: number; earned_notice: number } | null) ?? { medical_days: 2, earned_notice: 7 };
  const hod = who.role === "HOD" || !!dept;
  const route = hod
    ? `as HOD your leave goes to the Vice principal, and to the Principal as well for more than 7 days. Sick leave over ${p.medical_days} days needs a medical certificate; earned leave needs ${p.earned_notice} days' notice.`
    : `your leave goes to your head of department first, then on to the Vice principal and Principal for longer leave. Sick leave over ${p.medical_days} days needs a medical certificate; earned leave needs ${p.earned_notice} days' notice.`;
  const stage = (r: LR) => (r.status !== "Pending" ? r.status : hod || r.hod_at ? (r.level >= 3 ? "With the Principal" : "With the Vice principal") : "With your head of department");
  return {
    year: base.year, person: base.person, role: who.line, department: (check(staff) as { department: string } | null)?.department ?? "", is_hod: hod, route,
    balance: base.balance, policy: base.policy,
    items: items.map((r) => ({ ...r, stage: stage(r), type_label: `${r.leave_type} leave` })),
    comp: comp as { id: string; worked_on: string; reason: string; use_by: string; status: string }[],
  };
}

export async function applyLeave(inst: string, me: string, body: unknown) {
  return apply(inst, me, body);
}

export async function teamLeave(inst: string, me: string) {
  const dept = await myDepartment(inst, me);
  if (!dept) return { department: "", items: [] as unknown[] };
  const staff = (check(await supabaseAdmin.from("hr_staff").select("profile_id").eq("institution_id", inst).eq("department", dept.name).neq("profile_id", me).limit(500)) ?? []) as { profile_id: string }[];
  if (!staff.length) return { department: dept.name, items: [] };
  const rows = (check(await supabaseAdmin.from("leave_requests").select(`${SEL}, who:profile_id(first_name, last_name)`).eq("institution_id", inst).eq("status", "Pending").is("hod_at", null).in("profile_id", staff.map((s) => s.profile_id)).order("created_at").limit(200)) ?? []) as unknown as (LR & { who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null })[];
  return { department: dept.name, items: rows.map((r) => { const w = one(r.who); return { id: r.id, code: r.code, teacher: w ? `${w.first_name} ${w.last_name}`.trim() : "", leave: `${r.leave_type} leave · ${Number(r.days)} day${Number(r.days) === 1 ? "" : "s"}`, from: r.from_date, to: r.to_date, then: Number(r.days) <= 3 ? "No one, you decide" : Number(r.days) > 7 ? "Vice principal, Principal" : "Vice principal" }; }) };
}

export async function decideTeam(inst: string, me: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["approve", "send_back"]) }).strict().parse(input);
  const dept = await myDepartment(inst, me);
  if (!dept) throw new HttpError(403, "You are not a head of department.");
  const r = check(await supabaseAdmin.from("leave_requests").select("id, days, status, hod_at, profile_id").eq("id", z.string().uuid().parse(id)).eq("institution_id", inst).maybeSingle()) as { id: string; days: number; status: string; hod_at: string | null; profile_id: string } | null;
  if (!r || r.profile_id === me) throw new HttpError(404, "Request not found.");
  const mem = check(await supabaseAdmin.from("hr_staff").select("profile_id").eq("profile_id", r.profile_id).eq("institution_id", inst).eq("department", dept.name).maybeSingle());
  if (!mem) throw new HttpError(403, "That teacher is not in your department.");
  if (r.status !== "Pending" || r.hod_at) throw new HttpError(409, "That request was already decided.");
  const now = new Date().toISOString();
  const final = action === "send_back" || Number(r.days) <= 3;
  const patch = final ? { status: action === "send_back" ? "Rejected" : "Approved", decided_by: me, decided_at: now, hod_by: me, hod_at: now } : { hod_by: me, hod_at: now };
  check(await supabaseAdmin.from("leave_requests").update(patch).eq("id", id).eq("institution_id", inst).is("hod_at", null).select("id"));
  return { ok: true, final };
}
