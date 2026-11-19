import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Student management for one school: profiles, parents, documents, ID cards, class placement and promotion. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const txt = (n: number) => z.string().trim().max(n);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const blank = <T>(v: T | "" | undefined) => (v === "" || v === undefined ? null : v);

interface Year { id: string; name: string; is_current: boolean }
async function currentYear(inst: string): Promise<Year | null> {
  const rows = check(await supabaseAdmin.from("academic_years").select("id, name, is_current").eq("institution_id", inst).order("start_date", { ascending: false })) as Year[];
  return rows.find((y) => y.is_current) ?? rows[0] ?? null;
}

interface EnrolRow {
  id: string; student_id: string; roll_no: string | null; status: string; grade_id: string; section_id: string | null;
  grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null;
  sections: { name: string } | { name: string }[] | null;
  students: { id: string; registration_no: string; first_name: string; last_name: string; gender: string | null; status: string; deleted_at: string | null } | { id: string; registration_no: string; first_name: string; last_name: string; gender: string | null; status: string; deleted_at: string | null }[] | null;
}
async function enrolments(inst: string, yearId: string): Promise<EnrolRow[]> {
  return check(await supabaseAdmin.from("student_enrollments").select("id, student_id, roll_no, status, grade_id, section_id, grades:grade_id(name, sort_order), sections:section_id(name), students:student_id(id, registration_no, first_name, last_name, gender, status, deleted_at)").eq("institution_id", inst).eq("academic_year_id", yearId).limit(10000)) as unknown as EnrolRow[];
}
const row = (e: EnrolRow) => {
  const s = one(e.students)!;
  const g = one(e.grades);
  const sec = one(e.sections);
  return { id: s.id, enrolment_id: e.id, name: `${s.first_name} ${s.last_name}`.trim(), registration_no: s.registration_no, class_name: g?.name ?? "", class_label: g ? `${g.name}${sec ? ` ${sec.name}` : ""}` : "", sort: g?.sort_order ?? 0, grade_id: e.grade_id, section_id: e.section_id, section: sec?.name ?? "", roll_no: e.roll_no ?? "", enrol_status: e.status, status: s.status, gender: s.gender ?? "" };
};

/** Everyone enrolled this year, for the pickers and lists. */
export async function roster(inst: string) {
  const y = await currentYear(inst);
  if (!y) return { year: null, items: [] };
  const items = (await enrolments(inst, y.id)).filter((e) => one(e.students) && !one(e.students)!.deleted_at).map(row).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return { year: y, items };
}

// ═════════════ one student ═════════════
export async function getStudent(inst: string, id: string) {
  const s = check(await supabaseAdmin.from("students").select("id, registration_no, roll_no, first_name, last_name, gender, date_of_birth, status, campuses:campus_id(name)").eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as { id: string; registration_no: string; roll_no: string | null; first_name: string; last_name: string; gender: string | null; date_of_birth: string | null; status: string; campuses: { name: string } | { name: string }[] | null } | null;
  if (!s) throw new HttpError(404, "Student not found.");
  const [p, g, y] = await Promise.all([
    supabaseAdmin.from("student_profiles").select("*").eq("student_id", id).maybeSingle(),
    supabaseAdmin.from("student_guardians").select("relation, can_pick_up, guardians:guardian_id(id, full_name, phone, email, occupation, qualification, annual_income)").eq("student_id", id),
    currentYear(inst),
  ]);
  const enrol = y ? ((await enrolments(inst, y.id)).find((e) => e.student_id === id) ?? null) : null;
  const prof = (p.data ?? {}) as Record<string, string | null>;
  const guardians = ((g.data ?? []) as unknown as { relation: string; can_pick_up: boolean; guardians: Record<string, string | number | null> | Record<string, string | number | null>[] | null }[]).map((x) => ({ relation: x.relation, can_pick_up: x.can_pick_up, ...(one(x.guardians) ?? {}) }));
  return {
    id: s.id, registration_no: s.registration_no, status: s.status, campus: one(s.campuses)?.name ?? "",
    personal: { first_name: s.first_name, last_name: s.last_name, date_of_birth: s.date_of_birth ?? prof.date_of_birth ?? "", gender: s.gender ?? prof.gender ?? "", blood_group: prof.blood_group ?? "", religion: prof.religion ?? "", category: prof.category ?? "General", aadhaar_last4: prof.aadhaar_last4 ?? "", house: prof.house ?? "" },
    academic: { roll_no: enrol?.roll_no ?? s.roll_no ?? "", grade_id: enrol?.grade_id ?? "", section_id: enrol?.section_id ?? "", class_label: enrol ? row(enrol).class_label : "", previous_school: prof.previous_school ?? "", medium: prof.medium ?? "", second_language: prof.second_language ?? "" },
    contact: { address: prof.permanent_address ?? prof.current_address ?? "", email: prof.email ?? "", emergency_name: prof.emergency_contact_name ?? "", emergency_phone: prof.emergency_contact_phone ?? "" },
    guardians,
  };
}

const PERSONAL = z.object({ first_name: txt(100).min(1), last_name: txt(100).min(1), date_of_birth: z.union([date, z.literal("")]).optional(), gender: txt(20).optional(), blood_group: txt(10).optional(), religion: txt(50).optional(), category: txt(50).optional(), aadhaar_last4: z.union([z.string().regex(/^\d{4}$/, "Enter the last 4 digits only."), z.literal("")]).optional(), house: txt(30).optional() }).strict();
const ACADEMIC = z.object({ previous_school: txt(150).optional(), medium: txt(40).optional(), second_language: txt(40).optional() }).strict();
const CONTACT = z.object({ address: txt(500).optional(), email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(), emergency_name: txt(100).optional(), emergency_phone: txt(30).optional() }).strict();

export async function updateStudent(inst: string, id: string, part: string, body: unknown) {
  await getStudent(inst, id);
  const now = new Date().toISOString();
  const upsert = async (fields: Record<string, unknown>) => {
    const exists = check(await supabaseAdmin.from("student_profiles").select("id").eq("student_id", id).maybeSingle());
    if (exists) check(await supabaseAdmin.from("student_profiles").update({ ...fields, updated_at: now }).eq("student_id", id).select("id"));
    else check(await supabaseAdmin.from("student_profiles").insert({ student_id: id, gender: "Not Specified", ...fields }).select("id"));
  };
  if (part === "personal") {
    const i = PERSONAL.parse(body);
    check(await supabaseAdmin.from("students").update({ first_name: i.first_name, last_name: i.last_name, gender: blank(i.gender), date_of_birth: blank(i.date_of_birth), updated_at: now }).eq("id", id).select("id"));
    await upsert({ date_of_birth: blank(i.date_of_birth), ...(i.gender ? { gender: i.gender } : {}), blood_group: blank(i.blood_group), religion: blank(i.religion), category: i.category || "General", aadhaar_last4: blank(i.aadhaar_last4), house: blank(i.house) });
  } else if (part === "academic") {
    const i = ACADEMIC.parse(body);
    await upsert({ previous_school: blank(i.previous_school), medium: blank(i.medium), second_language: blank(i.second_language) });
  } else if (part === "contact") {
    const i = CONTACT.parse(body);
    await upsert({ permanent_address: blank(i.address), email: blank(i.email), emergency_contact_name: blank(i.emergency_name), emergency_contact_phone: blank(i.emergency_phone) });
  } else throw new HttpError(404, "Unknown section.");
  return getStudent(inst, id);
}

/** Father, mother or guardian: updates the person linked with that relation, or adds one. */
export async function saveGuardian(inst: string, id: string, body: unknown) {
  await getStudent(inst, id);
  const i = z.object({ relation: z.enum(["Father", "Mother", "Guardian"]), full_name: txt(200).min(1, "Enter a name."), phone: txt(30).optional(), email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(), occupation: txt(100).optional(), qualification: txt(100).optional(), annual_income: z.number().min(0).max(1_000_000_000).nullable().optional(), can_pick_up: z.boolean().optional(), guardian_relation: txt(50).optional() }).strict().parse(body);
  const fields = { full_name: i.full_name, phone: i.phone || "-", email: blank(i.email), occupation: blank(i.occupation), qualification: blank(i.qualification), annual_income: i.annual_income ?? null, updated_at: new Date().toISOString() };
  const links = check(await supabaseAdmin.from("student_guardians").select("guardian_id, relation").eq("student_id", id)) as { guardian_id: string; relation: string }[];
  const rel = i.relation === "Guardian" ? i.guardian_relation || "Guardian" : i.relation;
  const mine = links.find((l) => l.relation === i.relation || (i.relation === "Guardian" && !["Father", "Mother"].includes(l.relation)));
  if (mine) {
    check(await supabaseAdmin.from("guardians").update(fields).eq("id", mine.guardian_id).eq("institution_id", inst).select("id"));
    check(await supabaseAdmin.from("student_guardians").update({ relation: rel, ...(i.can_pick_up !== undefined ? { can_pick_up: i.can_pick_up } : {}) }).eq("student_id", id).eq("guardian_id", mine.guardian_id).select("student_id"));
  } else {
    const g = check(await supabaseAdmin.from("guardians").insert({ institution_id: inst, ...fields }).select("id").single()) as { id: string };
    check(await supabaseAdmin.from("student_guardians").insert({ student_id: id, guardian_id: g.id, relation: rel, is_primary_contact: i.relation === "Father" || !links.length, can_pick_up: i.can_pick_up ?? false }).select("student_id"));
  }
  return getStudent(inst, id);
}

// ═════════════ documents ═════════════
export const DOC_TYPES = ["Birth certificate", "Photos", "Previous records", "Other documents"];
export async function documents(inst: string, type?: string) {
  let q = supabaseAdmin.from("stu_documents").select("id, student_id, doc_type, file_name, status, created_at, students:student_id(first_name, last_name, registration_no)").eq("institution_id", inst).order("created_at", { ascending: false }).limit(2000);
  if (type) q = q.eq("doc_type", type);
  const [docs, ro] = await Promise.all([q, roster(inst)]);
  const cls = new Map(ro.items.map((r) => [r.id, r.class_label]));
  return ((check(docs) as unknown) as { student_id: string; students: { first_name: string; last_name: string; registration_no: string } | { first_name: string; last_name: string; registration_no: string }[] | null }[]).map((d) => { const s = one(d.students); return { ...d, students: undefined, name: s ? `${s.first_name} ${s.last_name}` : "", registration_no: s?.registration_no ?? "", class_label: cls.get(d.student_id) ?? "" }; });
}
export async function addDocument(inst: string, body: unknown) {
  const i = z.object({ student_id: z.string().uuid(), doc_type: z.enum(["Birth certificate", "Photos", "Previous records", "Other documents"]), file_name: txt(150).optional() }).strict().parse(body);
  await getStudent(inst, i.student_id);
  return check(await supabaseAdmin.from("stu_documents").insert({ institution_id: inst, student_id: i.student_id, doc_type: i.doc_type, file_name: blank(i.file_name) }).select("id").single());
}
export async function setDocumentStatus(inst: string, id: string, body: unknown) {
  const { status } = z.object({ status: z.enum(["Pending review", "Verified", "Expired", "Missing"]) }).strict().parse(body);
  const r = check(await supabaseAdmin.from("stu_documents").update({ status }).eq("id", id).eq("institution_id", inst).select("id").maybeSingle());
  if (!r) throw new HttpError(404, "Document not found.");
  return r;
}

// ═════════════ ID cards ═════════════
const SHOW_DEFAULT = { Photo: true, "Admission no.": true, Class: true, "Blood group": true, "Parent mobile": true, Address: false, "Bus route": true, "QR code": true };
export async function idSettings(inst: string) {
  const s = check(await supabaseAdmin.from("stu_id_settings").select("template, valid_until, signature, show_fields").eq("institution_id", inst).maybeSingle()) as { template: string; valid_until: string | null; signature: string; show_fields: Record<string, boolean> } | null;
  const school = check(await supabaseAdmin.from("institutions").select("name, address, city").eq("id", inst).maybeSingle()) as { name: string; address: string | null; city: string | null } | null;
  const y = new Date().getMonth() >= 3 ? new Date().getFullYear() + 1 : new Date().getFullYear();
  return { school: school?.name ?? "", place: [school?.address, school?.city].filter(Boolean).join(", "), template: s?.template ?? "Portrait, blue band", valid_until: s?.valid_until ?? `${y}-03-31`, signature: s?.signature ?? "Principal", show: { ...SHOW_DEFAULT, ...(s?.show_fields ?? {}) } };
}
export async function saveIdSettings(inst: string, body: unknown) {
  const i = z.object({ template: txt(40).min(1), valid_until: date, signature: txt(40).min(1), show: z.record(z.string(), z.boolean()) }).strict().parse(body);
  check(await supabaseAdmin.from("stu_id_settings").upsert({ institution_id: inst, template: i.template, valid_until: i.valid_until, signature: i.signature, show_fields: i.show }, { onConflict: "institution_id" }).select("institution_id"));
  return idSettings(inst);
}
export async function idCards(inst: string) {
  const [ro, cards, photos] = await Promise.all([roster(inst), supabaseAdmin.from("stu_id_cards").select("student_id, generated_at").eq("institution_id", inst), supabaseAdmin.from("stu_documents").select("student_id, status").eq("institution_id", inst).eq("doc_type", "Photos")]);
  const gen = new Set(((cards.data ?? []) as { student_id: string }[]).map((c) => c.student_id));
  const photo = new Map(((photos.data ?? []) as { student_id: string; status: string }[]).map((p) => [p.student_id, p.status]));
  return ro.items.map((r) => ({ ...r, photo: photo.get(r.id) === "Verified" ? "Verified" : photo.has(r.id) ? "Pending" : "Missing", card: gen.has(r.id) ? "Generated" : "Pending" }));
}
export async function generateCards(inst: string, ids: string[] | "all") {
  const all = await idCards(inst);
  const todo = (ids === "all" ? all.filter((c) => c.card === "Pending") : all.filter((c) => ids.includes(c.id))).map((c) => ({ student_id: c.id, institution_id: inst, generated_at: new Date().toISOString() }));
  if (todo.length) check(await supabaseAdmin.from("stu_id_cards").upsert(todo, { onConflict: "student_id" }).select("student_id"));
  return { generated: todo.length };
}
export async function cardData(inst: string, id: string) {
  const [s, st, g] = await Promise.all([getStudent(inst, id), idSettings(inst), supabaseAdmin.from("student_guardians").select("relation, guardians:guardian_id(phone)").eq("student_id", id)]);
  const phones = ((g.data ?? []) as unknown as { relation: string; guardians: { phone: string } | { phone: string }[] | null }[]).map((x) => ({ relation: x.relation, phone: one(x.guardians)?.phone ?? "" }));
  return { settings: st, student: { name: `${s.personal.first_name} ${s.personal.last_name}`.trim(), registration_no: s.registration_no, class_label: s.academic.class_label, blood_group: s.personal.blood_group, parent_phone: (phones.find((p) => p.relation === "Father") ?? phones[0])?.phone ?? "", address: s.contact.address } };
}

// ═════════════ class placement ═════════════
export async function assign(inst: string, id: string, body: unknown) {
  const i = z.object({ grade_id: z.string().uuid(), section_id: z.string().uuid(), roll_no: txt(30).min(1, "Give a roll number.") }).strict().parse(body);
  const y = await currentYear(inst);
  if (!y) throw new HttpError(400, "Create an academic year first.");
  const sec = check(await supabaseAdmin.from("sections").select("id").eq("id", i.section_id).eq("institution_id", inst).eq("grade_id", i.grade_id).eq("academic_year_id", y.id).maybeSingle());
  if (!sec) throw new HttpError(400, "That section does not belong to the chosen class this year.");
  const clash = check(await supabaseAdmin.from("student_enrollments").select("id").eq("institution_id", inst).eq("academic_year_id", y.id).eq("section_id", i.section_id).eq("roll_no", i.roll_no).neq("student_id", id).limit(1)) as unknown[];
  if (clash.length) throw new HttpError(409, "That roll number is already used in the section.");
  const cur = (await enrolments(inst, y.id)).find((e) => e.student_id === id);
  if (!cur) throw new HttpError(404, "That student is not enrolled this year.");
  check(await supabaseAdmin.from("student_enrollments").update({ grade_id: i.grade_id, section_id: i.section_id, roll_no: i.roll_no, updated_at: new Date().toISOString() }).eq("id", cur.id).select("id"));
  check(await supabaseAdmin.from("students").update({ roll_no: i.roll_no }).eq("id", id).select("id"));
  return { success: true };
}

// ═════════════ promotion ═════════════
export async function promotionList(inst: string) {
  const [ro, hist, years] = await Promise.all([
    roster(inst),
    supabaseAdmin.from("student_promotions").select("student_id, action, created_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(5000),
    supabaseAdmin.from("academic_years").select("id, name, is_current, start_date").eq("institution_id", inst).order("start_date", { ascending: false }),
  ]);
  const last = new Map<string, { action: string; created_at: string }>();
  for (const h of (hist.data ?? []) as { student_id: string; action: string; created_at: string }[]) if (!last.has(h.student_id)) last.set(h.student_id, h);
  const grades = (check(await supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order")) as { id: string; name: string; sort_order: number }[]);
  const nextOf = (gid: string) => { const i = grades.findIndex((g) => g.id === gid); return i >= 0 ? grades[i + 1]?.name ?? null : null; };
  return {
    year: ro.year, years: years.data ?? [], grades,
    items: ro.items.map((r) => { const h = last.get(r.id); return { ...r, next_class: nextOf(r.grade_id), state: h ? (h.action === "Promoted" ? "Promoted" : "Held for review") : "Ready", decided_at: h?.created_at ?? null }; }),
  };
}

/** Moves students to the next class in the chosen year (same section name where it exists), or holds them back. */
export async function promote(inst: string, body: unknown, actor?: string) {
  const i = z.object({ student_ids: z.array(z.string().uuid()).min(1).max(500), target_year_id: z.string().uuid(), hold: z.boolean().optional() }).strict().parse(body);
  const cur = await currentYear(inst);
  if (!cur) throw new HttpError(400, "Create an academic year first.");
  if (cur.id === i.target_year_id) throw new HttpError(400, "Choose the next academic year.");
  const target = check(await supabaseAdmin.from("academic_years").select("id").eq("id", i.target_year_id).eq("institution_id", inst).maybeSingle());
  if (!target) throw new HttpError(404, "Academic year not found.");
  const [enr, grades, secs] = await Promise.all([enrolments(inst, cur.id), supabaseAdmin.from("grades").select("id, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order"), supabaseAdmin.from("sections").select("id, grade_id, name").eq("institution_id", inst).eq("academic_year_id", i.target_year_id)]);
  const G = (grades.data ?? []) as { id: string }[];
  const S = (secs.data ?? []) as { id: string; grade_id: string; name: string }[];
  let done = 0; const skipped: string[] = [];
  for (const sid of i.student_ids) {
    const e = enr.find((x) => x.student_id === sid);
    if (!e) { skipped.push("not enrolled"); continue; }
    if (i.hold) {
      check(await supabaseAdmin.from("student_promotions").insert({ institution_id: inst, student_id: sid, from_enrollment_id: e.id, action: "Detained", decided_by: actor ?? null }).select("id"));
      done++; continue;
    }
    const next = G[G.findIndex((g) => g.id === e.grade_id) + 1];
    if (!next) { skipped.push(`${row(e).name}: no next class`); continue; }
    const had = check(await supabaseAdmin.from("student_enrollments").select("id").eq("student_id", sid).eq("academic_year_id", i.target_year_id).maybeSingle());
    if (had) { skipped.push(`${row(e).name}: already placed`); continue; }
    const sec = S.find((x) => x.grade_id === next.id && x.name === (one(e.sections)?.name ?? "")) ?? null;
    const n = check(await supabaseAdmin.from("student_enrollments").insert({ institution_id: inst, student_id: sid, academic_year_id: i.target_year_id, grade_id: next.id, section_id: sec?.id ?? null, roll_no: null }).select("id").single()) as { id: string };
    check(await supabaseAdmin.from("student_enrollments").update({ status: "Promoted" }).eq("id", e.id).select("id"));
    check(await supabaseAdmin.from("student_promotions").insert({ institution_id: inst, student_id: sid, from_enrollment_id: e.id, to_enrollment_id: n.id, action: "Promoted", decided_by: actor ?? null }).select("id"));
    done++;
  }
  return { done, skipped };
}
