import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Admission programmes (rules, ranking, seats), seat offers, the offer letter and automatic messages. Always one school. */
const CLASSES = ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)];

const DEFAULTS: { name: string; classes: string; min_age: number; overall_pct: number | null; seats_total: number; assessment: string; test_weight: number; interview_weight: number; seats_on_merit: number; categories: Record<string, number> }[] = [
  { name: "Nursery", classes: "Nursery", min_age: 3, overall_pct: null, seats_total: 60, assessment: "Interaction with parent and child", test_weight: 0, interview_weight: 100, seats_on_merit: 33, categories: { General: 33, "RTE / EWS": 15, "Staff ward": 3, Sibling: 6, Management: 3 } },
  { name: "LKG", classes: "LKG", min_age: 4, overall_pct: null, seats_total: 20, assessment: "Interaction with parent and child", test_weight: 0, interview_weight: 100, seats_on_merit: 13, categories: { General: 13, "Staff ward": 2, Sibling: 4, Management: 1 } },
  { name: "UKG", classes: "UKG", min_age: 5, overall_pct: null, seats_total: 12, assessment: "Interaction with parent and child", test_weight: 0, interview_weight: 100, seats_on_merit: 8, categories: { General: 8, "Staff ward": 1, Sibling: 2, Management: 1 } },
  { name: "Class 1", classes: "Class 1", min_age: 6, overall_pct: null, seats_total: 80, assessment: "Interaction with parent and child", test_weight: 0, interview_weight: 100, seats_on_merit: 44, categories: { General: 44, "RTE / EWS": 20, "Staff ward": 4, Sibling: 8, Management: 4 } },
  { name: "Classes 2 – 5", classes: "Class 2,Class 3,Class 4,Class 5", min_age: 7, overall_pct: 50, seats_total: 30, assessment: "Written test in English and Maths, then interview", test_weight: 60, interview_weight: 40, seats_on_merit: 22, categories: { General: 22, "Staff ward": 2, Sibling: 4, Management: 2 } },
  { name: "Classes 6 – 9", classes: "Class 6,Class 7,Class 8,Class 9", min_age: 11, overall_pct: 55, seats_total: 38, assessment: "Written test in English, Maths and Science, then interview", test_weight: 60, interview_weight: 40, seats_on_merit: 30, categories: { General: 30, "Staff ward": 2, Sibling: 4, Management: 2 } },
  { name: "Class 11 · MPC", classes: "Class 11", min_age: 15, overall_pct: 70, seats_total: 40, assessment: "Written test in Maths and Science, then interview", test_weight: 70, interview_weight: 30, seats_on_merit: 34, categories: { General: 34, "Staff ward": 2, Sibling: 2, Management: 2 } },
  { name: "Class 11 · BiPC", classes: "Class 11", min_age: 15, overall_pct: 70, seats_total: 40, assessment: "Written test in Science, then interview", test_weight: 70, interview_weight: 30, seats_on_merit: 34, categories: { General: 34, "Staff ward": 2, Sibling: 2, Management: 2 } },
  { name: "Class 11 · MEC", classes: "Class 11", min_age: 15, overall_pct: 60, seats_total: 40, assessment: "Written test in Maths and English, then interview", test_weight: 60, interview_weight: 40, seats_on_merit: 34, categories: { General: 34, "Staff ward": 2, Sibling: 2, Management: 2 } },
];

export type Programme = (typeof DEFAULTS)[number] & { sort_order: number; tie_break: string };

export async function programmes(inst: string): Promise<Programme[]> {
  const cols = "name, classes, min_age, overall_pct, seats_total, assessment, test_weight, interview_weight, seats_on_merit, tie_break, categories, sort_order";
  let rows = check(await supabaseAdmin.from("adm_programmes").select(cols).eq("institution_id", inst).order("sort_order")) as Programme[];
  if (!rows.length) rows = check(await supabaseAdmin.from("adm_programmes").upsert(DEFAULTS.map((d, i) => ({ institution_id: inst, ...d, tie_break: d.interview_weight === 100 ? "Older child first" : "Higher interview score, then older child", sort_order: i + 1 })), { onConflict: "institution_id,name" }).select(cols)) as Programme[];
  return rows.sort((a, b) => a.sort_order - b.sort_order);
}

export async function saveProgrammes(inst: string, body: unknown) {
  const { rows } = z.object({ rows: z.array(z.object({ name: z.string().max(80), min_age: z.number().int().min(1).max(25).optional(), overall_pct: z.number().int().min(0).max(100).nullable().optional(), seats_total: z.number().int().min(0).max(100000).optional(), test_weight: z.number().int().min(0).max(100).optional(), interview_weight: z.number().int().min(0).max(100).optional(), seats_on_merit: z.number().int().min(0).max(100000).optional() })).max(40) }).strict().parse(body);
  for (const r of rows) {
    const { name, ...rest } = r;
    if (rest.test_weight !== undefined && rest.interview_weight !== undefined && rest.test_weight + rest.interview_weight !== 100) throw new HttpError(400, `${name}: the two weights must add up to 100.`);
    if (Object.keys(rest).length) check(await supabaseAdmin.from("adm_programmes").update(rest).eq("institution_id", inst).eq("name", name).select("name"));
  }
  return programmes(inst);
}

/** The programme a child applying to `cls` (and optionally a stream) belongs to. */
export function programmeFor(list: Programme[], cls: string, stream?: string): Programme | null {
  const c = CLASSES.find((x) => cls === x || cls.startsWith(x + " ")) ?? cls;
  const hit = list.filter((p) => p.classes.split(",").map((x) => x.trim()).includes(c));
  return (stream ? hit.find((p) => p.name.toLowerCase().includes(stream.toLowerCase())) : null) ?? hit[0] ?? null;
}

interface AppRow { id: string; code: string; child: string; class_sought: string; status: string; details: Record<string, string> | null }
const apps = async (inst: string) => check(await supabaseAdmin.from("adm_applications").select("id, code, child, class_sought, status, details").eq("institution_id", inst).limit(5000)) as AppRow[];

async function testPercent(inst: string): Promise<Map<string, number>> {
  const tests = check(await supabaseAdmin.from("adm_tests").select("id, max_marks").eq("institution_id", inst)) as { id: string; max_marks: number }[];
  const max = new Map(tests.map((t) => [t.id, t.max_marks]));
  if (!tests.length) return new Map();
  const marks = check(await supabaseAdmin.from("adm_test_marks").select("test_id, application_id, marks").in("test_id", tests.map((t) => t.id))) as { test_id: string; application_id: string; marks: Record<string, number> }[];
  const out = new Map<string, number>();
  for (const m of marks) { const total = Object.values(m.marks).reduce((s, v) => s + Number(v), 0); const pct = (total / (max.get(m.test_id) || 1)) * 100; out.set(m.application_id, Math.max(out.get(m.application_id) ?? 0, pct)); }
  return out;
}

export async function offers(inst: string) {
  return check(await supabaseAdmin.from("adm_offers").select("id, application_id, category, offered_on, accept_by, status, app:application_id(code, child, class_sought, parent_name)").eq("institution_id", inst).order("offered_on", { ascending: false }).limit(2000)) as unknown[];
}

export async function meritList(inst: string, programme?: string) {
  const [list, all, pct, off] = await Promise.all([programmes(inst), apps(inst), testPercent(inst), offers(inst) as Promise<{ application_id: string; status: string }[]>]);
  const p = list.find((x) => x.name === programme) ?? list[0];
  const offered = new Map(off.map((o) => [o.application_id, o.status]));
  const rows = all.filter((a) => programmeFor(list, a.class_sought, a.details?.stream)?.name === p.name && !["Returned", "Rejected"].includes(a.status))
    .map((a) => ({ id: a.id, code: a.code, child: a.child, category: a.details?.category || "General", test: pct.has(a.id) ? Math.round(pct.get(a.id)!) : null, dob: a.details?.dob ?? "", status: a.status, offer: offered.get(a.id) ?? null }))
    .sort((a, b) => (b.test ?? -1) - (a.test ?? -1) || (a.dob || "9999").localeCompare(b.dob || "9999"));
  const scored = rows.filter((r) => r.test !== null);
  const ranked = rows.map((r, i) => ({ ...r, rank: i + 1, score: r.test, state: r.offer ?? (r.test === null ? "Not assessed" : i < p.seats_on_merit ? "Eligible for offer" : "Waitlist") }));
  const cut = scored[Math.min(p.seats_on_merit, scored.length) - 1];
  return { programmes: list.map((x) => x.name), programme: p, rows: ranked, cutoff: cut?.test ?? null };
}

export async function seatMatrix(inst: string) {
  const [list, off, all] = await Promise.all([programmes(inst), offers(inst) as Promise<{ application_id: string; category: string; status: string }[]>, apps(inst)]);
  const byApp = new Map(all.map((a) => [a.id, a]));
  return list.map((p) => {
    const confirmed: Record<string, number> = {};
    for (const o of off) { if (!["Fee paid", "Confirmed", "Accepted"].includes(o.status)) continue; const a = byApp.get(o.application_id); if (a && programmeFor(list, a.class_sought, a.details?.stream)?.name === p.name) confirmed[o.category] = (confirmed[o.category] ?? 0) + 1; }
    return { name: p.name, total: p.seats_total, categories: Object.fromEntries(Object.entries(p.categories).map(([k, v]) => [k, { seats: v, confirmed: confirmed[k] ?? 0 }])), open: p.seats_total - Object.values(confirmed).reduce((s, v) => s + v, 0) };
  });
}

/** Called when the last approval level approves: creates the seat offer with its deadline. */
export async function createOffer(inst: string, applicationId: string) {
  const a = check(await supabaseAdmin.from("adm_applications").select("details").eq("id", applicationId).maybeSingle()) as { details: Record<string, string> | null } | null;
  const s = check(await supabaseAdmin.from("adm_fee_settings").select("pay_within_days").eq("institution_id", inst).maybeSingle()) as { pay_within_days: number } | null;
  const by = new Date(Date.now() + (s?.pay_within_days ?? 7) * 86_400_000).toISOString().slice(0, 10);
  check(await supabaseAdmin.from("adm_offers").upsert({ institution_id: inst, application_id: applicationId, category: a?.details?.category || "General", accept_by: by, status: "Offered" }, { onConflict: "application_id" }).select("id"));
}

export async function setOfferStatus(inst: string, id: string, body: unknown) {
  const { status } = z.object({ status: z.enum(["Accepted", "Fee paid", "Confirmed"]) }).strict().parse(body);
  const row = check(await supabaseAdmin.from("adm_offers").update({ status }).eq("id", id).eq("institution_id", inst).select("id, status").maybeSingle());
  if (!row) throw new HttpError(404, "Offer not found.");
  return row;
}

/** Expires offers past their deadline and offers the seat to the next waitlisted family of the same programme. */
export async function releaseExpired(inst: string) {
  const today = new Date().toISOString().slice(0, 10);
  const late = check(await supabaseAdmin.from("adm_offers").update({ status: "Expired" }).eq("institution_id", inst).eq("status", "Offered").lt("accept_by", today).select("application_id")) as { application_id: string }[];
  const list = await programmes(inst);
  const all = await apps(inst);
  const byApp = new Map(all.map((a) => [a.id, a]));
  let offered = 0;
  for (const o of late) {
    const a = byApp.get(o.application_id);
    if (!a) continue;
    const name = programmeFor(list, a.class_sought, a.details?.stream)?.name;
    const next = all.find((x) => x.status === "Waitlisted" && programmeFor(list, x.class_sought, x.details?.stream)?.name === name);
    if (!next) continue;
    check(await supabaseAdmin.from("adm_applications").update({ status: "Approved" }).eq("id", next.id).select("id"));
    await createOffer(inst, next.id);
    next.status = "Approved";
    offered++;
  }
  return { expired: late.length, offered };
}

export const DEFAULT_LETTER = `{school} · Admissions
Ref: {app} · {date}
Dear Parent,
We are happy to offer {child} a seat in {class} ({category}) for the coming academic year.
To accept, pay the admission fee, caution deposit and Term 1 fees of {fee} by {deadline}.
If the fee is not received by {deadline}, the offer lapses and the seat is offered to the next child on the waitlist.
We look forward to welcoming {child} to the school.
Admissions Office`;
const STAGES = ["Application received", "Documents returned", "Assessment slot booked", "Result published", "Offer made", "Offer expiring (48 h and 12 h)", "Fee received", "Admission confirmed"];

export async function settings(inst: string) {
  const s = check(await supabaseAdmin.from("adm_settings").select("letter_template, auto_messages").eq("institution_id", inst).maybeSingle()) as { letter_template: string | null; auto_messages: Record<string, boolean> } | null;
  const school = check(await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()) as { name: string } | null;
  return { school: school?.name ?? "", template: s?.letter_template ?? DEFAULT_LETTER, stages: STAGES.map((st) => ({ stage: st, enabled: s?.auto_messages?.[st] !== false })) };
}

export async function saveSettings(inst: string, body: unknown) {
  const input = z.object({ template: z.string().min(10).max(4000).optional(), stage: z.string().max(80).optional(), enabled: z.boolean().optional(), reset: z.boolean().optional() }).strict().parse(body);
  const cur = await settings(inst);
  const auto = Object.fromEntries(cur.stages.map((x) => [x.stage, x.enabled]));
  if (input.stage !== undefined && input.enabled !== undefined) {
    if (!STAGES.includes(input.stage)) throw new HttpError(400, "Unknown stage.");
    auto[input.stage] = input.enabled;
  }
  const template = input.reset ? null : input.template ?? (cur.template === DEFAULT_LETTER ? null : cur.template);
  check(await supabaseAdmin.from("adm_settings").upsert({ institution_id: inst, letter_template: template, auto_messages: auto }, { onConflict: "institution_id" }).select("institution_id"));
  return settings(inst);
}
