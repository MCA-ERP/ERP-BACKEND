import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** Parents (guardians) of one school: directory, registration, profile, family mapping, app access, messages, and the alumni directory. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const txt = (n: number) => z.string().trim().max(n);
const blank = <T>(v: T | "" | undefined) => (v === "" || v === undefined ? null : v);
const MAIN = ["Father", "Mother"];

interface G { id: string; full_name: string; phone: string; email: string | null; occupation: string | null; qualification: string | null; parent_code: string | null; login_status: "None" | "Active" | "Inactive"; whatsapp: string | null; language: string | null; emergency_name: string | null; emergency_phone: string | null; address: string | null; city: string | null; pincode: string | null; income_band: string | null }
interface Link { student_id: string; guardian_id: string; relation: string; can_pick_up: boolean }
const GCOLS = "id, full_name, phone, email, occupation, qualification, parent_code, login_status, whatsapp, language, emergency_name, emergency_phone, address, city, pincode, income_band";

async function load(inst: string) {
  const [g, l, ro] = await Promise.all([
    supabaseAdmin.from("guardians").select(GCOLS).eq("institution_id", inst).order("created_at", { ascending: false }).limit(10000),
    supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation, can_pick_up, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).limit(20000),
    roster(inst),
  ]);
  const guardians = check(g) as unknown as G[];
  const links = check(l) as unknown as Link[];
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  return { guardians, links, kids };
}

const shape = (g: G, links: Link[], kids: Map<string, { id: string; name: string; class_label: string; status: string }>, all: G[]) => {
  const mine = links.filter((x) => x.guardian_id === g.id);
  const students = mine.map((x) => kids.get(x.student_id)).filter((x): x is NonNullable<typeof x> => !!x).map((s) => ({ id: s.id, name: s.name, class_label: s.class_label }));
  const rel = mine[0]?.relation ?? "Guardian";
  const other = mine.length ? links.filter((x) => x.student_id === mine[0].student_id && x.guardian_id !== g.id && MAIN.includes(x.relation) && MAIN.includes(rel))[0] : undefined;
  const spouse = other ? all.find((x) => x.id === other.guardian_id) : undefined;
  return { id: g.id, name: g.full_name, relation: rel, mobile: g.phone === "-" ? "" : g.phone, email: g.email ?? "", parent_code: g.parent_code ?? "", login: g.login_status === "None" ? "Not installed" : g.login_status, app: g.login_status === "None" ? "Not installed" : "Installed", students, spouse: spouse ? { id: spouse.id, name: spouse.full_name, occupation: spouse.occupation ?? "" } : null, can_pick_up: mine.some((x) => x.can_pick_up) };
};

export async function listParents(inst: string) {
  const { guardians, links, kids } = await load(inst);
  const items = guardians.map((g) => shape(g, links, kids, guardians));
  // a mother who is listed next to the father is shown with him, not twice
  const hidden = new Set(items.filter((p) => p.relation === "Mother").filter((p) => guardians.some((g) => g.id !== p.id && shape(g, links, kids, guardians).spouse?.id === p.id && links.some((x) => x.guardian_id === g.id && x.relation === "Father"))).map((p) => p.id));
  return { items: items.filter((p) => !hidden.has(p.id)) };
}

const addSchema = z.object({ full_name: txt(200).min(2, "Enter the name."), relation: z.enum(["Father", "Mother", "Guardian"]).default("Father"), phone: txt(30).min(8, "Enter the mobile number."), email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(), occupation: txt(100).optional(), student_id: z.string().uuid("Choose the student."), address: txt(400).optional(), create_login: z.boolean().optional() }).strict();
export async function addParent(inst: string, body: unknown) {
  const i = addSchema.parse(body);
  const st = check(await supabaseAdmin.from("students").select("id").eq("id", i.student_id).eq("institution_id", inst).maybeSingle());
  if (!st) throw new HttpError(404, "Student not found.");
  const g = check(await supabaseAdmin.from("guardians").insert({ institution_id: inst, full_name: i.full_name, phone: i.phone, email: blank(i.email), occupation: blank(i.occupation), address: blank(i.address), login_status: i.create_login ? "Active" : "None" }).select("id").single()) as { id: string };
  const has = check(await supabaseAdmin.from("student_guardians").select("guardian_id").eq("student_id", i.student_id)) as unknown[];
  check(await supabaseAdmin.from("student_guardians").insert({ student_id: i.student_id, guardian_id: g.id, relation: i.relation, is_primary_contact: !has.length }).select("student_id"));
  return { id: g.id };
}

const REQ = ["Full name", "Relation", "Mobile", "Student"];
export async function bulkParents(inst: string, body: unknown) {
  const rows = z.array(z.object({ full_name: z.string(), relation: z.string().optional(), phone: z.string(), email: z.string().optional(), student_admission_no: z.string().optional() })).max(2000).parse((body as { rows?: unknown })?.rows ?? []);
  const ro = await roster(inst);
  const by = new Map(ro.items.map((r) => [r.registration_no.toLowerCase(), r]));
  let added = 0;
  const problems: { row: number; message: string }[] = [];
  for (const [n, r] of rows.entries()) {
    const stu = by.get((r.student_admission_no ?? "").trim().toLowerCase());
    if (!r.full_name.trim() || !r.phone.trim()) { problems.push({ row: n + 2, message: "Name or mobile is missing" }); continue; }
    if (!stu) { problems.push({ row: n + 2, message: "Student admission number not found" }); continue; }
    const rel = /mother/i.test(r.relation ?? "") ? "Mother" : /guard/i.test(r.relation ?? "") ? "Guardian" : "Father";
    try { await addParent(inst, { full_name: r.full_name.trim(), relation: rel, phone: r.phone.trim(), email: (r.email ?? "").trim(), student_id: stu.id }); added++; } catch (e) { problems.push({ row: n + 2, message: e instanceof Error ? e.message : "Could not add" }); }
  }
  void REQ;
  return { added, problems };
}

async function guardian(inst: string, id: string) {
  const g = check(await supabaseAdmin.from("guardians").select(GCOLS).eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as G | null;
  if (!g) throw new HttpError(404, "Parent not found.");
  return g;
}

export async function getParent(inst: string, id: string) {
  const { guardians, links, kids } = await load(inst);
  const g = guardians.find((x) => x.id === id);
  if (!g) throw new HttpError(404, "Parent not found.");
  return { ...shape(g, links, kids, guardians), qualification: g.qualification ?? "", occupation: g.occupation ?? "", whatsapp: g.whatsapp ?? "", language: g.language ?? "", emergency_name: g.emergency_name ?? "", emergency_phone: g.emergency_phone ?? "", address: g.address ?? "", city: g.city ?? "", pincode: g.pincode ?? "", income_band: g.income_band ?? "" };
}

const profileSchema = z.object({
  full_name: txt(200).min(2).optional(), occupation: txt(100).optional(), qualification: txt(100).optional(), income_band: txt(40).optional(), spouse_name: txt(200).optional(), spouse_occupation: txt(100).optional(),
  phone: txt(30).min(8).optional(), email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(), whatsapp: txt(30).optional(), language: txt(30).optional(), emergency_name: txt(150).optional(), emergency_phone: txt(30).optional(),
  address: txt(400).optional(), city: txt(100).optional(), pincode: txt(10).optional(),
}).strict();
export async function saveParent(inst: string, id: string, body: unknown) {
  await guardian(inst, id);
  const { spouse_name, spouse_occupation, ...i } = profileSchema.parse(body);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(i)) if (v !== undefined) patch[k] = k === "full_name" || k === "phone" ? v : blank(v as string);
  check(await supabaseAdmin.from("guardians").update(patch).eq("id", id).eq("institution_id", inst).select("id"));
  if (spouse_name !== undefined || spouse_occupation !== undefined) {
    const p = await getParent(inst, id);
    if (p.spouse) {
      const sp: Record<string, unknown> = {};
      if (spouse_name) sp.full_name = spouse_name;
      if (spouse_occupation !== undefined) sp.occupation = blank(spouse_occupation);
      if (Object.keys(sp).length) check(await supabaseAdmin.from("guardians").update(sp).eq("id", p.spouse.id).eq("institution_id", inst).select("id"));
    }
  }
  return getParent(inst, id);
}

export async function linkStudent(inst: string, id: string, body: unknown) {
  await guardian(inst, id);
  const i = z.object({ student_id: z.string().uuid("Choose the student."), relation: z.enum(["Father", "Mother", "Guardian"]).default("Father") }).strict().parse(body);
  const st = check(await supabaseAdmin.from("students").select("id").eq("id", i.student_id).eq("institution_id", inst).maybeSingle());
  if (!st) throw new HttpError(404, "Student not found.");
  const ex = check(await supabaseAdmin.from("student_guardians").select("guardian_id").eq("student_id", i.student_id).eq("guardian_id", id)) as unknown[];
  if (ex.length) throw new HttpError(409, "That student is already linked to this parent.");
  check(await supabaseAdmin.from("student_guardians").insert({ student_id: i.student_id, guardian_id: id, relation: i.relation }).select("student_id"));
  return getParent(inst, id);
}

export async function setLogin(inst: string, id: string, body: unknown) {
  const g = await guardian(inst, id);
  const { action } = z.object({ action: z.enum(["create", "activate", "deactivate", "reset"]) }).strict().parse(body);
  if (action === "create") { if (g.login_status !== "None") throw new HttpError(409, "This parent already has a login."); check(await supabaseAdmin.from("guardians").update({ login_status: "Active" }).eq("id", id).eq("institution_id", inst).select("id")); }
  else if (action === "activate") check(await supabaseAdmin.from("guardians").update({ login_status: "Active" }).eq("id", id).eq("institution_id", inst).select("id"));
  else if (action === "deactivate") check(await supabaseAdmin.from("guardians").update({ login_status: "Inactive" }).eq("id", id).eq("institution_id", inst).select("id"));
  else { if (g.login_status === "None") throw new HttpError(409, "Create a login first."); check(await supabaseAdmin.from("guardians").update({ otp_requested_at: new Date().toISOString() }).eq("id", id).eq("institution_id", inst).select("id")); }
  return getParent(inst, id);
}

/** Students of the same parent, and students whose guardian is not a parent. */
export async function family(inst: string) {
  const { guardians, links, kids } = await load(inst);
  const byG = new Map<string, Link[]>();
  for (const l of links) byG.set(l.guardian_id, [...(byG.get(l.guardian_id) ?? []), l]);
  const siblings = [...byG.entries()].map(([gid, ls]) => ({ g: guardians.find((x) => x.id === gid), ls })).filter((x) => x.g && MAIN.includes(x.ls[0].relation) && x.ls.length > 1).map(({ g, ls }) => ({ id: g!.id, family: `${g!.full_name.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, "").split(" ").slice(-1)[0]} family`, children: ls.map((l) => kids.get(l.student_id)).filter(Boolean).map((s) => ({ id: s!.id, name: s!.name, class_label: s!.class_label })) }));
  const guardianOf = links.filter((l) => !MAIN.includes(l.relation)).map((l) => ({ id: `${l.student_id}:${l.guardian_id}`, student: kids.get(l.student_id), guardian: guardians.find((g) => g.id === l.guardian_id), relation: l.relation, can_pick_up: l.can_pick_up })).filter((x) => x.student && x.guardian).map((x) => ({ id: x.id, student_id: x.student!.id, student: x.student!.name, guardian: x.guardian!.full_name, relation: x.relation, can_pick_up: x.can_pick_up }));
  return { siblings, guardians: guardianOf };
}

// ═════════════ messages ═════════════
const MK: Record<string, string[]> = { message: ["Delivered", "Read", "Replied"], notification: ["Delivered", "Read"], meeting: ["Scheduled", "Held", "Cancelled"] };
export async function listMessages(inst: string, kind: string) {
  if (!MK[kind]) throw new HttpError(404, "Unknown type.");
  const rows = check(await supabaseAdmin.from("parent_messages").select("id, code, kind, subject, body, sent_on, status, student_id, guardian_id, guardians:guardian_id(full_name)").eq("institution_id", inst).eq("kind", kind).order("sent_on", { ascending: false }).order("created_at", { ascending: false }).limit(2000)) as unknown as { id: string; code: string; kind: string; subject: string; body: string | null; sent_on: string; status: string; student_id: string | null; guardian_id: string; guardians: { full_name: string } | { full_name: string }[] | null }[];
  const ro = await roster(inst);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  return { statuses: MK[kind], items: rows.map((r) => ({ id: r.id, code: r.code, subject: r.subject, body: r.body ?? "", sent_on: r.sent_on, status: r.status, parent: one(r.guardians)?.full_name ?? "", student_id: r.student_id, student: r.student_id ? kids.get(r.student_id)?.name ?? "" : "" })) };
}
export async function addMessage(inst: string, body: unknown, actor?: string) {
  const i = z.object({ kind: z.enum(["message", "notification", "meeting"]), guardian_id: z.string().uuid("Choose the parent."), student_id: z.string().uuid().optional().or(z.literal("")), subject: txt(200).min(2, "Enter a subject."), body: txt(2000).optional(), sent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(body);
  await guardian(inst, i.guardian_id);
  return check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: i.kind, guardian_id: i.guardian_id, student_id: i.student_id || null, subject: i.subject, body: blank(i.body), ...(i.sent_on ? { sent_on: i.sent_on } : {}), status: MK[i.kind][0], created_by: actor ?? null }).select("id, code").single());
}
export async function setMessageStatus(inst: string, id: string, body: unknown) {
  const { status } = z.object({ status: z.string() }).strict().parse(body);
  const m = check(await supabaseAdmin.from("parent_messages").select("id, kind").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; kind: string } | null;
  if (!m) throw new HttpError(404, "Not found.");
  if (!MK[m.kind].includes(status)) throw new HttpError(400, "That status is not available here.");
  check(await supabaseAdmin.from("parent_messages").update({ status }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ alumni ═════════════
export async function listAlumni(inst: string) {
  const [a, e] = await Promise.all([
    supabaseAdmin.from("alumni").select("id, full_name, batch_year, last_class, studied, now_at, email, phone, helps_as, given_amount, given_on").eq("institution_id", inst).order("batch_year", { ascending: false }).order("full_name").limit(5000),
    supabaseAdmin.from("alumni_events").select("id, title, event_date, audience").eq("institution_id", inst).order("event_date", { ascending: false }).limit(200),
  ]);
  return { items: check(a) as unknown[], events: check(e) as unknown[] };
}
export async function addAlumnus(inst: string, body: unknown) {
  const i = z.object({ full_name: txt(150).min(2, "Enter the name."), batch_year: z.number().int().min(1900).max(2100), last_class: txt(60).optional(), studied: txt(150).optional(), now_at: txt(150).optional(), email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(), phone: txt(30).optional(), helps_as: z.enum(["Active", "Given", "Upcoming"]).nullable().optional(), given_amount: z.number().int().min(0).optional() }).strict().parse(body);
  return check(await supabaseAdmin.from("alumni").insert({ institution_id: inst, full_name: i.full_name, batch_year: i.batch_year, last_class: blank(i.last_class), studied: blank(i.studied), now_at: blank(i.now_at), email: blank(i.email), phone: blank(i.phone), helps_as: i.helps_as ?? null, given_amount: i.given_amount ?? 0, given_on: i.given_amount ? new Date().toISOString().slice(0, 10) : null }).select("id").single());
}
export async function addAlumniEvent(inst: string, body: unknown) {
  const i = z.object({ title: txt(200).min(2, "Enter the event name."), event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date."), audience: txt(150).optional() }).strict().parse(body);
  return check(await supabaseAdmin.from("alumni_events").insert({ institution_id: inst, title: i.title, event_date: i.event_date, audience: blank(i.audience) }).select("id").single());
}
