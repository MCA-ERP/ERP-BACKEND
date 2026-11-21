import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Academic years and the boards a school runs. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

interface Y { id: string; name: string; start_date: string; end_date: string; is_current: boolean; is_locked: boolean; working_days: number | null }
const status = (y: Y) => (y.is_current ? "Active" : y.is_locked ? "Closed" : "Draft");

export async function listYears(inst: string) {
  const [y, e] = await Promise.all([
    supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, is_current, is_locked, working_days").eq("institution_id", inst).order("start_date", { ascending: false }),
    supabaseAdmin.from("student_enrollments").select("academic_year_id").eq("institution_id", inst).limit(100000),
  ]);
  const counts = new Map<string, number>();
  for (const r of (check(e) ?? []) as { academic_year_id: string }[]) counts.set(r.academic_year_id, (counts.get(r.academic_year_id) ?? 0) + 1);
  return { items: (check(y) as unknown as Y[]).map((r) => ({ id: r.id, name: r.name, start_date: r.start_date, end_date: r.end_date, working_days: r.working_days, students: counts.get(r.id) ?? 0, status: status(r) })) };
}

const body = z.object({ name: z.string().trim().min(4, "Enter the year, like 2027-28.").max(50), start_date: date, end_date: date, working_days: z.number().int().min(1).max(366).nullable().optional() }).strict();
const check2 = (b: { start_date: string; end_date: string }) => { if (b.end_date <= b.start_date) throw new HttpError(400, "The year must end after it starts."); };

export async function createYear(inst: string, input: unknown) {
  const i = body.parse(input);
  check2(i);
  const dup = check(await supabaseAdmin.from("academic_years").select("id").eq("institution_id", inst).eq("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "A year with that name already exists.");
  return check(await supabaseAdmin.from("academic_years").insert({ institution_id: inst, name: i.name, start_date: i.start_date, end_date: i.end_date, working_days: i.working_days ?? null, is_current: false, is_locked: false }).select("id").single());
}

async function one(inst: string, id: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, is_current, is_locked, working_days").eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as Y | null;
  if (!y) throw new HttpError(404, "Academic year not found.");
  return y;
}

export async function updateYear(inst: string, id: string, input: unknown) {
  const y = await one(inst, id);
  if (y.is_locked) throw new HttpError(409, "A closed year can't be edited.");
  const i = body.parse(input);
  check2(i);
  const dup = check(await supabaseAdmin.from("academic_years").select("id").eq("institution_id", inst).eq("name", i.name).neq("id", id)) as unknown[];
  if (dup.length) throw new HttpError(409, "A year with that name already exists.");
  check(await supabaseAdmin.from("academic_years").update({ name: i.name, start_date: i.start_date, end_date: i.end_date, working_days: i.working_days ?? null }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export async function activateYear(inst: string, id: string) {
  const y = await one(inst, id);
  if (y.is_current) return { ok: true };
  if (y.is_locked) throw new HttpError(409, "A closed year can't be activated again.");
  check(await supabaseAdmin.from("academic_years").update({ is_current: false }).eq("institution_id", inst).eq("is_current", true).select("id"));
  check(await supabaseAdmin.from("academic_years").update({ is_current: true }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export async function closeYear(inst: string, id: string) {
  const y = await one(inst, id);
  if (!y.is_current) throw new HttpError(409, "Only the active year can be closed.");
  check(await supabaseAdmin.from("academic_years").update({ is_current: false, is_locked: true }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ boards ═════════════
const BOARDS = ["CBSE", "ICSE", "State Board", "Other Board"] as const;
const INFO: Record<string, { grading: string; exams: string }> = {
  CBSE: { grading: "8-point (A1 – E) for 9 – 12; descriptive for 1 – 5", exams: "Board exams in Class 10 and 12" },
  ICSE: { grading: "Percentage", exams: "Board exams in Class 10 and 12" },
  "State Board": { grading: "Set by the state board", exams: "Board exams in Class 10" },
  "Other Board": { grading: "Set by board", exams: "Set by board" },
};

export async function listBoards(inst: string) {
  const [rows, i, g] = await Promise.all([
    supabaseAdmin.from("school_boards").select("board, in_use, loc_reminders").eq("institution_id", inst),
    supabaseAdmin.from("institutions").select("board, affiliation_number").eq("id", inst).maybeSingle(),
    supabaseAdmin.from("grades").select("name, sort_order").eq("institution_id", inst).order("sort_order"),
  ]);
  const saved = new Map(((check(rows) ?? []) as { board: string; in_use: boolean; loc_reminders: boolean }[]).map((r) => [r.board, r]));
  const school = check(i) as { board: string | null; affiliation_number: string | null } | null;
  const grades = (check(g) ?? []) as { name: string }[];
  const classes = grades.length ? `${grades[0].name} – ${grades[grades.length - 1].name}` : "";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  return {
    items: BOARDS.map((b) => {
      const r = saved.get(b);
      const own = !!school?.board && (norm(school.board) === norm(b) || (b === "State Board" && /state/i.test(school.board)));
      const inUse = r ? r.in_use : own;
      return { board: b, in_use: inUse, loc_reminders: r ? r.loc_reminders : false, classes: inUse ? classes : "", affiliation_no: own ? school?.affiliation_number ?? "" : "", ...INFO[b] };
    }),
  };
}

export async function saveBoard(inst: string, input: unknown) {
  const i = z.object({ board: z.enum(BOARDS), in_use: z.boolean(), loc_reminders: z.boolean() }).strict().parse(input);
  check(await supabaseAdmin.from("school_boards").upsert({ institution_id: inst, board: i.board, in_use: i.in_use, loc_reminders: i.in_use ? i.loc_reminders : false, updated_at: new Date().toISOString() }, { onConflict: "institution_id,board" }).select("id"));
  return listBoards(inst);
}
