import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { staffList } from "./attendance2.service";
import { health, firstAid } from "./campus.service";

/** Health screening, medication, counselling and welfare cases; certificates. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const enrolled = async (inst: string) => (await roster(inst)).items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled");
const picker = async (inst: string) => (await enrolled(inst)).slice(0, 3000).map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label}` }));
const upd = async (table: string, inst: string, id: string, row: object, where: Record<string, string> = {}) => {
  let q = supabaseAdmin.from(table).update(row).eq("id", id).eq("institution_id", inst); for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
  const r = check(await q.select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That can't be done in its current state."); return { ok: true };
};
const ensure = async (inst: string, id: string) => { if (!(await enrolled(inst)).some((x) => x.id === id)) throw new HttpError(404, "Student not found."); };

// ═════════════ health records (derived), screening ═════════════
export async function healthRecords(inst: string) {
  const [h, f] = await Promise.all([health(inst), firstAid(inst)]);
  const med = h.students.filter((s) => s.conditions || s.allergies).map((s) => ({ key: `m${s.id}`, student: s.name, class_label: s.class_label, type: "Medical information", details: s.conditions || `Allergy: ${s.allergies}`, blood_group: s.blood_group, recorded: null as string | null, status: "Active" }));
  const inc = f.items.map((x) => ({ key: `i${x.id}`, student: x.student, class_label: x.class_label, type: "Health incident", details: x.what, blood_group: h.students.find((s) => s.name === x.student && s.class_label === x.class_label)?.blood_group ?? "", recorded: x.incident_date, status: x.status === "Closed" ? "Resolved" : "Active" }));
  return { items: [...inc, ...med].sort((a, b) => (b.recorded ?? "").localeCompare(a.recorded ?? "")) };
}
export async function screenings(inst: string) {
  const [s, st] = await Promise.all([supabaseAdmin.from("health_screenings").select("id, student_id, height_cm, weight_kg, vision, checkup, screened_on, status").eq("institution_id", inst).order("screened_on", { ascending: false }).limit(3000), enrolled(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  return { students: await picker(inst), items: (check(s) as { id: string; student_id: string; height_cm: number | null; weight_kg: number | null; vision: string; checkup: string; screened_on: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "", bmi: x.height_cm && x.weight_kg ? Math.round((Number(x.weight_kg) / (x.height_cm / 100) ** 2) * 10) / 10 : null })) };
}
export async function addScreening(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, height_cm: z.number().int().min(30).max(250).nullable(), weight_kg: z.number().min(3).max(250).nullable(), vision: z.string().trim().max(60), checkup: z.string().trim().max(80), screened_on: date, status: z.enum(["Normal", "Needs attention", "Referred"]) }).strict().parse(input);
  if (i.height_cm === null && i.weight_kg === null && !i.vision) throw new HttpError(400, "Enter at least a height, a weight or a vision result."); await ensure(inst, i.student_id); return check(await supabaseAdmin.from("health_screenings").insert({ institution_id: inst, ...i }).select("id").single());
}

// ═════════════ medication ═════════════
export async function medication(inst: string) {
  const [m, d, st] = await Promise.all([supabaseAdmin.from("medication_records").select("id, student_id, medicine, dose_when, until, consent, status").eq("institution_id", inst).order("until", { ascending: false }).limit(3000), supabaseAdmin.from("medication_doses").select("medication_id, given_at, given_by, m:medication_id!inner(institution_id)").eq("m.institution_id", inst).order("given_at", { ascending: false }).limit(5000), enrolled(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  const D = check(d) as unknown as { medication_id: string; given_at: string; given_by: string }[];
  return { students: await picker(inst), staff: (await staffList(inst)).map((x) => x.name), items: (check(m) as { id: string; student_id: string; medicine: string; dose_when: string; until: string; consent: boolean; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "", doses: D.filter((y) => y.medication_id === x.id).slice(0, 10) })) };
}
export async function addMedication(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, medicine: z.string().trim().min(2, "Enter the medicine.").max(80), dose_when: z.string().trim().min(2).max(60), until: date, consent: z.boolean() }).strict().parse(input);
  if (i.until < today()) throw new HttpError(400, "The end date has passed."); await ensure(inst, i.student_id); return check(await supabaseAdmin.from("medication_records").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function giveDose(inst: string, id: string, input: unknown) {
  const { given_by } = z.object({ given_by: z.string().trim().min(2).max(80) }).strict().parse(input); const m = check(await supabaseAdmin.from("medication_records").select("id, consent, status, until").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; consent: boolean; status: string; until: string } | null;
  if (!m) throw new HttpError(404, "Not found."); if (m.status !== "Active" || m.until < today()) throw new HttpError(409, "That medication is not active."); if (!m.consent) throw new HttpError(409, "The parent's consent is not signed.");
  check(await supabaseAdmin.from("medication_doses").insert({ medication_id: id, given_by }).select("id")); return { ok: true };
}
export async function stopMedication(inst: string, id: string) { return upd("medication_records", inst, id, { status: "Stopped" }, { status: "Active" }); }

// ═════════════ counselling and welfare ═════════════
export async function counselling(inst: string) {
  const [c, st, sf] = await Promise.all([supabaseAdmin.from("counselling_sessions").select("id, student_id, session_at, referred_by, counsellor, status").eq("institution_id", inst).order("session_at", { ascending: false }).limit(3000), enrolled(inst), staffList(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  return { students: await picker(inst), staff: sf.map((x) => x.name), items: (check(c) as { id: string; student_id: string; session_at: string; referred_by: string; counsellor: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function addSession(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, session_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time."), referred_by: z.string().trim().min(2).max(60), counsellor: z.string().trim().min(2).max(80) }).strict().parse(input); await ensure(inst, i.student_id);
  return check(await supabaseAdmin.from("counselling_sessions").insert({ institution_id: inst, ...i, session_at: `${i.session_at}:00+05:30` }).select("id").single());
}
export async function setSession(inst: string, id: string, input: unknown) { const { status } = z.object({ status: z.enum(["Done", "Missed"]) }).strict().parse(input); return upd("counselling_sessions", inst, id, { status }, { status: "Scheduled" }); }
export async function welfare(inst: string) {
  const [w, st, sf] = await Promise.all([supabaseAdmin.from("welfare_cases").select("id, code, student_id, referred_to, owner, opened_on, status").eq("institution_id", inst).order("opened_on", { ascending: false }).order("code", { ascending: false }).limit(3000), enrolled(inst), staffList(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  return { students: await picker(inst), staff: sf.map((x) => x.name), items: (check(w) as { id: string; code: string; student_id: string; referred_to: string; owner: string; opened_on: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function addCase(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, referred_to: z.string().trim().min(2, "Say who it is referred to.").max(120), owner: z.string().trim().min(2).max(80) }).strict().parse(input); await ensure(inst, i.student_id); return check(await supabaseAdmin.from("welfare_cases").insert({ institution_id: inst, ...i }).select("id, code").single());
}
export async function closeCase(inst: string, id: string) { return upd("welfare_cases", inst, id, { status: "Closed" }, { status: "Open" }); }

// ═════════════ certificates ═════════════
const KINDS = ["Bonafide", "Study", "Conduct", "Character", "Transfer", "Custom"] as const;
const PREFIX = "BG/CRT";
const nextCode = async (inst: string) => { const yr = today().slice(0, 4); const ex = (check(await supabaseAdmin.from("certificates").select("code").eq("institution_id", inst).like("code", `${PREFIX}/${yr}/%`)) as { code: string }[]).map((x) => Number(x.code.split("/")[3]) || 0); return `${PREFIX}/${yr}/${String(Math.max(0, ...ex) + 1).padStart(4, "0")}`; };
export async function certTemplates(inst: string) {
  if (!(check(await supabaseAdmin.from("cert_templates").select("id").eq("institution_id", inst).limit(1)) as unknown[]).length) check(await supabaseAdmin.from("cert_templates").insert(["Bonafide certificate", "Study certificate", "Transfer certificate", "Conduct certificate", "Character certificate"].map((name) => ({ institution_id: inst, name }))).select("id"));
  return { items: check(await supabaseAdmin.from("cert_templates").select("id, name, size, signed_by, last_edited, status").eq("institution_id", inst).order("name")) as { id: string; name: string; size: string; signed_by: string; last_edited: string; status: string }[] };
}
const TPL = z.object({ name: z.string().trim().min(2, "Enter the template name.").max(80), size: z.enum(["A4", "A5", "Letter"]), signed_by: z.string().trim().min(2).max(40), last_edited: date.optional(), status: z.enum(["Active", "Inactive"]).optional() }).strict();
export async function addCertTemplate(inst: string, input: unknown) {
  const i = TPL.parse(input); if ((check(await supabaseAdmin.from("cert_templates").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That template exists.");
  return check(await supabaseAdmin.from("cert_templates").insert({ institution_id: inst, ...i, last_edited: i.last_edited ?? today() }).select("id").single());
}
export async function editCertTemplate(inst: string, id: string, input: unknown) { const i = TPL.parse(input); return upd("cert_templates", inst, id, { ...i, last_edited: i.last_edited ?? today() }); }
export async function certFacts(inst: string, studentId: string, kind: string) {
  const k = z.enum(KINDS).parse(kind); const r = await roster(inst); const s = r.items.find((x) => x.id === studentId && (x.status === "Enrolled" || x.enrol_status === "Enrolled")); if (!s) throw new HttpError(404, "Student not found.");
  const [st, g, i, n] = await Promise.all([supabaseAdmin.from("students").select("date_of_birth, registration_no").eq("id", studentId).maybeSingle(), supabaseAdmin.from("student_guardians").select("relation, is_primary_contact, guardians:guardian_id(full_name)").eq("student_id", studentId), supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle(), nextCode(inst)]);
  const G = (check(g) as unknown as { relation: string; is_primary_contact: boolean; guardians: { full_name: string } | { full_name: string }[] | null }[]).sort((a, b) => Number(b.is_primary_contact) - Number(a.is_primary_contact))[0]; const gn = G ? (Array.isArray(G.guardians) ? G.guardians[0] : G.guardians)?.full_name ?? "" : "";
  const D = check(st) as { date_of_birth: string | null; registration_no: string } | null;
  return { school: (check(i) as { name: string } | null)?.name ?? "", name: s.name, class_label: s.class_label, parent: gn, relation: G?.relation ?? "", dob: D?.date_of_birth ?? null, admission_no: D?.registration_no ?? s.registration_no, year: r.year?.name ?? "", status: "Active", next_code: n as string, kind: k };
}
export async function certStudents(inst: string) { return { students: await picker(inst) }; }
export async function issueCert(inst: string, input: unknown) {
  const i = z.object({ kind: z.enum(KINDS), student_id: uid, purpose: z.string().trim().min(2, "Enter the purpose.").max(120), issued_on: date, code: z.string().trim().max(30).optional() }).strict().parse(input);
  const f = await certFacts(inst, i.student_id, i.kind); const code = i.code || f.next_code; if (i.kind === "Transfer" || i.kind === "Custom") void 0;
  if ((check(await supabaseAdmin.from("certificates").select("id").eq("institution_id", inst).eq("code", code)) as unknown[]).length) throw new HttpError(409, "That certificate number is already used.");
  return check(await supabaseAdmin.from("certificates").insert({ institution_id: inst, kind: i.kind, code, student_id: i.student_id, purpose: i.purpose, issued_on: i.issued_on, status: "Issued", requested_on: i.issued_on }).select("id, code").single());
}
export async function issuedCerts(inst: string, kind: string) {
  const k = z.enum(KINDS).parse(kind); const [c, st] = await Promise.all([supabaseAdmin.from("certificates").select("id, code, student_id, purpose, issued_on").eq("institution_id", inst).eq("kind", k).eq("status", "Issued").order("issued_on", { ascending: false }).order("code", { ascending: false }).limit(3000), roster(inst)]); const K = new Map(st.items.map((x) => [x.id, x]));
  return { items: (check(c) as { id: string; code: string; student_id: string; purpose: string; issued_on: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}

// ═════════════ certificate requests and approvals ═════════════
export async function certRegister(inst: string, kind: string) {
  const k = kind === "All" ? null : z.enum(KINDS).parse(kind); let q = supabaseAdmin.from("certificates").select("id, kind, code, student_id, purpose, requested_on, issued_on, status").eq("institution_id", inst); if (k) q = q.eq("kind", k);
  const [c, st] = await Promise.all([q.order("requested_on", { ascending: false }).order("code", { ascending: false }).limit(3000), roster(inst)]); const K = new Map(st.items.map((x) => [x.id, x]));
  return { students: await picker(inst), items: (check(c) as { id: string; kind: string; code: string; student_id: string; purpose: string; requested_on: string; issued_on: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function requestCert(inst: string, input: unknown) {
  const i = z.object({ kind: z.enum(KINDS), student_id: uid, purpose: z.string().trim().min(2, "Enter the purpose.").max(120), requested_on: date.optional() }).strict().parse(input); await ensure(inst, i.student_id);
  return check(await supabaseAdmin.from("certificates").insert({ institution_id: inst, kind: i.kind, code: await nextCode(inst), student_id: i.student_id, purpose: i.purpose, status: "Pending", requested_on: i.requested_on ?? today(), issued_on: i.requested_on ?? today() }).select("id, code").single());
}
export async function decideCert(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["approve", "reject", "issue"]) }).strict().parse(input);
  if (action === "issue") return upd("certificates", inst, id, { status: "Issued", issued_on: today() }, { status: "Approved" });
  return upd("certificates", inst, id, { status: action === "approve" ? "Approved" : "Rejected" }, { status: "Pending" });
}
export async function verifyCert(inst: string, code: string) {
  const c = z.string().trim().min(3).max(30).parse(code); const r = check(await supabaseAdmin.from("certificates").select("kind, code, student_id, purpose, issued_on, status").eq("institution_id", inst).ilike("code", c).maybeSingle()) as { kind: string; code: string; student_id: string; purpose: string; issued_on: string; status: string } | null;
  if (!r) return { found: false as const }; const s = (await roster(inst)).items.find((x) => x.id === r.student_id);
  return { found: true as const, genuine: r.status === "Issued", kind: r.kind, code: r.code, status: r.status, student: s?.name ?? "", class_label: s?.class_label ?? "", purpose: r.purpose, issued_on: r.issued_on };
}

// ═════════════ document repository (file names only) ═════════════
const DOC_TYPES_S = ["Birth certificate", "Photos", "Previous records", "Other documents"]; const DOC_TYPES_T = ["Certificates", "ID proof", "Contracts", "Other documents"];
export async function repoDocs(inst: string, kind: string) {
  const k = z.enum(["Student", "Staff"]).parse(kind); const [d, st, sf] = await Promise.all([supabaseAdmin.from("repo_documents").select("id, student_id, staff_id, doc_type, file_name, uploaded_on, valid_until, status").eq("institution_id", inst).eq("owner_kind", k).order("uploaded_on", { ascending: false }).limit(3000), k === "Student" ? roster(inst) : Promise.resolve({ items: [] as { id: string; name: string; class_label: string }[] }), k === "Staff" ? staffList(inst) : Promise.resolve([])]);
  const K = new Map(st.items.map((x) => [x.id, x])); const S = new Map(sf.map((x) => [x.id, x])); const t = today();
  return { types: k === "Student" ? DOC_TYPES_S : DOC_TYPES_T, people: k === "Student" ? await picker(inst) : sf.map((x) => ({ id: x.id, name: x.name })), items: (check(d) as { id: string; student_id: string | null; staff_id: string | null; doc_type: string; file_name: string; uploaded_on: string; valid_until: string | null; status: string }[]).map((x) => ({ ...x, person: x.student_id ? K.get(x.student_id)?.name ?? "" : S.get(x.staff_id ?? "")?.name ?? "", class_label: x.student_id ? K.get(x.student_id)?.class_label ?? "" : "", status: x.valid_until && x.valid_until < t ? "Expired" : x.status })) };
}
export async function addRepoDoc(inst: string, input: unknown) {
  const i = z.object({ owner_kind: z.enum(["Student", "Staff"]), person_id: uid, doc_type: z.string().trim().min(2).max(40), file_name: z.string().trim().min(1, "Choose a file.").max(120), valid_until: date.nullable().optional() }).strict().parse(input);
  if (i.owner_kind === "Student") await ensure(inst, i.person_id); else if (!(await staffList(inst)).some((x) => x.id === i.person_id)) throw new HttpError(404, "Staff member not found.");
  return check(await supabaseAdmin.from("repo_documents").insert({ institution_id: inst, owner_kind: i.owner_kind, student_id: i.owner_kind === "Student" ? i.person_id : null, staff_id: i.owner_kind === "Staff" ? i.person_id : null, doc_type: i.doc_type, file_name: i.file_name, valid_until: i.valid_until ?? null }).select("id").single());
}
export async function setRepoDoc(inst: string, id: string, input: unknown) { const { status } = z.object({ status: z.enum(["Verified", "Pending review", "Missing"]) }).strict().parse(input); return upd("repo_documents", inst, id, { status }); }

// ═════════════ school events ═════════════
export async function eventOptions(inst: string) { return { venues: ["Main ground", "Auditorium", "Primary playground", "Library", "Classrooms", "Outside the school"], staff: (await staffList(inst)).map((x) => x.name), audiences: ["Whole school", "Students", "Parents", "Staff"] }; }
