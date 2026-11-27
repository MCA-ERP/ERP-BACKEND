import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { addFeedback, addRequest } from "../school/parent-extra.service";
import { GUARDIAN_COLS, andList, childOf, family, today, type Family, type Guardian } from "./parent-core";

/** Parent information, linked students, and privacy and consent (India's DPDP Act 2023). */
const txt = (n: number) => z.string().trim().max(n);
export const NEEDS_123 = "This needs a database update (migration 123). Please ask the platform team to apply it.";
const missingColumn = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42703" || e.code === "PGRST204" || /guardian_id/.test(e.message ?? ""));

// ═════════════ parent master ═════════════
type Linked = Guardian & { user_profile_id: string | null; relation: string; exclusive: boolean };

/** The other adults on record for these children, one per relation. `exclusive` = linked to no child outside this family. */
async function relatives(inst: string, fam: Family): Promise<Linked[]> {
  const kids = fam.children.map((c) => c.id);
  if (!kids.length) return [];
  const links = (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation").in("student_id", kids).limit(100)) ?? []) as { student_id: string; guardian_id: string; relation: string }[];
  const ids = [...new Set(links.map((l) => l.guardian_id))];
  if (!ids.length) return [];
  const [rows, all] = await Promise.all([
    supabaseAdmin.from("guardians").select(`${GUARDIAN_COLS}, user_profile_id`).eq("institution_id", inst).in("id", ids),
    supabaseAdmin.from("student_guardians").select("student_id, guardian_id").in("guardian_id", ids).limit(500),
  ]);
  const A = (check(all) ?? []) as { student_id: string; guardian_id: string }[];
  return ((check(rows) ?? []) as unknown as (Guardian & { user_profile_id: string | null })[]).map((g) => ({
    ...g, relation: links.find((l) => l.guardian_id === g.id)?.relation ?? "Guardian",
    exclusive: A.filter((a) => a.guardian_id === g.id).every((a) => kids.includes(a.student_id)),
  }));
}
const pick = (list: Linked[], relation: "Father" | "Mother" | "Guardian", mine: string[]) => {
  const of = list.filter((g) => g.relation === relation);
  return of.find((g) => mine.includes(g.id)) ?? of[0] ?? null;
};
/** A relative's name may be changed here only when that record is this family's alone and has no sign-in of its own. */
const editable = (g: Linked | null, me: string) => !g || (g.exclusive && (!g.user_profile_id || g.user_profile_id === me));

export async function profile(inst: string, me: string) {
  const fam = await family(inst, me);
  const list = await relatives(inst, fam);
  const g = fam.guardian;
  const name = (r: "Father" | "Mother" | "Guardian") => { const x = pick(list, r, fam.guardianIds); return { name: x?.full_name ?? "", editable: editable(x, me) }; };
  return {
    parent_id: g.parent_code ?? "", father: name("Father"), mother: name("Mother"), guardian: name("Guardian"), mobile: g.phone === "-" ? "" : g.phone, email: g.email ?? "", occupation: g.occupation ?? "",
    income_band: g.income_band ?? "", address: [g.address, g.city, g.pincode].filter(Boolean).join(", "), emergency_name: g.emergency_name ?? "", emergency_phone: g.emergency_phone ?? "",
  };
}

const profileSchema = z.object({
  father_name: txt(200).optional(), mother_name: txt(200).optional(), guardian_name: txt(200).optional(),
  email: z.union([z.string().trim().email("Enter a valid email address.").max(255), z.literal("")]).optional(), occupation: txt(100).optional(), income_band: txt(40).optional(),
  address: txt(400).optional(), emergency_name: txt(150).optional(),
  emergency_phone: z.union([z.string().trim().max(30).regex(/^\+?[0-9 ()-]{8,}$/, "Enter a valid emergency contact number."), z.literal("")]).optional(),
}).strict(); // the mobile number is not accepted here: only the School Admin changes it

export async function saveProfile(inst: string, me: string, input: unknown) {
  const i = profileSchema.parse(input);
  const fam = await family(inst, me);
  const list = await relatives(inst, fam);
  const g = fam.guardian;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ["email", "occupation", "income_band", "emergency_name", "emergency_phone"] as const) if (i[k] !== undefined) patch[k] = i[k] || null;
  const shown = [g.address, g.city, g.pincode].filter(Boolean).join(", ");
  if (i.address !== undefined && i.address !== shown) Object.assign(patch, { address: i.address || null, city: null, pincode: null });
  check(await supabaseAdmin.from("guardians").update(patch).eq("id", g.id).eq("institution_id", inst).select("id"));

  const asked: string[] = [];
  for (const [relation, value] of [["Father", i.father_name], ["Mother", i.mother_name], ["Guardian", i.guardian_name]] as const) {
    if (value === undefined) continue;
    const row = pick(list, relation, fam.guardianIds);
    if (value === (row?.full_name ?? "")) continue;
    if (row && editable(row, me)) {
      if (value.length < 2) throw new HttpError(400, `Enter the ${relation.toLowerCase()}'s name.`);
      check(await supabaseAdmin.from("guardians").update({ full_name: value, updated_at: new Date().toISOString() }).eq("id", row.id).eq("institution_id", inst).select("id"));
    } else if (!row && value) {
      // adding another adult to a child is the school's decision
      await addRequest(inst, { kind: "correction", guardian_id: g.id, req_type: `Add ${relation.toLowerCase()}`, details: `Please add ${value} as ${relation.toLowerCase()} for ${andList(fam.children.map((c) => c.first_name))}.`.slice(0, 400) }, me);
      asked.push(relation.toLowerCase());
    } else if (row) throw new HttpError(409, `Only the school office can change the ${relation.toLowerCase()}'s name.`);
  }
  return { ok: true, asked };
}

export async function requestMobileChange(inst: string, me: string, input: unknown) {
  const i = z.object({ new_number: txt(30).min(10, "Enter the new mobile number."), reason: txt(200).optional() }).strict().parse(input);
  const fam = await family(inst, me);
  const open = (check(await supabaseAdmin.from("parent_requests").select("id").eq("institution_id", inst).eq("kind", "mobile").in("guardian_id", fam.guardianIds).in("status", ["Pending", "Code sent", "Number verified"]).limit(1)) ?? []) as unknown[];
  if (open.length) throw new HttpError(409, "A mobile number change is already waiting with the school office.");
  return addRequest(inst, { kind: "mobile", guardian_id: fam.guardian.id, new_number: i.new_number, reason: i.reason }, me);
}

// ═════════════ linked students ═════════════
export async function linkedStudents(inst: string, me: string) {
  const fam = await family(inst, me);
  const ids = fam.children.map((c) => c.id);
  const [tr, mess] = ids.length ? await Promise.all([
    supabaseAdmin.from("tr_allocations").select("student_id, tr_routes:route_id(name), tr_stops:stop_id(name)").eq("institution_id", inst).in("student_id", ids),
    supabaseAdmin.from("mess_day_students").select("student_id, meals, diet, opted").eq("institution_id", inst).in("student_id", ids),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  const T = (check(tr) ?? []) as unknown as { student_id: string; tr_routes: { name: string } | null; tr_stops: { name: string } | null }[];
  const M = (check(mess) ?? []) as { student_id: string; meals: string; diet: string; opted: boolean }[];
  const grades = (check(await supabaseAdmin.from("grades").select("name").eq("institution_id", inst).order("sort_order")) ?? []) as { name: string }[];
  return {
    parent_id: fam.guardian.parent_code ?? "", classes: grades.map((g) => g.name),
    items: fam.children.map((c) => {
      const t = T.find((x) => x.student_id === c.id); const m = M.find((x) => x.student_id === c.id && x.opted);
      return { id: c.id, name: c.name, class_label: c.class_label, registration_no: c.registration_no, roll_no: c.roll_no, date_of_birth: c.date_of_birth, gender: c.gender, class_teacher: c.class_teacher, house: c.house, transport: t?.tr_routes ? [t.tr_routes.name, t.tr_stops?.name].filter(Boolean).join(" · ") : "", mess: m ? `${m.meals} · ${m.diet}` : "", relation: c.relation };
    }),
  };
}

/** The school links the child after checking; nothing is linked from the portal. */
export async function requestLink(inst: string, me: string, input: unknown) {
  const i = z.object({ name: txt(150).min(2, "Enter the child's name."), admission_no: txt(100).min(3, "Enter the admission number."), class_name: txt(60).min(1, "Choose the class.") }).strict().parse(input);
  const fam = await family(inst, me);
  const open = (check(await supabaseAdmin.from("parent_requests").select("id").eq("institution_id", inst).eq("kind", "other").eq("req_type", "Link child").eq("status", "Pending").in("guardian_id", fam.guardianIds).limit(5)) ?? []) as unknown[];
  if (open.length >= 3) throw new HttpError(409, "Your earlier link requests are still waiting with the school office.");
  return addRequest(inst, { kind: "other", guardian_id: fam.guardian.id, req_type: "Link child", details: `${i.name} · admission no. ${i.admission_no} · ${i.class_name}` }, me);
}

// ═════════════ consent ═════════════
export const PURPOSES = [
  { key: "photos", label: "Photos of my child in the school gallery and newsletters", note: "Optional", locked: false },
  { key: "whatsapp", label: "School messages on WhatsApp", note: "Optional", locked: false },
  { key: "health", label: "Health records shared with the school nurse and counsellor", note: "Needed for care", locked: true },
  { key: "bus", label: "Live bus location shared with me", note: "Needed for transport", locked: true },
  { key: "studies", label: "Anonymised data used for school improvement studies", note: "Optional", locked: false },
  { key: "marketing", label: "Information about summer camps and paid programmes", note: "Optional", locked: false },
] as const;

export async function consents(inst: string, me: string) {
  const fam = await family(inst, me);
  const res = await supabaseAdmin.from("consent_records").select("purpose, choice, recorded_at").eq("institution_id", inst).in("guardian_id", fam.guardianIds).order("recorded_at", { ascending: false }).limit(500);
  const ready = !missingColumn(res.error);
  const rows = (ready ? check(res) ?? [] : []) as { purpose: string; choice: string; recorded_at: string }[];
  return {
    ready, note: ready ? "" : NEEDS_123,
    parent: fam.guardian.full_name, children: andList(fam.children.map((c) => c.first_name)),
    items: PURPOSES.map((p) => { const last = rows.find((r) => r.purpose === p.label); return { key: p.key, label: p.label, note: p.note, locked: p.locked, state: p.locked ? "Given" : last?.choice ?? "Not given", on: last?.recorded_at ?? null }; }),
  };
}

export async function setConsent(inst: string, me: string, input: unknown) {
  const i = z.object({ key: z.enum(["photos", "whatsapp", "studies", "marketing"], { message: "That consent cannot be changed while the service is used." }), choice: z.enum(["Given", "Withdrawn"]) }).strict().parse(input);
  const fam = await family(inst, me);
  const p = PURPOSES.find((x) => x.key === i.key)!;
  const saved = await supabaseAdmin.from("consent_records").insert({ institution_id: inst, guardian_id: fam.guardian.id, parent_name: fam.guardian.full_name.slice(0, 100), purpose: p.label, choice: i.choice, source: "Parent portal" }).select("id");
  if (missingColumn(saved.error)) throw new HttpError(409, NEEDS_123);
  check(saved);
  if (i.key === "photos") await photoConsent(inst, fam, i.choice);
  return consents(inst, me);
}

/** The photo choice shows on the gallery's consent list, which the school checks before publishing photos. */
async function photoConsent(inst: string, fam: Family, choice: "Given" | "Withdrawn") {
  for (const c of fam.children) {
    if (choice === "Given") { check(await supabaseAdmin.from("gallery_consent").update({ status: "Received" }).eq("institution_id", inst).eq("student_id", c.id).eq("status", "Waiting for parent").select("id")); continue; }
    const waiting = (check(await supabaseAdmin.from("gallery_consent").select("id").eq("institution_id", inst).eq("student_id", c.id).eq("status", "Waiting for parent").limit(1)) ?? []) as unknown[];
    if (!waiting.length) check(await supabaseAdmin.from("gallery_consent").insert({ institution_id: inst, student_id: c.id, student_name: c.name.slice(0, 80), class_label: c.class_label.slice(0, 40), parent_name: fam.guardian.full_name.slice(0, 80), reason: "Photo consent withdrawn by parent", recorded_on: today(), status: "Waiting for parent" }).select("id"));
  }
}

export async function useRight(inst: string, me: string, input: unknown) {
  const i = z.object({ kind: z.enum(["Access copy", "Correction", "Erasure", "Grievance"]), details: txt(300).optional(), student_id: z.string().uuid().optional() }).strict().parse(input);
  if (i.kind !== "Access copy" && (i.details ?? "").length < 3) throw new HttpError(400, "Describe what you need.");
  const fam = await family(inst, me);
  const student = i.student_id ? (await childOf(inst, me, i.student_id)).child.id : undefined;
  if (i.kind === "Grievance") {
    const r = await addFeedback(inst, { kind: "complaint", guardian_id: fam.guardian.id, student_id: student ?? "", about: "Data privacy grievance", comment: i.details }, me) as unknown as { code: string };
    return { ok: true, code: r.code };
  }
  const row = await supabaseAdmin.from("data_requests").insert({ institution_id: inst, guardian_id: fam.guardian.id, parent_name: fam.guardian.full_name.slice(0, 100), kind: i.kind, details: i.details ?? "" }).select("id");
  if (missingColumn(row.error)) throw new HttpError(409, NEEDS_123);
  check(row);
  return { ok: true };
}

/** Guardians who have withdrawn WhatsApp consent (their latest choice). School senders leave these numbers out of WhatsApp. */
export async function whatsappRefusals(inst: string): Promise<Set<string>> {
  const purpose = PURPOSES.find((p) => p.key === "whatsapp")!.label;
  const res = await supabaseAdmin.from("consent_records").select("guardian_id, choice").eq("institution_id", inst).eq("purpose", purpose).not("guardian_id", "is", null).order("recorded_at", { ascending: false }).limit(20000);
  if (res.error) { if (missingColumn(res.error)) return new Set(); throw new HttpError(500, res.error.message); }
  const seen = new Set<string>(); const no = new Set<string>();
  for (const r of (res.data ?? []) as { guardian_id: string; choice: string }[]) { if (seen.has(r.guardian_id)) continue; seen.add(r.guardian_id); if (r.choice === "Withdrawn") no.add(r.guardian_id); }
  return no;
}
