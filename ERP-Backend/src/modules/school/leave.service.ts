import { z } from "zod";
import { leavePolicy } from "./hr3.service";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** A staff member's own leave: the balance, applying, and the requests they have made. */
export const LEAVE_TYPES = ["Casual", "Sick", "Earned"] as const;
type LeaveType = (typeof LEAVE_TYPES)[number];

const DEFAULTS: { leave_type: LeaveType; allowed_days: number; details: string; sort_order: number }[] = [
  { leave_type: "Casual", allowed_days: 12, details: "No carry-forward; sandwich rule applies", sort_order: 1 },
  { leave_type: "Sick", allowed_days: 10, details: "Certificate after 2 days", sort_order: 2 },
  { leave_type: "Earned", allowed_days: 15, details: "Carry forward up to 45 days; encash up to 10 a year", sort_order: 3 },
];

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The school's leave year: April to March. */
function leaveYear(now = new Date()) {
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: `${start}-04-01`, end: `${start + 1}-03-31`, label: `${start}–${String(start + 1).slice(2)}` };
}

async function policies(inst: string) {
  let rows = check(await supabaseAdmin.from("leave_policies").select("leave_type, allowed_days, details, sort_order").eq("institution_id", inst).order("sort_order")) as { leave_type: LeaveType; allowed_days: number; details: string; sort_order: number }[];
  if (!rows.length) {
    rows = check(await supabaseAdmin.from("leave_policies").upsert(DEFAULTS.map((d) => ({ ...d, institution_id: inst })), { onConflict: "institution_id,leave_type" }).select("leave_type, allowed_days, details, sort_order")) as typeof rows;
    rows.sort((a, b) => a.sort_order - b.sort_order);
  }
  return rows;
}

/** Days between two dates, Sundays left out; a single half day counts as 0.5. */
export function countDays(from: string, to: string, half: boolean): number {
  if (half) return from === to ? 0.5 : 0;
  let n = 0;
  for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(d.getTime() + 86_400_000)) if (d.getUTCDay() !== 0) n++;
  return n;
}

export async function myLeave(inst: string, profileId: string) {
  const year = leaveYear();
  const [pol, requests, who, principal, admin] = await Promise.all([
    policies(inst),
    supabaseAdmin.from("leave_requests").select("id, leave_type, from_date, to_date, half_day, days, reason, cover_note, status, created_at").eq("profile_id", profileId).gte("from_date", year.start).lte("from_date", year.end).order("from_date", { ascending: false }),
    supabaseAdmin.from("user_profiles").select("first_name, last_name, roles:role_id(name, display_name)").eq("id", profileId).maybeSingle(),
    supabaseAdmin.from("user_profiles").select("first_name, last_name, roles:role_id!inner(name)").eq("institution_id", inst).eq("roles.name", "Principal").limit(1),
    supabaseAdmin.from("user_profiles").select("first_name, last_name, roles:role_id!inner(name)").eq("institution_id", inst).eq("roles.name", "InstitutionAdmin").limit(1),
  ]);
  const list = (requests.data ?? []) as { id: string; leave_type: LeaveType; from_date: string; to_date: string; half_day: boolean; days: number; reason: string; cover_note: string | null; status: string; created_at: string }[];
  const balance = pol.map((p) => {
    const taken = list.filter((r) => r.leave_type === p.leave_type && r.status === "Approved").reduce((s, r) => s + Number(r.days), 0);
    const pending = list.filter((r) => r.leave_type === p.leave_type && r.status === "Pending").reduce((s, r) => s + Number(r.days), 0);
    return { type: p.leave_type, allowed: Number(p.allowed_days), taken, pending, balance: Number(p.allowed_days) - taken - pending, details: p.details };
  });
  const person = who.data as { first_name: string; last_name: string; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null } | null;
  const isPrincipal = (Array.isArray(person?.roles) ? person?.roles[0] : person?.roles)?.name === "Principal";
  const a0 = ((admin.data ?? []) as { first_name: string; last_name: string }[])[0];
  const p0 = ((principal.data ?? []) as { first_name: string; last_name: string }[])[0];
  return {
    year: year.label,
    person: person ? { name: `${person.first_name} ${person.last_name}`.trim(), role: (Array.isArray(person.roles) ? person.roles[0] : person.roles)?.display_name ?? "" } : null,
    approver: isPrincipal ? (a0 ? `${a0.first_name} ${a0.last_name}`.trim() + " (School Admin)" : "the school administrator") : p0 ? `${p0.first_name} ${p0.last_name}`.trim() + " (Principal)" : "the school administrator",
    balance,
    requests: list,
    policy: [
      ...pol.map((p) => ({ rule: `${p.leave_type} leave`, allowance: `${Number(p.allowed_days)} a year`, details: p.details })),
      { rule: "Comp-off", allowance: "For Sunday or holiday duty", details: "Use within 60 days" },
      { rule: "Half day", allowance: "Casual and sick leave", details: "" },
      { rule: "When the balance runs out", allowance: "Loss of pay", details: "" },
    ],
  };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
export async function apply(inst: string, profileId: string, body: unknown) {
  const input = z.object({ leave_type: z.enum(LEAVE_TYPES), from_date: date, to_date: date, half_day: z.boolean().optional(), reason: z.string().trim().max(1000).optional(), cover_note: z.string().trim().max(300).optional() }).strict().parse(body);
  if (input.to_date < input.from_date) throw new HttpError(400, "The end date is before the start date.");
  const half = input.half_day === true;
  if (half && input.from_date !== input.to_date) throw new HttpError(400, "A half day is for a single date.");
  if (half && input.leave_type === "Earned") throw new HttpError(400, "Half days are only for casual and sick leave.");
  const days = countDays(input.from_date, input.to_date, half);
  if (days <= 0) throw new HttpError(400, "Those dates are all Sundays. Nothing to apply for.");
  const notice = (await leavePolicy(inst)).earned_notice;
  if (input.leave_type === "Earned" && input.from_date < day(new Date(Date.now() + notice * 86_400_000))) throw new HttpError(400, `Earned leave needs ${notice} days' notice.`);
  if (input.leave_type !== "Sick" && !input.reason?.trim()) throw new HttpError(400, "Give a reason.");

  const clash = check(await supabaseAdmin.from("leave_requests").select("id").eq("profile_id", profileId).in("status", ["Pending", "Approved"]).lte("from_date", input.to_date).gte("to_date", input.from_date).limit(1)) as unknown[];
  if (clash.length) throw new HttpError(409, "You already have leave on some of those dates.");
  return check(await supabaseAdmin.from("leave_requests").insert({ institution_id: inst, profile_id: profileId, leave_type: input.leave_type, from_date: input.from_date, to_date: input.to_date, half_day: half, days, reason: input.reason ?? "", cover_note: input.cover_note || null }).select("id, leave_type, from_date, to_date, days, status").single());
}

export async function compOffs(profileId: string) {
  return check(await supabaseAdmin.from("comp_offs").select("id, worked_on, reason, use_by, status").eq("profile_id", profileId).order("worked_on", { ascending: false }).limit(200)) as unknown[];
}
