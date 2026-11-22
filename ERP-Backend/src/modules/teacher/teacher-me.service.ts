import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getMyProfile } from "../school/profile.service";
import { cycleName } from "../school/hr3.service";
import { claimRules } from "../school/fees4.service";
import { statutory } from "../school/pay.service";
import { breakdown } from "../school/pay2.service";
import { whoAmI } from "./teacher.service";

/** The teacher's own record: contact, qualifications, documents, payslips, 360° feedback, claims and appraisal. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const years = (from: string | null) => (from ? Math.max(0, Math.floor((Date.now() - Date.parse(from)) / (365.25 * 86400000))) : null);

// ═════════════ personal details ═════════════
export async function profile(inst: string, me: string) {
  const [p, who, c, ct] = await Promise.all([getMyProfile(me), whoAmI(inst, me), supabaseAdmin.from("staff_contact_details").select("show_mobile_to_parents").eq("profile_id", me).maybeSingle(), supabaseAdmin.from("sections").select("name, grades:grade_id(name)").eq("institution_id", inst).eq("class_teacher_id", me).limit(1)]);
  const sec = one((check(ct) ?? []) as unknown as { name: string; grades: { name: string } | { name: string }[] | null }[]);
  return {
    ...p, emp_code: who.emp_code, subjects: who.subjects, department: who.department,
    class_teacher_of: sec ? `Class ${(one(sec.grades)?.name ?? "").replace(/^(Grade|Class)\s+/i, "")} ${sec.name}`.replace(/\s+/g, " ").trim() : null,
    joined_on: who.joined_on ?? p.joined_on, experience_years: years(who.joined_on ?? p.joined_on),
    show_mobile_to_parents: !!(check(c) as { show_mobile_to_parents: boolean } | null)?.show_mobile_to_parents,
  };
}

export async function saveContact(inst: string, me: string, input: unknown) {
  const i = z.object({
    mobile: z.string().trim().max(30).optional(), alt_phone: z.string().trim().max(30).optional(), personal_email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(),
    home_address: z.string().trim().max(500).optional(), emergency_name: z.string().trim().max(150).optional(), emergency_relation: z.string().trim().max(40).optional(), emergency_phone: z.string().trim().max(30).optional(), show_mobile_to_parents: z.boolean().optional(),
  }).strict().parse(input);
  const keep = check(await supabaseAdmin.from("staff_contact_details").select("date_of_birth, blood_group").eq("profile_id", me).maybeSingle()) as { date_of_birth: string | null; blood_group: string | null } | null;
  if (i.mobile !== undefined) check(await supabaseAdmin.from("user_profiles").update({ phone: i.mobile || null, updated_at: new Date().toISOString() }).eq("id", me).eq("institution_id", inst).select("id"));
  const row = {
    profile_id: me, alt_phone: i.alt_phone || null, personal_email: i.personal_email || null, home_address: i.home_address || null, emergency_name: i.emergency_name || null, emergency_relation: i.emergency_relation || null, emergency_phone: i.emergency_phone || null,
    show_mobile_to_parents: i.show_mobile_to_parents ?? false, date_of_birth: keep?.date_of_birth ?? null, blood_group: keep?.blood_group ?? null, updated_at: new Date().toISOString(),
  };
  check(await supabaseAdmin.from("staff_contact_details").upsert(row, { onConflict: "profile_id" }).select("profile_id"));
  return profile(inst, me);
}

export async function qualifications(me: string) {
  return { items: check(await supabaseAdmin.from("staff_qualifications").select("id, title, subject, institution, year, result, status, certificate_name, created_at").eq("profile_id", me).order("year", { ascending: false })) as unknown[] };
}

export async function addQualification(me: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the qualification.").max(200), subject: z.string().trim().max(150).optional(), institution: z.string().trim().min(2, "Enter the institution.").max(200), year: z.number().int().min(1950).max(2100), result: z.string().trim().max(100).optional(), certificate_name: z.string().trim().max(160).optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("staff_qualifications").insert({ profile_id: me, title: i.title, subject: i.subject || null, institution: i.institution, year: i.year, result: i.result || null, certificate_name: i.certificate_name || null }).select("id, title, subject, institution, year, result, status, certificate_name").single());
}

// ═════════════ documents ═════════════
const DOC_DEFAULTS: [string, string][] = [["Aadhaar card", "ID proof"], ["PAN card", "Tax"], ["Educational certificates", "Qualification"], ["Medical fitness certificate", "Health"]];
export const DOC_TYPES = ["ID proof", "Tax", "Qualification", "Eligibility", "Background check", "Health", "Certificates", "Contracts"] as const;

async function requirements(inst: string) {
  let r = check(await supabaseAdmin.from("hr_doc_requirements").select("title, doc_type, due_on").eq("institution_id", inst)) as { title: string; doc_type: string; due_on: string | null }[];
  if (!r.length) {
    check(await supabaseAdmin.from("hr_doc_requirements").upsert(DOC_DEFAULTS.map(([title, doc_type]) => ({ institution_id: inst, title, doc_type })), { onConflict: "institution_id,title" }).select("title"));
    r = DOC_DEFAULTS.map(([title, doc_type]) => ({ title, doc_type, due_on: null }));
  }
  return r;
}

export async function documents(inst: string, me: string) {
  const [req, docs] = await Promise.all([requirements(inst), supabaseAdmin.from("hr_documents").select("id, title, doc_type, file_name, uploaded_on, valid_until, status").eq("institution_id", inst).eq("staff_id", me).order("uploaded_on", { ascending: false }).limit(200)]);
  const have = (check(docs) ?? []) as { id: string; title: string | null; doc_type: string; file_name: string; uploaded_on: string; valid_until: string | null; status: string }[];
  const items = have.map((d) => ({ id: d.id, title: d.title || d.file_name, type: d.doc_type, file_name: d.file_name, uploaded_on: d.uploaded_on, valid_until: d.valid_until, due_on: null as string | null, status: d.status === "Verified" ? "Verified" : "Pending review" }));
  const titles = new Set(items.map((d) => d.title.toLowerCase()));
  const missing = req.filter((r) => !titles.has(r.title.toLowerCase())).map((r) => ({ id: null as string | null, title: r.title, type: r.doc_type, file_name: "", uploaded_on: null as string | null, valid_until: null as string | null, due_on: r.due_on, status: "Missing" }));
  return { items: [...items, ...missing], requirements: req.map((r) => ({ title: r.title, type: r.doc_type })), missing: missing.map((m) => ({ title: m.title, due_on: m.due_on })) };
}

export async function uploadDocument(inst: string, me: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2).max(120), type: z.enum(DOC_TYPES), file_name: z.string().trim().min(1).max(160), valid_until: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional() }).strict().parse(input);
  if (!/\.(pdf|jpe?g|png)$/i.test(i.file_name)) throw new HttpError(400, "Upload a PDF or a photo.");
  const req = await requirements(inst);
  const asked = req.find((r) => r.title.toLowerCase() === i.title.toLowerCase());
  const type = asked?.doc_type ?? i.type;
  check(await supabaseAdmin.from("hr_documents").delete().eq("institution_id", inst).eq("staff_id", me).ilike("title", i.title));
  return check(await supabaseAdmin.from("hr_documents").insert({ institution_id: inst, staff_id: me, title: i.title, doc_type: type, file_name: i.file_name, valid_until: i.valid_until || null, status: "Pending review" }).select("id").single());
}

// ═════════════ payslips ═════════════
export async function payslips(inst: string, me: string, month?: string) {
  const [runs, assign, hs, who, school] = await Promise.all([
    supabaseAdmin.from("pay_runs").select("id, month, status, payslips_on").eq("institution_id", inst).order("month", { ascending: false }).limit(36),
    supabaseAdmin.from("pay_assign").select("basic, other_ded").eq("staff_id", me).eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("hr_staff").select("bank_name, bank_account, monthly_salary").eq("profile_id", me).eq("institution_id", inst).maybeSingle(),
    whoAmI(inst, me),
    supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle(),
  ]);
  const shared = ((check(runs) ?? []) as { id: string; month: string; status: string; payslips_on: string | null }[]).filter((r) => r.status === "Paid" || !!r.payslips_on);
  const lines = shared.length ? (check(await supabaseAdmin.from("pay_run_lines").select("run_id, working_days, present, paid_leave, lop, gross, deductions, net").eq("staff_id", me).in("run_id", shared.map((r) => r.id))) ?? []) as { run_id: string; working_days: number; present: number; paid_leave: number; lop: number; gross: number; deductions: number; net: number }[] : [];
  const L = new Map(lines.map((l) => [l.run_id, l]));
  const months = shared.filter((r) => L.has(r.id)).map((r) => ({ month: r.month, net: L.get(r.id)!.net, status: r.status === "Paid" ? "Paid" : "Approved" }));
  const pick = month && months.some((m) => m.month === month) ? month : months[0]?.month ?? null;
  const a = check(assign) as { basic: number; other_ded: number } | null;
  const bank = check(hs) as { bank_name: string | null; bank_account: string | null; monthly_salary: number | null } | null;
  let slip: unknown = null;
  if (pick) {
    const run = shared.find((r) => r.month === pick)!; const l = L.get(run.id)!;
    const basic = a?.basic ?? Math.round(l.gross * 0.5);
    const st = statutory(l.gross, basic, a?.other_ded ?? 0);
    const b = breakdown(l.gross, basic, st);
    const lop = Math.max(0, l.deductions - st.total);
    slip = { month: pick, school: (check(school) as { name: string } | null)?.name ?? "", employee: who.name, emp_code: who.emp_code, designation: who.designation || who.line, bank: bank?.bank_account ? `${bank.bank_name ?? "Bank"} ••${bank.bank_account.slice(-4)}` : null, days_paid: Number(l.present) + Number(l.paid_leave), earnings: b.earnings, deductions: lop > 0 ? [...b.deductions, ["Loss of pay", lop]] : b.deductions, gross: l.gross, total_deductions: l.deductions, net: l.net, paid: run.status === "Paid" };
  }
  const fy = (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return { from: `${y}-04`, to: `${y + 1}-03` }; })();
  const year = months.filter((m) => m.month >= fy.from && m.month <= fy.to);
  return { months, selected: pick, slip, this_year: { net: year.reduce((s, m) => s + m.net, 0), count: year.length }, bank_last4: bank?.bank_account ? bank.bank_account.slice(-4) : null, bank_name: bank?.bank_name ?? null };
}

// ═════════════ 360° feedback ═════════════
export const PEER_QUESTIONS = ["Subject knowledge", "Classroom management", "Collaboration", "Communication", "Reliability"] as const;
const WEIGHTS = { self: 10, peers: 20, hod: 30, students: 25, parents: 15 } as const;

/** The colleagues this teacher rates this cycle; the school's picks are made once, from the other teaching staff. */
async function peerAssignments(inst: string, me: string, cycle: string) {
  const have = check(await supabaseAdmin.from("hr_peer_feedback").select("ratee_id, scores, submitted_at").eq("institution_id", inst).eq("cycle", cycle).eq("rater_id", me)) as { ratee_id: string; scores: Record<string, number>; submitted_at: string | null }[];
  if (have.length) return have;
  const staff = check(await supabaseAdmin.from("hr_staff").select("profile_id").eq("institution_id", inst).eq("staff_type", "Teaching").neq("profile_id", me).limit(500)) as { profile_id: string }[];
  if (!staff.length) return [];
  const ids = staff.map((s) => s.profile_id).sort();
  // rotate by this teacher's id so colleagues are not all rated by the same people
  const start = parseInt(me.replace(/-/g, "").slice(0, 6), 16) % ids.length;
  const picks = Array.from({ length: Math.min(3, ids.length) }, (_, k) => ids[(start + k) % ids.length]);
  check(await supabaseAdmin.from("hr_peer_feedback").upsert(picks.map((ratee_id) => ({ institution_id: inst, cycle, rater_id: me, ratee_id })), { onConflict: "institution_id,cycle,rater_id,ratee_id" }).select("ratee_id"));
  return picks.map((ratee_id) => ({ ratee_id, scores: {} as Record<string, number>, submitted_at: null as string | null }));
}

export async function peerFeedback(inst: string, me: string) {
  const cycle = await cycleName(inst);
  const asg = await peerAssignments(inst, me, cycle);
  const people = asg.length ? (check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, designation").in("id", asg.map((a) => a.ratee_id)).eq("institution_id", inst)) as { id: string; first_name: string; last_name: string; designation: string | null }[]) : [];
  const P = new Map(people.map((p) => [p.id, p]));
  const subj = asg.length ? (check(await supabaseAdmin.from("teacher_subjects").select("teacher_id, subjects:subject_id(name)").eq("institution_id", inst).in("teacher_id", asg.map((a) => a.ratee_id))) as unknown as { teacher_id: string; subjects: { name: string } | { name: string }[] | null }[]) : [];
  return {
    cycle, questions: PEER_QUESTIONS,
    items: asg.filter((a) => P.has(a.ratee_id)).map((a) => { const p = P.get(a.ratee_id)!; return { ratee_id: a.ratee_id, name: `${p.first_name} ${p.last_name}`.trim(), role: p.designation ?? "", subject: one(subj.find((s) => s.teacher_id === a.ratee_id)?.subjects ?? null)?.name ?? "", status: a.submitted_at ? "Submitted" : "Due", scores: a.scores }; }),
  };
}

export async function submitPeer(inst: string, me: string, rateeId: string, input: unknown) {
  const i = z.object({ scores: z.record(z.string(), z.number().int().min(1).max(5)) }).strict().parse(input);
  if (PEER_QUESTIONS.some((q) => i.scores[q] === undefined)) throw new HttpError(400, "Rate every line from 1 to 5.");
  const clean = Object.fromEntries(PEER_QUESTIONS.map((q) => [q, i.scores[q]]));
  const cycle = await cycleName(inst);
  const r = check(await supabaseAdmin.from("hr_peer_feedback").update({ scores: clean, submitted_at: new Date().toISOString() }).eq("institution_id", inst).eq("cycle", cycle).eq("rater_id", me).eq("ratee_id", rateeId).is("submitted_at", null).select("ratee_id")) as unknown[];
  if (!r.length) throw new HttpError(409, "This colleague is not on your list, or you have already rated them.");
  return { ok: true };
}

export async function feedbackResults(inst: string, me: string) {
  const cycle = await cycleName(inst);
  const [row, peers] = await Promise.all([
    supabaseAdmin.from("hr_feedback360").select("self_score, peers, hod, students, parents, students_n, parents_n").eq("institution_id", inst).eq("staff_id", me).eq("cycle", cycle).maybeSingle(),
    supabaseAdmin.from("hr_peer_feedback").select("scores").eq("institution_id", inst).eq("cycle", cycle).eq("ratee_id", me).not("submitted_at", "is", null),
  ]);
  const r = check(row) as { self_score: number | null; peers: number | null; hod: number | null; students: number | null; parents: number | null; students_n: number; parents_n: number } | null;
  const pr = (check(peers) ?? []) as { scores: Record<string, number> }[];
  const peerAvg = pr.length ? Math.round((pr.reduce((s, p) => { const v = Object.values(p.scores); return s + v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); }, 0) / pr.length) * 10) / 10 : (r?.peers ?? null);
  const groups = [
    { key: "self", label: "Self", weight: WEIGHTS.self, score: r?.self_score ?? null, n: r?.self_score !== null && r ? 1 : 0 },
    { key: "peers", label: "Peers", weight: WEIGHTS.peers, score: peerAvg, n: pr.length },
    { key: "hod", label: "HOD", weight: WEIGHTS.hod, score: r?.hod ?? null, n: r?.hod !== null && r?.hod !== undefined ? 1 : 0 },
    { key: "students", label: "Students", weight: WEIGHTS.students, score: r?.students ?? null, n: r?.students_n ?? 0 },
    { key: "parents", label: "Parents", weight: WEIGHTS.parents, score: r?.parents ?? null, n: r?.parents_n ?? 0 },
  ].map((g) => ({ ...g, score: g.score === null ? null : Number(g.score) }));
  const have = groups.filter((g) => g.score !== null);
  const w = have.reduce((s, g) => s + g.weight, 0);
  const total = w ? Math.round((have.reduce((s, g) => s + (g.score as number) * g.weight, 0) / w) * 100) / 100 : null;
  const best = [...have].sort((a, b) => (b.score as number) - (a.score as number))[0] ?? null;
  const worst = [...have].sort((a, b) => (a.score as number) - (b.score as number))[0] ?? null;
  return { cycle, score: total, responses: groups.reduce((s, g) => s + g.n, 0), groups, strongest: best, to_work_on: worst && worst !== best ? worst : null };
}

export async function competencies(inst: string, me: string) {
  const [rows, who] = await Promise.all([supabaseAdmin.from("hr_competency").select("competency, level, expected, training").eq("institution_id", inst).eq("staff_id", me).order("competency"), whoAmI(inst, me)]);
  const items = ((check(rows) ?? []) as { competency: string; level: number; expected: number; training: string }[]).map((c) => ({ ...c, gap: Math.max(0, c.expected - c.level) }));
  return { who: { name: who.name, role: who.designation || who.line, emp_code: who.emp_code, subject: who.subjects[0] ?? "" }, items };
}

// ═════════════ claims ═════════════
export async function claims(inst: string, me: string) {
  const [rules, mine] = await Promise.all([claimRules(inst), supabaseAdmin.from("staff_claims").select("id, code, ctype, description, claim_on, amount, receipts, status, paid_on").eq("institution_id", inst).eq("staff_id", me).order("claim_on", { ascending: false }).limit(200)]);
  return { rules: rules.items, items: check(mine) as unknown[] };
}

export async function submitClaim(inst: string, me: string, input: unknown) {
  const i = z.object({ ctype: z.string().trim().min(1).max(20), claim_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date."), amount: z.number().int().min(1, "Enter the amount.").max(10000000), description: z.string().trim().min(3, "Say what it was for.").max(200), receipts: z.number().int().min(0).max(20) }).strict().parse(input);
  const rule = (await claimRules(inst)).items.find((r) => r.ctype === i.ctype);
  if (!rule) throw new HttpError(400, "Choose one of the listed claim types.");
  if (i.claim_on > today()) throw new HttpError(400, "The date cannot be in the future.");
  if (i.claim_on < new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)) throw new HttpError(400, "Claims older than 90 days cannot be submitted.");
  if (rule.limit_amount && i.amount > rule.limit_amount) throw new HttpError(400, `${rule.ctype} claims are limited to ${rule.limit_text}.`);
  if (i.amount > rule.receipt_above && i.receipts < 1) throw new HttpError(400, `Add a photo of the bill: receipts are needed ${rule.receipt_text.toLowerCase()}.`);
  return check(await supabaseAdmin.from("staff_claims").insert({ institution_id: inst, staff_id: me, ctype: i.ctype, description: i.description, claim_on: i.claim_on, amount: i.amount, receipts: i.receipts, status: "Submitted" }).select("id, code").single());
}

// ═════════════ appraisal ═════════════
export async function appraisal(inst: string, me: string) {
  const cycle = await cycleName(inst);
  const who = await whoAmI(inst, me);
  const grp = who.staff_type === "Teaching" ? "Teacher" : "Non-teaching";
  const [kras, lines, cy] = await Promise.all([
    supabaseAdmin.from("hr_kras").select("id, area, weight, measure").eq("institution_id", inst).eq("grp", grp).order("weight", { ascending: false }),
    supabaseAdmin.from("hr_self_appraisal").select("kra_id, score, evidence").eq("institution_id", inst).eq("staff_id", me).eq("cycle", cycle),
    supabaseAdmin.from("hr_cycle").select("reviewer, self_score, reviewer_score, closed, goals, self_submitted_on").eq("institution_id", inst).eq("staff_id", me).eq("cycle", cycle).maybeSingle(),
  ]);
  const L = new Map(((check(lines) ?? []) as { kra_id: string; score: number; evidence: string }[]).map((l) => [l.kra_id, l]));
  const c = check(cy) as { reviewer: string; self_score: number | null; reviewer_score: number | null; closed: boolean; goals: string; self_submitted_on: string | null } | null;
  const self = c?.self_score === null || c?.self_score === undefined ? null : Number(c.self_score);
  const rev = c?.reviewer_score === null || c?.reviewer_score === undefined ? null : Number(c.reviewer_score);
  const final = self !== null && rev !== null ? Math.round(self * 30 + rev * 70) / 100 : null;
  const status = c?.closed ? "Closed" : rev !== null ? "Moderation" : c?.self_submitted_on ? "With reviewer" : "Self-review due";
  return {
    cycle, reviewer: c?.reviewer ?? "", group: grp, status, locked: !!c?.self_submitted_on || c?.closed === true || rev !== null,
    self_score: self, reviewer_score: rev, final_score: final, goals: c?.goals ?? "", submitted_on: c?.self_submitted_on ?? null,
    kras: ((check(kras) ?? []) as { id: string; area: string; weight: number; measure: string }[]).map((k) => ({ ...k, score: L.get(k.id)?.score ?? null, evidence: L.get(k.id)?.evidence ?? "" })),
  };
}

export async function submitAppraisal(inst: string, me: string, input: unknown) {
  const i = z.object({ goals: z.string().trim().max(1500).optional(), lines: z.array(z.object({ kra_id: z.string().uuid(), score: z.number().int().min(1).max(5), evidence: z.string().trim().max(1000).optional() }).strict()).min(1).max(30) }).strict().parse(input);
  const cur = await appraisal(inst, me);
  if (cur.locked) throw new HttpError(409, "Your self-appraisal has already gone to your reviewer.");
  const ok = new Map(cur.kras.map((k) => [k.id, k]));
  if (i.lines.some((l) => !ok.has(l.kra_id))) throw new HttpError(400, "One of the areas is not on your list.");
  if (new Set(i.lines.map((l) => l.kra_id)).size !== ok.size) throw new HttpError(400, "Score every area before you submit.");
  const cycle = cur.cycle;
  check(await supabaseAdmin.from("hr_self_appraisal").upsert(i.lines.map((l) => ({ institution_id: inst, staff_id: me, cycle, kra_id: l.kra_id, score: l.score, evidence: l.evidence ?? "" })), { onConflict: "institution_id,staff_id,cycle,kra_id" }).select("kra_id"));
  const wsum = cur.kras.reduce((s, k) => s + k.weight, 0) || 1;
  const self = Math.round((i.lines.reduce((s, l) => s + l.score * (ok.get(l.kra_id)!.weight), 0) / wsum) * 10) / 10;
  check(await supabaseAdmin.from("hr_cycle").upsert({ institution_id: inst, staff_id: me, cycle, reviewer: cur.reviewer, self_score: self, goals: i.goals ?? "", self_submitted_on: today() }, { onConflict: "institution_id,staff_id,cycle" }).select("staff_id"));
  return { ok: true, self_score: self };
}
