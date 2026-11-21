import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** Surveys and feedback. Answers are collected in the Parent, Student and Teacher apps (not connected yet);
 *  this side builds surveys, schedules them and reads the results. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const KINDS = ["Rating 1 – 5", "Multiple choice", "Written answer"] as const;
const AUD = ["Students", "Parents", "Staff", "Students and parents"] as const;
export const SURVEY_TEMPLATES = [
  { key: "parent", name: "Parent satisfaction", audience: "Parents", kind: "Survey", questions: [["Overall, how happy are you with the school?", "Rating 1 – 5", ""], ["Communication from the school", "Rating 1 – 5", ""], ["Your child's academic progress", "Rating 1 – 5", ""], ["Safety and transport", "Rating 1 – 5", ""], ["Value for the fee", "Rating 1 – 5", ""], ["Would you recommend the school?", "Multiple choice", "Yes|Maybe|No"], ["What should we improve first?", "Written answer", ""]] },
  { key: "teacher", name: "Teacher feedback", audience: "Students", kind: "Teacher feedback", questions: [["Explains clearly", "Rating 1 – 5", ""], ["Pace of teaching is right", "Rating 1 – 5", ""], ["Answers my doubts", "Rating 1 – 5", ""], ["Fair in marking", "Rating 1 – 5", ""], ["Makes the class interesting", "Rating 1 – 5", ""]] },
  { key: "staff", name: "Staff wellbeing check-in", audience: "Staff", kind: "Survey", questions: [["How manageable is your workload?", "Rating 1 – 5", ""], ["Do you feel supported by your head of department?", "Rating 1 – 5", ""], ["What would make your work easier?", "Written answer", ""]] },
  { key: "blank", name: "Blank survey", audience: "Parents", kind: "Survey", questions: [["", "Written answer", ""]] },
];
async function eligible(inst: string, a: string) {
  const [r, s] = await Promise.all([roster(inst), supabaseAdmin.from("hr_staff").select("profile_id").eq("institution_id", inst).limit(5000)]);
  const n = r.items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled").length; const st = (check(s) as unknown[]).length;
  return a === "Staff" ? st : a === "Students and parents" ? n * 2 : n;
}
const status = (s: { scheduled: boolean; opens_on: string; closes_on: string }) => { const t = today(); return !s.scheduled ? "Draft" : t < s.opens_on ? "Scheduled" : t > s.closes_on ? "Closed" : "Open"; };
export async function surveys(inst: string) {
  const [s, r] = await Promise.all([supabaseAdmin.from("surveys").select("id, title, audience, opens_on, closes_on, anonymous, scheduled, kind").eq("institution_id", inst).order("opens_on", { ascending: false }), supabaseAdmin.from("survey_responses").select("survey_id, s:survey_id!inner(institution_id)").eq("s.institution_id", inst)]);
  const R = check(r) as unknown as { survey_id: string }[];
  const items = await Promise.all((check(s) as { id: string; title: string; audience: string; opens_on: string; closes_on: string; anonymous: boolean; scheduled: boolean; kind: string }[]).map(async (x) => { const e = await eligible(inst, x.audience); const a = R.filter((y) => y.survey_id === x.id).length; return { ...x, status: status(x), answers: a, eligible: e, pct: e ? Math.round((a / e) * 100) : 0 }; }));
  const tf = items.find((x) => x.kind === "Teacher feedback" && x.status !== "Draft"); const ps = items.find((x) => x.audience === "Parents" && x.status !== "Draft");
  return { items, templates: SURVEY_TEMPLATES, open: items.filter((x) => x.status === "Open").length, answers: items.reduce((n, x) => n + x.answers, 0), teacher: tf ? { pct: tf.pct, answers: tf.answers, eligible: tf.eligible } : null, parent: ps ? { pct: ps.pct, closes_on: ps.closes_on } : null };
}
export async function createSurvey(inst: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the title.").max(160), audience: z.enum(AUD), opens_on: date, closes_on: date, anonymous: z.boolean(), kind: z.enum(["Survey", "Teacher feedback"]).optional(), questions: z.array(z.object({ text: z.string().trim().min(2, "Every question needs wording.").max(200), kind: z.enum(KINDS), options: z.string().trim().max(300).optional() }).strict()).min(1, "Add at least one question.").max(40) }).strict().parse(input);
  if (i.closes_on < i.opens_on) throw new HttpError(400, "It must close on or after the day it opens.");
  for (const q of i.questions) if (q.kind === "Multiple choice" && (q.options ?? "").split("|").filter(Boolean).length < 2) throw new HttpError(400, "A multiple-choice question needs at least two options separated by |.");
  const s = check(await supabaseAdmin.from("surveys").insert({ institution_id: inst, title: i.title, audience: i.audience, opens_on: i.opens_on, closes_on: i.closes_on, anonymous: i.anonymous, kind: i.kind ?? "Survey" }).select("id").single()) as { id: string };
  check(await supabaseAdmin.from("survey_questions").insert(i.questions.map((q, k) => ({ survey_id: s.id, position: k + 1, text: q.text, kind: q.kind, options: q.options ?? "" }))).select("id")); return s;
}
export async function scheduleSurvey(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("surveys").update({ scheduled: true }).eq("id", id).eq("institution_id", inst).eq("scheduled", false).select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "Already scheduled."); return { ok: true };
}
export async function results(inst: string, id: string) {
  const s = check(await supabaseAdmin.from("surveys").select("id, title, audience, kind, anonymous").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; title: string; audience: string; kind: string; anonymous: boolean } | null; if (!s) throw new HttpError(404, "Not found.");
  const [q, r] = await Promise.all([supabaseAdmin.from("survey_questions").select("id, position, text, kind, options").eq("survey_id", id).order("position"), supabaseAdmin.from("survey_responses").select("id, group_label").eq("survey_id", id)]);
  const Q = check(q) as { id: string; position: number; text: string; kind: string; options: string }[]; const R = check(r) as { id: string; group_label: string }[]; const ids = R.map((x) => x.id);
  const A = ids.length ? (check(await supabaseAdmin.from("survey_answers").select("question_id, rating, choice, answer_text").in("response_id", ids)) as { question_id: string; rating: number | null; choice: string | null; answer_text: string | null }[]) : [];
  const groups = new Map<string, number>(); for (const x of R) if (x.group_label) groups.set(x.group_label, (groups.get(x.group_label) ?? 0) + 1);
  const e = await eligible(inst, s.audience);
  return { survey: s, answered: R.length, eligible: e, groups: [...groups.entries()] as [string, number][], questions: Q.map((x) => {
    const mine = A.filter((a) => a.question_id === x.id);
    if (x.kind === "Rating 1 – 5") { const rs = mine.filter((a) => a.rating); return { ...x, avg: rs.length ? Math.round((rs.reduce((n, a) => n + (a.rating ?? 0), 0) / rs.length) * 10) / 10 : null, dist: [5, 4, 3, 2, 1].map((k) => [`${k} ★`, rs.filter((a) => a.rating === k).length] as [string, number]) }; }
    if (x.kind === "Multiple choice") return { ...x, dist: x.options.split("|").filter(Boolean).map((o) => [o, mine.filter((a) => a.choice === o).length] as [string, number]) };
    return { ...x, written: mine.map((a) => a.answer_text).filter((t): t is string => !!t).slice(0, 10) };
  }) };
}
export async function teacherFeedback(inst: string) {
  const s = check(await supabaseAdmin.from("surveys").select("id").eq("institution_id", inst).eq("kind", "Teacher feedback")) as { id: string }[]; if (!s.length) return { items: [] };
  const r = check(await supabaseAdmin.from("survey_responses").select("id, teacher_name").in("survey_id", s.map((x) => x.id)).neq("teacher_name", "")) as { id: string; teacher_name: string }[]; if (!r.length) return { items: [] };
  const a = check(await supabaseAdmin.from("survey_answers").select("response_id, rating").in("response_id", r.map((x) => x.id)).not("rating", "is", null)) as { response_id: string; rating: number }[];
  const by = new Map<string, { n: number; sum: number; cnt: number }>(); for (const x of r) { const o = by.get(x.teacher_name) ?? { n: 0, sum: 0, cnt: 0 }; o.n++; for (const y of a.filter((z) => z.response_id === x.id)) { o.sum += y.rating; o.cnt++; } by.set(x.teacher_name, o); }
  return { items: [...by.entries()].map(([teacher, o]) => ({ teacher, responses: o.n, average: o.cnt ? Math.round((o.sum / o.cnt) * 10) / 10 : null })).sort((p, q) => (q.average ?? 0) - (p.average ?? 0)) };
}
