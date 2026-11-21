import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** Competitive exam programmes, mock tests, readiness, question bank and registrations. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const r1 = (n: number) => Math.round(n * 10) / 10;
const ready = (p: number | null) => (p === null ? "No mocks yet" : p >= 70 ? "On track" : p >= 50 ? "Borderline" : "Needs support");

async function base(inst: string) {
  const [p, m, t, r] = await Promise.all([
    supabaseAdmin.from("comp_programmes").select("id, name, exams, who, sessions_per_week, mentor:mentor_id(first_name, last_name)").eq("institution_id", inst).order("name"),
    supabaseAdmin.from("comp_members").select("programme_id, student_id, comp_programmes!inner(institution_id)").eq("comp_programmes.institution_id", inst).limit(50000),
    supabaseAdmin.from("comp_tests").select("id, programme_id, name, test_date, questions, minutes").eq("institution_id", inst).order("test_date", { ascending: false }),
    supabaseAdmin.from("comp_results").select("test_id, student_id, score_pct, comp_tests!inner(institution_id)").eq("comp_tests.institution_id", inst).limit(100000),
  ]);
  return { P: check(p) as unknown as { id: string; name: string; exams: string; who: string; sessions_per_week: number; mentor: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[], M: check(m) as { programme_id: string; student_id: string }[], T: check(t) as { id: string; programme_id: string; name: string; test_date: string; questions: number; minutes: number }[], R: check(r) as { test_id: string; student_id: string; score_pct: number }[] };
}
const last3 = (b: Awaited<ReturnType<typeof base>>, programme: string, student: string) => b.R.filter((x) => x.student_id === student && b.T.find((t) => t.id === x.test_id)?.programme_id === programme).map((x) => ({ d: b.T.find((t) => t.id === x.test_id)?.test_date ?? "", p: Number(x.score_pct) })).sort((a, c) => c.d.localeCompare(a.d)).slice(0, 3).reverse().map((x) => x.p);

export async function programmes(inst: string) {
  const b = await base(inst);
  const bank = check(await supabaseAdmin.from("comp_bank").select("easy, medium, hard").eq("institution_id", inst)) as { easy: number; medium: number; hard: number }[];
  const members = new Set(b.M.map((x) => x.student_id));
  const on = [...members].filter((s) => { const v = b.M.filter((x) => x.student_id === s).flatMap((x) => last3(b, x.programme_id, s)); return v.length && v.reduce((a, c) => a + c, 0) / v.length >= 70; }).length;
  return {
    students: members.size, mocks: b.T.length, on_track: members.size ? Math.round((on / members.size) * 100) : 0, questions: bank.reduce((n, x) => n + x.easy + x.medium + x.hard, 0),
    items: b.P.map((p) => { const mt = one(p.mentor); const tests = b.T.filter((t) => t.programme_id === p.id); const res = b.R.filter((x) => tests.some((t) => t.id === x.test_id)); return { id: p.id, name: p.name, exams: p.exams, who: p.who, students: b.M.filter((x) => x.programme_id === p.id).length, mentor: mt ? `${mt.first_name} ${mt.last_name}`.trim() : "", sessions: p.sessions_per_week, mocks: tests.length, average: res.length ? r1(res.reduce((n, x) => n + Number(x.score_pct), 0) / res.length) : null }; }),
  };
}
export async function addProgramme(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the programme.").max(100), exams: z.string().trim().max(200).optional(), who: z.string().trim().max(100).optional(), mentor_id: uid.nullable().optional(), sessions: z.number().int().min(0).max(14), student_ids: z.array(uid).max(2000).optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("comp_programmes").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That programme exists.");
  if (i.mentor_id) { const t = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", i.mentor_id).eq("institution_id", inst).maybeSingle()); if (!t) throw new HttpError(404, "Mentor not found."); }
  const p = check(await supabaseAdmin.from("comp_programmes").insert({ institution_id: inst, name: i.name, exams: i.exams ?? "", who: i.who ?? "", mentor_id: i.mentor_id ?? null, sessions_per_week: i.sessions }).select("id").single()) as { id: string };
  if (i.student_ids?.length) await addMembers(inst, { programme_id: p.id, student_ids: i.student_ids });
  return p;
}
export async function addMembers(inst: string, input: unknown) {
  const i = z.object({ programme_id: uid, student_ids: z.array(uid).min(1).max(2000) }).strict().parse(input);
  const p = check(await supabaseAdmin.from("comp_programmes").select("id").eq("id", i.programme_id).eq("institution_id", inst).maybeSingle());
  if (!p) throw new HttpError(404, "Programme not found.");
  const ok = new Set((await roster(inst)).items.map((r) => r.id));
  const rows = i.student_ids.filter((s) => ok.has(s)).map((student_id) => ({ programme_id: i.programme_id, student_id }));
  if (rows.length) check(await supabaseAdmin.from("comp_members").upsert(rows, { onConflict: "programme_id,student_id" }).select("student_id"));
  return { added: rows.length };
}

export async function tests(inst: string) {
  const b = await base(inst);
  const ro = new Map((await roster(inst)).items.map((r) => [r.id, r.name]));
  return { items: b.T.map((t) => { const res = b.R.filter((x) => x.test_id === t.id); const mem = b.M.filter((x) => x.programme_id === t.programme_id).length; const top = [...res].sort((a, c) => Number(c.score_pct) - Number(a.score_pct))[0]; return { id: t.id, name: t.name, programme: b.P.find((p) => p.id === t.programme_id)?.name ?? "", date: t.test_date, questions: t.questions, minutes: t.minutes, took: res.length, members: mem, average: res.length ? r1(res.reduce((n, x) => n + Number(x.score_pct), 0) / res.length) : null, top_score: top ? Number(top.score_pct) : null, top_name: top ? ro.get(top.student_id) ?? "" : "", status: t.test_date <= today() ? "Done" : "Upcoming" }; }) };
}
export async function addTest(inst: string, input: unknown) {
  const i = z.object({ programme_id: uid, name: z.string().trim().min(2, "Enter the test.").max(120), test_date: iso, questions: z.number().int().min(1).max(500), minutes: z.number().int().min(5).max(600) }).strict().parse(input);
  const p = check(await supabaseAdmin.from("comp_programmes").select("id").eq("id", i.programme_id).eq("institution_id", inst).maybeSingle());
  if (!p) throw new HttpError(404, "Programme not found.");
  return check(await supabaseAdmin.from("comp_tests").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function addResults(inst: string, input: unknown) {
  const i = z.object({ test_id: uid, results: z.array(z.object({ student_id: uid, score_pct: z.number().min(0).max(100) })).min(1).max(2000) }).strict().parse(input);
  const t = check(await supabaseAdmin.from("comp_tests").select("id, programme_id, test_date").eq("id", i.test_id).eq("institution_id", inst).maybeSingle()) as { id: string; programme_id: string; test_date: string } | null;
  if (!t) throw new HttpError(404, "Test not found.");
  if (t.test_date > today()) throw new HttpError(409, "That test hasn't happened yet.");
  const mem = new Set((check(await supabaseAdmin.from("comp_members").select("student_id").eq("programme_id", t.programme_id)) as { student_id: string }[]).map((x) => x.student_id));
  const rows = i.results.filter((r) => mem.has(r.student_id)).map((r) => ({ test_id: i.test_id, student_id: r.student_id, score_pct: r.score_pct }));
  if (!rows.length) throw new HttpError(400, "None of those students are in this programme.");
  check(await supabaseAdmin.from("comp_results").upsert(rows, { onConflict: "test_id,student_id" }).select("student_id"));
  return { saved: rows.length };
}

export async function readiness(inst: string, programmeId: string) {
  const b = await base(inst);
  const p = b.P.find((x) => x.id === programmeId) ?? b.P[0];
  if (!p) return { programmes: [], programme: null, students: [], counts: { on: 0, border: 0, needs: 0 }, items: [] };
  const ro = new Map((await roster(inst)).items.map((r) => [r.id, r]));
  const items = b.M.filter((m) => m.programme_id === p.id).map((m) => { const v = last3(b, p.id, m.student_id); const est = v.length ? r1(v.reduce((a, c) => a + c, 0) / v.length) : null; const s = ro.get(m.student_id); return { student_id: m.student_id, name: s?.name ?? "", class_label: s ? `${s.class_name} ${s.section}`.trim() : "", last3: v, est, readiness: ready(est) }; }).sort((a, c) => (c.est ?? -1) - (a.est ?? -1));
  return { programmes: b.P.map((x) => ({ id: x.id, name: x.name })), programme: { id: p.id, name: p.name, who: p.who }, students: items.length, counts: { on: items.filter((x) => x.readiness === "On track").length, border: items.filter((x) => x.readiness === "Borderline").length, needs: items.filter((x) => x.readiness === "Needs support").length }, items };
}

export async function bank(inst: string) {
  return { items: check(await supabaseAdmin.from("comp_bank").select("id, subject, easy, medium, hard, past_papers").eq("institution_id", inst).order("subject")) as { id: string; subject: string; easy: number; medium: number; hard: number; past_papers: string }[] };
}
export async function saveBank(inst: string, input: unknown) {
  const i = z.object({ subject: z.string().trim().min(2, "Enter the subject.").max(100), easy: z.number().int().min(0).max(100000), medium: z.number().int().min(0).max(100000), hard: z.number().int().min(0).max(100000), past_papers: z.string().trim().max(40).optional() }).strict().parse(input);
  check(await supabaseAdmin.from("comp_bank").upsert({ institution_id: inst, subject: i.subject, easy: i.easy, medium: i.medium, hard: i.hard, past_papers: i.past_papers ?? "" }, { onConflict: "institution_id,subject" }).select("id"));
  return { ok: true };
}

export async function registrations(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("comp_registrations").select("id, student_id, exam, exam_date, fee, status").eq("institution_id", inst).order("exam_date"), roster(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  return { students: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label })), items: (check(rows) as { id: string; student_id: string; exam: string; exam_date: string; fee: number; status: string }[]).map((x) => ({ ...x, name: k.get(x.student_id)?.name ?? "", class_label: k.get(x.student_id) ? `${k.get(x.student_id)!.class_name} ${k.get(x.student_id)!.section}`.trim() : "" })) };
}
export async function addRegistration(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, exam: z.string().trim().min(2, "Enter the exam.").max(100), exam_date: iso, fee: z.number().int().min(0).max(100000) }).strict().parse(input);
  if (!(await roster(inst)).items.some((r) => r.id === i.student_id)) throw new HttpError(404, "Student not found.");
  return check(await supabaseAdmin.from("comp_registrations").insert({ institution_id: inst, ...i, status: i.fee === 0 ? "Registered" : "Fee pending" }).select("id").single());
}
export async function setRegistration(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Fee pending", "Registered", "Admit card issued"]) }).strict().parse(input);
  const cur = check(await supabaseAdmin.from("comp_registrations").select("status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { status: string } | null;
  if (!cur) throw new HttpError(404, "Registration not found.");
  if (status === "Admit card issued" && cur.status === "Fee pending") throw new HttpError(409, "The fee is still pending.");
  check(await supabaseAdmin.from("comp_registrations").update({ status }).eq("id", id).select("id"));
  return { ok: true };
}
export async function remindParent(inst: string, id: string, actor?: string) {
  const r = check(await supabaseAdmin.from("comp_registrations").select("student_id, exam, fee, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { student_id: string; exam: string; fee: number; status: string } | null;
  if (!r) throw new HttpError(404, "Registration not found.");
  if (r.status !== "Fee pending") throw new HttpError(409, "No fee is pending.");
  const l = check(await supabaseAdmin.from("student_guardians").select("guardian_id, guardians:guardian_id!inner(institution_id)").eq("student_id", r.student_id).eq("guardians.institution_id", inst)) as { guardian_id: string }[];
  if (!l.length) throw new HttpError(409, "This student has no parent on record.");
  check(await supabaseAdmin.from("parent_messages").insert(l.map((x) => ({ institution_id: inst, kind: "notification", guardian_id: x.guardian_id, student_id: r.student_id, subject: `${r.exam} fee reminder`, body: `The fee of Rs ${r.fee} is pending.`, created_by: actor ?? null }))).select("id"));
  return { sent: l.length };
}
