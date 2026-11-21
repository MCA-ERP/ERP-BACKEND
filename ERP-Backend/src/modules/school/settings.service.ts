import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { gstValid } from "./inv2.service";
import { profile, saveProfile } from "./custom.service";

/** School settings. Each group is one validated JSON document, stored for the features that read it. */
const bool = z.boolean(); const hm = z.string().regex(/^\d{2}:\d{2}$/, "Use a time like 10:00.");
const GROUPS: Record<string, { schema: z.ZodObject<z.ZodRawShape>; defaults: Record<string, unknown> }> = {
  campus: { schema: z.object({ share_fee: bool, share_timetable: bool, separate_receipts: bool, transfer_between: bool }).strict(), defaults: { share_fee: true, share_timetable: false, separate_receipts: true, transfer_between: true } },
  medium: { schema: z.object({ medium: z.enum(["English", "Telugu", "Hindi", "Urdu"]), second_language: z.enum(["Hindi or Telugu", "Hindi", "Telugu", "None"]), third_language: z.enum(["Telugu or French", "Telugu", "French", "None"]) }).strict(), defaults: { medium: "English", second_language: "Hindi or Telugu", third_language: "Telugu or French" } },
  board_level: { schema: z.object({ level: z.enum(["Primary", "Secondary", "Senior secondary"]) }).strict(), defaults: { level: "Senior secondary" } },
  fee_rules: { schema: z.object({ block_report_cards: bool, block_hall_tickets: bool, sibling_discount: z.number().int().min(0).max(50), staff_concession: z.number().int().min(0).max(100), refund_days: z.enum(["7", "15", "30", "45"]) }).strict(), defaults: { block_report_cards: false, block_hall_tickets: false, sibling_discount: 10, staff_concession: 50, refund_days: "15" } },
  app_fee: { schema: z.object({ nursery_ukg: z.number().int().min(0).max(100000), classes_1_10: z.number().int().min(0).max(100000), class_11: z.number().int().min(0).max(100000), non_refundable: bool, online: bool, front_office: bool, block_verification: bool, allow_waivers: bool, who_waive: z.enum(["Admissions Head", "Principal", "Accountant"]) }).strict(), defaults: { nursery_ukg: 750, classes_1_10: 1000, class_11: 1500, non_refundable: true, online: true, front_office: true, block_verification: true, allow_waivers: true, who_waive: "Admissions Head" } },
  payment_opts: { schema: z.object({ upi: bool, phonepe: bool, gpay: bool, cards_paid_by: z.enum(["School", "Parent"]), net_banking: bool, cheque: bool, cash: bool, autodebit: bool }).strict(), defaults: { upi: true, phonepe: true, gpay: true, cards_paid_by: "School", net_banking: true, cheque: true, cash: true, autodebit: false } },
  att_rules: { schema: z.object({ mode: z.enum(["Once a day", "Every period"]), closes_at: hm, half_day: z.enum(["0.5 day present", "Present", "Absent"]), parent_leave: bool, lock_after: z.enum(["Same day", "Next day", "3 days"]) }).strict(), defaults: { mode: "Once a day", closes_at: "10:00", half_day: "0.5 day present", parent_leave: true, lock_after: "Same day" } },
  att_notify: { schema: z.object({ sms_absent: bool, app_absent: bool, daily_summary: bool, weekly_report: bool, alert_unmarked: bool, alert_below: bool }).strict(), defaults: { sms_absent: true, app_absent: true, daily_summary: true, weekly_report: false, alert_unmarked: true, alert_below: true } },
  marks: { schema: z.object({ enter_as: z.enum(["Marks", "Percentage"]), round_off: z.enum(["None", "To 1 decimal", "Nearest whole"]), entry_days: z.number().int().min(0).max(60), lock_verified: bool, show_class_avg: bool, show_rank: bool }).strict(), defaults: { enter_as: "Marks", round_off: "To 1 decimal", entry_days: 5, lock_verified: true, show_class_avg: true, show_rank: false } },
};
type P = { name: string; short_name: string; board: string; affiliation_no: string; udise_code: string; year_established: number | null; principal: string; email: string; phone: string; website: string };
const grp = (k: string) => { const x = GROUPS[k]; if (!x) throw new HttpError(404, "Not found."); return x; };
export async function getSettings(inst: string, key: string) {
  const d = grp(key); const r = check(await supabaseAdmin.from("school_settings").select("value").eq("institution_id", inst).eq("key", key).maybeSingle()) as { value: Record<string, unknown> } | null;
  return { ...d.defaults, ...(r?.value ?? {}) };
}
export async function saveSettings(inst: string, key: string, input: unknown) {
  const d = grp(key); const i = d.schema.partial().parse(input); const merged = { ...(await getSettings(inst, key)), ...i };
  check(await supabaseAdmin.from("school_settings").upsert({ institution_id: inst, key, value: d.schema.parse(merged), updated_at: new Date().toISOString() }).select("key")); return merged;
}
export async function board(inst: string) { const [pr, l] = await Promise.all([profile(inst), getSettings(inst, "board_level")]); const p = pr as unknown as P; return { board: p.board, affiliation_no: p.affiliation_no, level: (l as { level: string }).level }; }
export async function saveBoard(inst: string, input: unknown) {
  const i = z.object({ board: z.enum(["CBSE", "ICSE", "State board", "IB", "Cambridge (IGCSE)"]), affiliation_no: z.string().trim().max(40), level: z.enum(["Primary", "Secondary", "Senior secondary"]) }).strict().parse(input);
  const p = (await profile(inst)) as unknown as P; await saveProfile(inst, "general", { name: p.name, short_name: p.short_name, board: i.board, affiliation_no: i.affiliation_no, udise_code: p.udise_code, year_established: p.year_established, principal: p.principal, email: p.email, phone: p.phone, website: p.website });
  await saveSettings(inst, "board_level", { level: i.level }); return { ok: true };
}
export async function campuses(inst: string) {
  const [c, gr, r] = await Promise.all([supabaseAdmin.from("campuses").select("id, name, city, address, classes_offered, principal_name, campus_admin, gstin, is_main").eq("institution_id", inst).order("is_main", { ascending: false }).order("name"), supabaseAdmin.from("grades").select("id, campus_id").eq("institution_id", inst), roster(inst)]);
  const C = check(c) as { id: string; name: string; city: string | null; address: string | null; classes_offered: string | null; principal_name: string | null; campus_admin: string | null; gstin: string | null; is_main: boolean }[]; const grades = check(gr) as { id: string; campus_id: string | null }[];
  const act = r.items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled"); const main = C.find((x) => x.is_main)?.id ?? C[0]?.id;
  return { items: C.map((x) => ({ id: x.id, name: x.name, area: x.city || x.address || "", classes: x.classes_offered ?? "", students: act.filter((s) => (grades.find((y) => y.id === s.grade_id)?.campus_id ?? main) === x.id).length, head: x.principal_name ?? "", admin: x.campus_admin ?? "", gstin: x.gstin ?? "", is_main: x.is_main })) };
}
export async function setGstin(inst: string, id: string, input: unknown) {
  const { gstin } = z.object({ gstin: z.string().trim().toUpperCase() }).strict().parse(input); if (!gstValid(gstin)) throw new HttpError(400, "That GSTIN isn't valid. Check the 15 characters.");
  const r = check(await supabaseAdmin.from("campuses").update({ gstin }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
