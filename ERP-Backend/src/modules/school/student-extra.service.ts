import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getStudent, roster } from "./student-mgmt.service";

/** Student transfers, behaviour, health, achievements, withdrawals, certificates and reports for one school. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const txt = (n: number) => z.string().trim().max(n);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const blank = <T>(v: T | "" | undefined) => (v === "" || v === undefined ? null : v);

const KINDS: Record<string, { statuses: string[]; first: string }> = {
  transfer_within: { statuses: ["Pending", "Approved", "Rejected", "Completed"], first: "Pending" },
  transfer_campus: { statuses: ["Pending", "Approved", "Rejected", "Completed"], first: "Pending" },
  behaviour: { statuses: ["Open", "Parent informed", "Closed"], first: "Open" },
  disciplinary: { statuses: ["Open", "Parent informed", "Closed"], first: "Open" },
  remark: { statuses: ["Open", "Parent informed", "Closed"], first: "Open" },
  medical: { statuses: ["Active", "Resolved"], first: "Active" },
  incident: { statuses: ["Active", "Resolved"], first: "Active" },
  ach_academic: { statuses: ["Pending", "Verified"], first: "Pending" },
  ach_sports: { statuses: ["Pending", "Verified"], first: "Pending" },
  ach_cultural: { statuses: ["Pending", "Verified"], first: "Pending" },
};

export async function campuses(inst: string) {
  return check(await supabaseAdmin.from("campuses").select("id, name").eq("institution_id", inst).order("name")) as { id: string; name: string }[];
}

export async function listRecords(inst: string, kind: string) {
  if (!KINDS[kind]) throw new HttpError(404, "Unknown record type.");
  const [rows, ro] = await Promise.all([
    supabaseAdmin.from("stu_records").select("id, student_id, kind, title, extra, from_label, to_label, to_ref, record_date, status, created_at, students:student_id(first_name, last_name, registration_no)").eq("institution_id", inst).eq("kind", kind).order("record_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000),
    roster(inst),
  ]);
  const by = new Map(ro.items.map((r) => [r.id, r]));
  const profiles = new Map<string, string>();
  if (kind === "medical" || kind === "incident") {
    const ids = [...new Set(((rows.data ?? []) as { student_id: string }[]).map((r) => r.student_id))];
    if (ids.length) for (const p of ((await supabaseAdmin.from("student_profiles").select("student_id, blood_group").in("student_id", ids)).data ?? []) as { student_id: string; blood_group: string | null }[]) profiles.set(p.student_id, p.blood_group ?? "");
  }
  const items = ((check(rows) as unknown) as { student_id: string; students: { first_name: string; last_name: string; registration_no: string } | { first_name: string; last_name: string; registration_no: string }[] | null }[]).map((r) => {
    const s = one(r.students);
    return { ...r, students: undefined, name: s ? `${s.first_name} ${s.last_name}` : "", registration_no: s?.registration_no ?? "", class_label: by.get(r.student_id)?.class_label ?? "", blood_group: profiles.get(r.student_id) ?? "" };
  });
  return { items, statuses: KINDS[kind].statuses };
}

export async function addRecord(inst: string, body: unknown, actor?: string) {
  const i = z.object({ kind: z.enum(Object.keys(KINDS) as [string, ...string[]]), student_id: z.string().uuid(), title: txt(300).min(2, "Describe it in a few words."), extra: txt(150).optional(), to_label: txt(80).optional(), to_ref: z.string().uuid().optional(), record_date: date.optional() }).strict().parse(body);
  const s = await getStudent(inst, i.student_id);
  const ro = await roster(inst);
  const from = ro.items.find((r) => r.id === i.student_id)?.class_label ?? "";
  if (i.kind === "transfer_within" && i.to_ref) {
    const sec = check(await supabaseAdmin.from("sections").select("id").eq("id", i.to_ref).eq("institution_id", inst).maybeSingle());
    if (!sec) throw new HttpError(400, "Choose a section of this school.");
  }
  void s;
  return check(await supabaseAdmin.from("stu_records").insert({ institution_id: inst, student_id: i.student_id, kind: i.kind, title: i.title, extra: blank(i.extra), from_label: i.kind.startsWith("transfer") ? from : null, to_label: blank(i.to_label), to_ref: i.to_ref ?? null, record_date: i.record_date ?? new Date().toISOString().slice(0, 10), status: KINDS[i.kind].first, created_by: actor ?? null }).select("id").single());
}

export async function setRecordStatus(inst: string, id: string, body: unknown) {
  const { status } = z.object({ status: txt(20) }).strict().parse(body);
  const rec = check(await supabaseAdmin.from("stu_records").select("id, student_id, kind, to_ref, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { student_id: string; kind: string; to_ref: string | null; status: string } | null;
  if (!rec) throw new HttpError(404, "Record not found.");
  if (!KINDS[rec.kind].statuses.includes(status)) throw new HttpError(400, "That status does not apply here.");
  // completing a transfer moves the student
  if (status === "Completed" && rec.status !== "Completed" && rec.to_ref) {
    if (rec.kind === "transfer_within") {
      const sec = check(await supabaseAdmin.from("sections").select("id, grade_id, academic_year_id").eq("id", rec.to_ref).maybeSingle()) as { id: string; grade_id: string; academic_year_id: string } | null;
      if (sec) check(await supabaseAdmin.from("student_enrollments").update({ grade_id: sec.grade_id, section_id: sec.id, roll_no: null }).eq("student_id", rec.student_id).eq("academic_year_id", sec.academic_year_id).select("id"));
    } else if (rec.kind === "transfer_campus") {
      check(await supabaseAdmin.from("students").update({ campus_id: rec.to_ref }).eq("id", rec.student_id).eq("institution_id", inst).select("id"));
    }
  }
  check(await supabaseAdmin.from("stu_records").update({ status }).eq("id", id).eq("institution_id", inst).select("id"));
  return { success: true };
}

// ═════════════ withdrawals ═════════════
export async function listWithdrawals(inst: string) {
  const [rows, ro] = await Promise.all([
    supabaseAdmin.from("stu_withdrawals").select("id, student_id, code, reason, last_day, dues, requested_on, status, students:student_id(first_name, last_name, registration_no)").eq("institution_id", inst).order("requested_on", { ascending: false }).order("code", { ascending: false }).limit(2000),
    roster(inst),
  ]);
  const by = new Map(ro.items.map((r) => [r.id, r]));
  return ((check(rows) as unknown) as { student_id: string; students: { first_name: string; last_name: string; registration_no: string } | { first_name: string; last_name: string; registration_no: string }[] | null }[]).map((r) => { const s = one(r.students); return { ...r, students: undefined, name: s ? `${s.first_name} ${s.last_name}` : "", registration_no: s?.registration_no ?? "", class_label: by.get(r.student_id)?.class_label ?? "" }; });
}
export async function addWithdrawal(inst: string, body: unknown, actor?: string) {
  const i = z.object({ student_id: z.string().uuid(), reason: txt(200).min(2, "Give a reason."), last_day: date, dues: z.number().int().min(0).max(100_000_000).optional() }).strict().parse(body);
  await getStudent(inst, i.student_id);
  const open = check(await supabaseAdmin.from("stu_withdrawals").select("id").eq("institution_id", inst).eq("student_id", i.student_id).in("status", ["Pending", "Approved"]).limit(1)) as unknown[];
  if (open.length) throw new HttpError(409, "That student already has an open withdrawal request.");
  return check(await supabaseAdmin.from("stu_withdrawals").insert({ institution_id: inst, student_id: i.student_id, reason: i.reason, last_day: i.last_day, dues: i.dues ?? 0, created_by: actor ?? null }).select("id, code").single());
}
export async function setWithdrawalStatus(inst: string, id: string, body: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected", "Completed"]) }).strict().parse(body);
  const w = check(await supabaseAdmin.from("stu_withdrawals").select("id, student_id, status, dues").eq("id", id).eq("institution_id", inst).maybeSingle()) as { student_id: string; status: string; dues: number } | null;
  if (!w) throw new HttpError(404, "Request not found.");
  if (status === "Completed" && w.status !== "Approved") throw new HttpError(400, "Approve the request first.");
  if (status !== "Completed" && w.status !== "Pending") throw new HttpError(400, "That request was already decided.");
  if (status === "Completed" && w.dues > 0) throw new HttpError(400, "Clear the dues before completing the withdrawal.");
  check(await supabaseAdmin.from("stu_withdrawals").update({ status }).eq("id", id).eq("institution_id", inst).select("id"));
  if (status === "Completed") {
    check(await supabaseAdmin.from("students").update({ status: "Left" }).eq("id", w.student_id).eq("institution_id", inst).select("id"));
    await supabaseAdmin.from("student_enrollments").update({ status: "Left" }).eq("student_id", w.student_id).in("status", ["Active"]);
  }
  return { success: true };
}
export async function setWithdrawalDues(inst: string, id: string, body: unknown) {
  const { dues } = z.object({ dues: z.number().int().min(0).max(100_000_000) }).strict().parse(body);
  const r = check(await supabaseAdmin.from("stu_withdrawals").update({ dues }).eq("id", id).eq("institution_id", inst).select("id").maybeSingle());
  if (!r) throw new HttpError(404, "Request not found.");
  return { success: true };
}

// ═════════════ certificates ═════════════
const CERT = ["Bonafide", "Study", "Character", "Transfer"] as const;
export async function nextCertNo(inst: string) {
  const school = check(await supabaseAdmin.from("institutions").select("code").eq("id", inst).maybeSingle()) as { code: string } | null;
  const { count } = await supabaseAdmin.from("stu_certificates").select("*", { count: "exact", head: true }).eq("institution_id", inst);
  return `${(school?.code ?? "SCH").slice(0, 6)}/CRT/${new Date().getFullYear()}/${String(1001 + (count ?? 0))}`;
}
export async function certificateData(inst: string, id: string) {
  const s = await getStudent(inst, id);
  const school = check(await supabaseAdmin.from("institutions").select("name, address, city, board").eq("id", inst).maybeSingle()) as { name: string; address: string | null; city: string | null; board: string | null } | null;
  const father = s.guardians.find((g) => g.relation === "Father") ?? s.guardians[0];
  const ro = await roster(inst);
  return { school: { name: school?.name ?? "", place: [school?.address, school?.city].filter(Boolean).join(", "), board: school?.board ?? "" }, year: ro.year?.name ?? "", cert_no: await nextCertNo(inst), student: { name: `${s.personal.first_name} ${s.personal.last_name}`.trim(), registration_no: s.registration_no, class_label: s.academic.class_label, date_of_birth: s.personal.date_of_birth, father: (father as { full_name?: string } | undefined)?.full_name ?? "" } };
}
export async function issueCertificate(inst: string, body: unknown, actor?: string) {
  const i = z.object({ student_id: z.string().uuid(), kind: z.enum(CERT), purpose: txt(150).optional(), issued_on: date.optional() }).strict().parse(body);
  await getStudent(inst, i.student_id);
  const cert_no = await nextCertNo(inst);
  return check(await supabaseAdmin.from("stu_certificates").insert({ institution_id: inst, student_id: i.student_id, kind: i.kind, cert_no, purpose: blank(i.purpose), issued_on: i.issued_on ?? new Date().toISOString().slice(0, 10), issued_by: actor ?? null }).select("id, cert_no").single());
}
export async function listCertificates(inst: string) {
  const rows = check(await supabaseAdmin.from("stu_certificates").select("id, kind, cert_no, purpose, issued_on, students:student_id(first_name, last_name)").eq("institution_id", inst).order("created_at", { ascending: false }).limit(500)) as unknown as { students: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return rows.map((r) => { const s = one(r.students); return { ...r, students: undefined, name: s ? `${s.first_name} ${s.last_name}` : "" }; });
}
