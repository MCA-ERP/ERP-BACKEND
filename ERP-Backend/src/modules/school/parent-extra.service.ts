import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** Parent requests, parent feedback and complaints, and parent app sign-ins for one school. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const txt = (n: number) => z.string().trim().max(n);

const RK: Record<string, string[]> = {
  leave: ["Pending", "Approved", "Rejected"],
  correction: ["Pending", "Approved", "Rejected"],
  other: ["Pending", "Approved", "Rejected"],
  mobile: ["Pending", "Code sent", "Number verified", "Approved", "Rejected"],
  app: ["Sent", "Approved", "Declined", "Booked", "Pass issued"],
};
const FIRST: Record<string, string> = { leave: "Pending", correction: "Pending", other: "Pending", mobile: "Pending", app: "Sent" };

interface Req { id: string; code: string; kind: string; guardian_id: string; student_id: string | null; req_type: string | null; details: string; current_number: string | null; new_number: string | null; reason: string | null; raised_on: string; status: string; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null }

export async function listRequests(inst: string, kind: string) {
  if (!RK[kind]) throw new HttpError(404, "Unknown request type.");
  const [rows, ro] = await Promise.all([
    supabaseAdmin.from("parent_requests").select("id, code, kind, guardian_id, student_id, req_type, details, current_number, new_number, reason, raised_on, status, guardians:guardian_id(full_name, phone)").eq("institution_id", inst).eq("kind", kind).order("raised_on", { ascending: false }).order("created_at", { ascending: false }).limit(2000),
    roster(inst),
  ]);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  return {
    statuses: RK[kind],
    items: (check(rows) as unknown as Req[]).map((r) => {
      const s = r.student_id ? kids.get(r.student_id) : undefined;
      return { id: r.id, code: r.code, req_type: r.req_type ?? "", details: r.details, current_number: r.current_number ?? "", new_number: r.new_number ?? "", reason: r.reason ?? "", raised_on: r.raised_on, status: r.status, parent: one(r.guardians)?.full_name ?? "", student: s?.name ?? "", student_id: r.student_id, class_label: s?.class_label ?? "" };
    }),
  };
}

export async function addRequest(inst: string, body: unknown, actor?: string) {
  const i = z.object({ kind: z.enum(["leave", "correction", "mobile", "other", "app"]), guardian_id: z.string().uuid("Choose the parent."), student_id: z.string().uuid().optional().or(z.literal("")), req_type: txt(60).optional(), details: txt(400).optional(), new_number: txt(30).optional(), reason: txt(200).optional() }).strict().parse(body);
  const g = check(await supabaseAdmin.from("guardians").select("id, phone").eq("id", i.guardian_id).eq("institution_id", inst).maybeSingle()) as { id: string; phone: string } | null;
  if (!g) throw new HttpError(404, "Parent not found.");
  if (i.kind === "mobile") {
    if (!i.new_number || i.new_number.replace(/\D/g, "").length < 10) throw new HttpError(400, "Enter the new mobile number.");
    if (i.new_number.replace(/\D/g, "").slice(-10) === g.phone.replace(/\D/g, "").slice(-10)) throw new HttpError(400, "That is already the number on record.");
  } else if (!i.details || i.details.length < 2) throw new HttpError(400, "Enter the details.");
  const details = i.kind === "mobile" ? i.reason || "Mobile number change" : (i.details as string);
  return check(await supabaseAdmin.from("parent_requests").insert({ institution_id: inst, kind: i.kind, guardian_id: i.guardian_id, student_id: i.student_id || null, req_type: i.req_type || null, details, current_number: i.kind === "mobile" ? g.phone : null, new_number: i.kind === "mobile" ? i.new_number : null, reason: i.reason || null, status: FIRST[i.kind], created_by: actor ?? null }).select("id, code").single());
}

export async function setRequestStatus(inst: string, id: string, body: unknown) {
  const { status } = z.object({ status: z.string() }).strict().parse(body);
  const r = check(await supabaseAdmin.from("parent_requests").select("id, kind, status, guardian_id, new_number").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; kind: string; status: string; guardian_id: string; new_number: string | null } | null;
  if (!r) throw new HttpError(404, "Request not found.");
  if (!RK[r.kind].includes(status)) throw new HttpError(400, "That status is not available for this request.");
  if (["Approved", "Rejected", "Declined", "Booked", "Pass issued"].includes(r.status)) throw new HttpError(409, "This request is already closed.");
  if (r.kind === "mobile") {
    const order = ["Pending", "Code sent", "Number verified"];
    if (status === "Code sent" && r.status !== "Pending") throw new HttpError(409, "The code was already sent.");
    if (status === "Number verified" && r.status !== "Code sent") throw new HttpError(409, "Send the code to the new number first.");
    if (status === "Approved") {
      if (r.status !== "Number verified") throw new HttpError(409, "Verify the new number before approving.");
      check(await supabaseAdmin.from("guardians").update({ phone: r.new_number }).eq("id", r.guardian_id).eq("institution_id", inst).select("id"));
    }
    void order;
  }
  check(await supabaseAdmin.from("parent_requests").update({ status }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ feedback ═════════════
export async function listFeedback(inst: string, kind?: string) {
  let q = supabaseAdmin.from("parent_feedback").select("id, code, kind, guardian_id, student_id, about, comment, rating, raised_on, status, resolution, guardians:guardian_id(full_name)").eq("institution_id", inst);
  if (kind) q = q.eq("kind", kind);
  const rows = check(await q.order("raised_on", { ascending: false }).order("created_at", { ascending: false }).limit(2000)) as unknown as { id: string; code: string; kind: string; student_id: string | null; about: string; comment: string | null; rating: number | null; raised_on: string; status: string; resolution: string | null; guardians: { full_name: string } | { full_name: string }[] | null }[];
  const ro = await roster(inst);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  return { items: rows.map((r) => ({ id: r.id, code: r.code, kind: r.kind, about: r.about, comment: r.comment ?? "", rating: r.rating, raised_on: r.raised_on, status: r.status, resolution: r.resolution ?? "", parent: one(r.guardians)?.full_name ?? "", student: r.student_id ? kids.get(r.student_id)?.name ?? "" : "" })) };
}
export async function addFeedback(inst: string, body: unknown, actor?: string) {
  const i = z.object({ kind: z.enum(["feedback", "complaint"]), guardian_id: z.string().uuid("Choose the parent."), student_id: z.string().uuid().optional().or(z.literal("")), about: txt(150).min(2, "Enter what it is about."), comment: txt(2000).optional(), rating: z.number().int().min(1).max(5).optional() }).strict().parse(body);
  const g = check(await supabaseAdmin.from("guardians").select("id").eq("id", i.guardian_id).eq("institution_id", inst).maybeSingle());
  if (!g) throw new HttpError(404, "Parent not found.");
  return check(await supabaseAdmin.from("parent_feedback").insert({ institution_id: inst, kind: i.kind, guardian_id: i.guardian_id, student_id: i.student_id || null, about: i.about, comment: i.comment || null, rating: i.rating ?? null, created_by: actor ?? null }).select("id, code").single());
}
export async function setFeedbackStatus(inst: string, id: string, body: unknown) {
  const i = z.object({ status: z.enum(["Open", "In progress", "Resolved"]), resolution: txt(1000).optional() }).strict().parse(body);
  const r = check(await supabaseAdmin.from("parent_feedback").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null;
  if (!r) throw new HttpError(404, "Not found.");
  if (r.status === "Resolved") throw new HttpError(409, "This is already resolved.");
  check(await supabaseAdmin.from("parent_feedback").update({ status: i.status, ...(i.resolution ? { resolution: i.resolution } : {}) }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ app sign-ins ═════════════
export async function loginActivity(inst: string) {
  const g = check(await supabaseAdmin.from("guardians").select("id, full_name, login_status, last_login_at, last_device").eq("institution_id", inst).neq("login_status", "None").limit(10000)) as unknown as { id: string; full_name: string; login_status: string; last_login_at: string | null; last_device: string | null }[];
  const links = check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).limit(20000)) as unknown as { student_id: string; guardian_id: string }[];
  const ro = await roster(inst);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  const now = Date.now();
  const week = g.filter((x) => x.last_login_at && now - Date.parse(x.last_login_at) < 7 * 86400000);
  const day = g.filter((x) => x.last_login_at && now - Date.parse(x.last_login_at) < 86400000);
  return {
    total: g.length, signed_in: week.length, daily: day.length, never: g.filter((x) => !x.last_login_at).length,
    items: g.map((x) => ({ id: x.id, parent: x.full_name, student: kids.get(links.find((l) => l.guardian_id === x.id)?.student_id ?? "")?.name ?? "", device: x.last_device ?? "", last: x.last_login_at })).sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "")),
  };
}
