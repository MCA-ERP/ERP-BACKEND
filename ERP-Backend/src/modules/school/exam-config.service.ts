import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Exam types and marks settings for one school. (The grading scale lives with the academic rules.) */
interface Row { id: string; name: string; weightage: number | null; included: boolean; max_marks: number; max_marks_alt: number | null; classes: string; status: string }
const show = (r: Row) => ({ id: r.id, name: r.name, weightage: r.weightage, included: r.included, max_marks: r.max_marks, max_marks_alt: r.max_marks_alt, classes: r.classes, status: r.status, weightage_text: r.included ? "Included" : r.weightage == null ? "—" : `${r.weightage}%`, max_text: r.max_marks_alt ? `${r.max_marks_alt} / ${r.max_marks}` : String(r.max_marks) });

export async function listExamTypes(inst: string) {
  return { items: (check(await supabaseAdmin.from("exam_types").select("id, name, weightage, included, max_marks, max_marks_alt, classes, status").eq("institution_id", inst).order("created_at", { ascending: false })) as unknown as Row[]).map(show) };
}
const body = z.object({
  name: z.string().trim().min(2, "Enter the exam type.").max(60), weightage: z.number().int().min(0).max(100).nullable().optional(), included: z.boolean().optional(),
  max_marks: z.number().int().min(1).max(1000), max_marks_alt: z.number().int().min(1).max(1000).nullable().optional(), classes: z.string().trim().max(40).regex(/^[0-9 ,–-]*$/, "Use numbers like 1 – 10 or 10, 12.").optional(), status: z.enum(["Active", "Inactive"]).optional(),
}).strict();
const total = async (inst: string, name: string, weight: number | null | undefined, skip?: string) => {
  const rows = check(await supabaseAdmin.from("exam_types").select("id, name, weightage, status").eq("institution_id", inst)) as { id: string; name: string; weightage: number | null; status: string }[];
  if (rows.some((r) => r.id !== skip && r.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "That exam type already exists.");
  void weight;
};
export async function addExamType(inst: string, input: unknown) {
  const i = body.parse(input);
  if (i.max_marks_alt && i.max_marks_alt > i.max_marks) throw new HttpError(400, "The second maximum can't be above the first.");
  await total(inst, i.name, i.weightage);
  return check(await supabaseAdmin.from("exam_types").insert({ institution_id: inst, name: i.name, weightage: i.included ? null : i.weightage ?? null, included: i.included ?? false, max_marks: i.max_marks, max_marks_alt: i.max_marks_alt ?? null, classes: i.classes ?? "", status: i.status ?? "Active" }).select("id").single());
}
export async function updateExamType(inst: string, id: string, input: unknown) {
  const i = body.parse(input);
  if (i.max_marks_alt && i.max_marks_alt > i.max_marks) throw new HttpError(400, "The second maximum can't be above the first.");
  await total(inst, i.name, i.weightage, id);
  const r = check(await supabaseAdmin.from("exam_types").update({ name: i.name, weightage: i.included ? null : i.weightage ?? null, included: i.included ?? false, max_marks: i.max_marks, max_marks_alt: i.max_marks_alt ?? null, classes: i.classes ?? "", ...(i.status ? { status: i.status } : {}) }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Exam type not found.");
  return { ok: true };
}

const DEFAULTS = { enter_as: "Marks", round: "To 1 decimal", entry_days: "5 days", lock_verified: true, show_average: true, show_rank: false };
export type MarksConfig = typeof DEFAULTS;
const cfg = z.object({ enter_as: z.enum(["Marks", "Percentage", "Grade"]), round: z.enum(["To whole number", "To 1 decimal", "To 2 decimals"]), entry_days: z.enum(["Same day", "2 days", "5 days", "10 days"]), lock_verified: z.boolean(), show_average: z.boolean(), show_rank: z.boolean() }).partial().strict();
export async function getMarksSettings(inst: string): Promise<MarksConfig> {
  const r = check(await supabaseAdmin.from("exam_settings").select("config").eq("institution_id", inst).maybeSingle()) as { config: Partial<MarksConfig> } | null;
  return { ...DEFAULTS, ...(r?.config ?? {}) };
}
export async function saveMarksSettings(inst: string, input: unknown) {
  const merged = { ...(await getMarksSettings(inst)), ...cfg.parse(input) };
  check(await supabaseAdmin.from("exam_settings").upsert({ institution_id: inst, config: merged }, { onConflict: "institution_id" }).select("institution_id"));
  return merged;
}
