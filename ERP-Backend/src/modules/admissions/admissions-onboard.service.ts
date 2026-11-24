import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { admissionFees, feeSetup } from "../school/front-office.service";
import { admissionYear, classOf, load, type App } from "./admissions.service";

/**
 * Admissions portal: the money and class steps after approval (fee assignment, registration, class allocation), the Admitted
 * list and the reports. Reads the same adm_* tables as the School Admin portal; every query names the school.
 */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

// ═════════════ fee assignment (the admission fee, once the application is approved) ═════════════
export async function feeAssignment(inst: string) {
  const d = await load(inst);
  const items = [];
  for (const f of d.families.filter((x) => x.kind === "application" && x.status === "Active" && x.step === 7)) {
    const fee = await admissionFees(inst, f.class_sought);
    items.push({ application_id: f.id, code: f.code, child: f.child, class_sought: f.class_sought, admission_fee: fee?.admission_fee ?? 0, caution: fee?.caution ?? 0, total: (fee?.admission_fee ?? 0) + (fee?.caution ?? 0) });
  }
  return { items };
}

export async function feeStructure(inst: string) {
  const s = await feeSetup(inst);
  return { year: await admissionYear(inst), rows: s.rows, pay_within_days: s.pay_within_days };
}

// ═════════════ registration ═════════════
export async function toRegister(inst: string) {
  const d = await load(inst);
  const ids = d.families.filter((x) => x.kind === "application" && x.status === "Active" && x.step === 8).map((x) => x.id);
  const pays = ids.length ? (check(await supabaseAdmin.from("adm_fee_payments").select("application_id, admission_fee, caution").eq("institution_id", inst).in("application_id", ids)) as { application_id: string; admission_fee: number; caution: number }[]) : [];
  return { items: ids.map((id) => { const a = d.apps.find((x) => x.id === id) as App; const p = pays.filter((x) => x.application_id === id).reduce((n, x) => n + x.admission_fee + x.caution, 0); return { application_id: id, code: a.code, child: a.child, class_sought: a.class_sought, paid: p }; }) };
}

// ═════════════ class allocation ═════════════
export async function allocation(inst: string) {
  const d = await load(inst);
  const yearName = await admissionYear(inst);
  const year = check(await supabaseAdmin.from("academic_years").select("id, name").eq("institution_id", inst).eq("name", yearName).maybeSingle()) as { id: string; name: string } | null;
  const grades = check(await supabaseAdmin.from("grades").select("id, name").eq("institution_id", inst)) as { id: string; name: string }[];
  const secs = year ? (check(await supabaseAdmin.from("sections").select("id, name, grade_id, capacity").eq("institution_id", inst).eq("academic_year_id", year.id).order("name")) as { id: string; name: string; grade_id: string; capacity: number }[]) : [];
  const enr = year ? (check(await supabaseAdmin.from("student_enrollments").select("section_id").eq("institution_id", inst).eq("academic_year_id", year.id).limit(50000)) as { section_id: string }[]) : [];
  const count = new Map<string, number>(); for (const e of enr) count.set(e.section_id, (count.get(e.section_id) ?? 0) + 1);
  const gname = new Map(grades.map((g) => [g.id, g.name]));
  const sections = secs.map((s) => ({ id: s.id, grade_id: s.grade_id, class_name: gname.get(s.grade_id) ?? "", name: s.name, capacity: s.capacity, students: count.get(s.id) ?? 0 })).sort((a, b) => a.class_name.localeCompare(b.class_name, "en", { numeric: true }) || a.name.localeCompare(b.name));
  const items = d.families.filter((x) => x.kind === "application" && x.status === "Active" && x.step === 9).map((f) => {
    const grade = grades.find((g) => g.name === classOf(f.class_sought));
    const best = grade ? sections.filter((s) => s.grade_id === grade.id && s.students < s.capacity).sort((a, b) => (b.capacity - b.students) - (a.capacity - a.students))[0] : undefined;
    return { application_id: f.id, code: f.code, child: f.child, class_sought: f.class_sought, admission_no: f.admission_no, grade_id: grade?.id ?? null, suggested: best ? { section_id: best.id, label: `${best.class_name} ${best.name}`, students: best.students, capacity: best.capacity } : null };
  });
  return { year, sections, items };
}

// ═════════════ admitted ═════════════
export async function admitted(inst: string) {
  const d = await load(inst);
  const fam = d.families.filter((f) => f.kind === "application" && f.done);
  const apps = fam.map((f) => d.apps.find((a) => a.id === f.id) as App);
  const sids = fam.map((f) => f.student_id).filter((x): x is string => !!x);
  const enr = sids.length ? (check(await supabaseAdmin.from("student_enrollments").select("student_id, roll_no, grades:grade_id(name), sections:section_id(name)").eq("institution_id", inst).in("student_id", sids)) as unknown as { student_id: string; roll_no: string; grades: { name: string } | { name: string }[] | null; sections: { name: string } | { name: string }[] | null }[]) : [];
  const plans = sids.length ? new Set((check(await supabaseAdmin.from("student_fee_plans").select("student_id").eq("institution_id", inst).in("student_id", sids)) as { student_id: string }[]).map((x) => x.student_id)) : new Set<string>();
  const pays = apps.length ? (check(await supabaseAdmin.from("adm_fee_payments").select("application_id, admission_fee, caution").eq("institution_id", inst).in("application_id", apps.map((a) => a.id))) as { admission_fee: number; caution: number }[]) : [];
  const formFees = apps.reduce((n, a) => n + (a.fee_amount ?? 0), 0);
  const items = fam.map((f, i) => { const e = enr.find((x) => x.student_id === f.student_id); const g = d.guardianOf.get(f.student_id ?? ""); const stu = [...d.stuByNo.values()].find((s) => s.id === f.student_id); return { application_id: f.id, code: f.code, child: f.child, class_sought: f.class_sought, admission_no: f.admission_no, class_label: e ? `${one(e.grades)?.name ?? ""} ${one(e.sections)?.name ?? ""} · ${e.roll_no}`.trim() : f.class_sought, confirmed_at: apps[i].confirmed_at, student: !!f.student_id, parent: !!g, fees: !!f.student_id && plans.has(f.student_id), klass: !!e, login: !!stu?.user_profile_id && !!g?.user_profile_id }; });
  return { year: await admissionYear(inst), items, tiles: { admitted: items.length, profiles: items.filter((x) => x.student).length, fee_accounts: items.filter((x) => x.fees).length, logins: items.reduce((n, x) => n + (x.login ? 2 : 0), 0), collected: pays.reduce((n, p) => n + p.admission_fee + p.caution, 0) + formFees } };
}

// ═════════════ reports ═════════════
export async function reports(inst: string) {
  const d = await load(inst);
  const year = await admissionYear(inst);
  const total = d.families.length;
  const reached = (n: number) => d.families.filter((f) => f.step >= n).length;
  const funnel = [...["Enquiry", "Lead", "Application", "Verification", "Test / Interview", "Approval", "Fee assignment", "Registration", "Class allocation", "Portal accounts", "Confirmation"].map((label, i) => ({ label, count: reached(i + 1) })), { label: "Admitted", count: d.families.filter((f) => f.done).length }].map((r) => ({ ...r, pct: total ? Math.round((r.count / total) * 100) : 0 }));

  const paid = d.apps.filter((a) => a.fee_status === "Paid" && (a.fee_amount ?? 0) > 0);
  const pending = d.apps.filter((a) => a.fee_status === "Pending" && !a.submitted_at);
  const waived = d.apps.filter((a) => a.fee_status === "Waived");
  const byGroup = new Map<string, number>(); const bySource = new Map<string, number>();
  for (const a of paid) { const g = (await admissionFees(inst, a.class_sought))?.class_group ?? "Other"; byGroup.set(g, (byGroup.get(g) ?? 0) + (a.fee_amount ?? 0)); bySource.set(a.source, (bySource.get(a.source) ?? 0) + (a.fee_amount ?? 0)); }
  let pendingAmt = 0; for (const a of pending) pendingAmt += (await admissionFees(inst, a.class_sought))?.form_fee ?? 0;
  const register = d.apps.map((a) => ({ id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, status: a.fee_status, amount: a.fee_amount ?? 0, paid_on: a.fee_paid_on, how: (a.fee_status === "Waived" ? a.fee_note : a.fee_mode) ?? "" }));

  const srcRows = new Map<string, { enquiries: number; applications: number; admitted: number }>();
  const bump = (s: string, k: "enquiries" | "applications" | "admitted") => { const r = srcRows.get(s) ?? { enquiries: 0, applications: 0, admitted: 0 }; r[k]++; srcRows.set(s, r); };
  for (const f of d.families) { bump(f.source, "enquiries"); if (f.kind === "application") bump(f.source, "applications"); if (f.done) bump(f.source, "admitted"); }
  const sources = [...srcRows.entries()].map(([source, r]) => ({ source, ...r, pct: r.enquiries ? Math.round((r.admitted / r.enquiries) * 100) : 0 }));

  const fu = check(await supabaseAdmin.from("adm_followups").select("logged_by").eq("institution_id", inst).limit(50000)) as { logged_by: string | null }[];
  const names = new Map<string, { leads: number; followups: number; admitted: number; lost: number }>();
  const row = (n: string) => { const r = names.get(n) ?? { leads: 0, followups: 0, admitted: 0, lost: 0 }; names.set(n, r); return r; };
  for (const f of d.families) { if (f.counsellor === "—") continue; const r = row(f.counsellor); if (f.step >= 2) r.leads++; if (f.done) r.admitted++; if (f.status === "Lost") r.lost++; }
  const who = new Map<string, string>(); for (const [id, n] of d.who) who.set(id, n);
  for (const x of fu) { const n = x.logged_by ? who.get(x.logged_by) : null; if (n) row(n).followups++; }
  return {
    year, funnel,
    fees: { collected: paid.reduce((n, a) => n + (a.fee_amount ?? 0), 0), families: paid.length, pending: pendingAmt, pending_families: pending.length, waived: waived.length, by_group: [...byGroup.entries()].map(([label, total]) => ({ label, total })), by_source: [...bySource.entries()].map(([label, total]) => ({ label, total })), register },
    sources, counsellors: [...names.entries()].map(([name, r]) => ({ name, ...r })),
  };
}
