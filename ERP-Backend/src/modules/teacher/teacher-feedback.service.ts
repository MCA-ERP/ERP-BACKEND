import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { istDate, whoAmI } from "./teacher.service";

/** Student feedback about the signed-in teacher (averages and approved comments only) and the surveys the school sent to staff. */
const MIN_ANSWERS = 5; // below this, averages could point at one child, so nothing is shown
const r1 = (n: number) => Math.round(n * 10) / 10;

export async function studentFeedback(inst: string, me: string) {
  const who = await whoAmI(inst, me);
  const surveys = (check(await supabaseAdmin.from("surveys").select("id, title, audience, closes_on").eq("institution_id", inst).eq("kind", "Teacher feedback").order("closes_on", { ascending: false }).limit(10)) ?? []) as { id: string; title: string; audience: string; closes_on: string }[];
  for (const s of surveys) {
    const mine = (check(await supabaseAdmin.from("survey_responses").select("id, group_label, teacher_id, teacher_name").eq("survey_id", s.id).limit(20000)) ?? []) as { id: string; group_label: string; teacher_id: string | null; teacher_name: string }[];
    const about = mine.filter((r) => r.teacher_id === me || (r.teacher_id === null && r.teacher_name.trim().toLowerCase() === who.name.trim().toLowerCase()));
    if (!about.length) continue;
    const [qs, ans] = await Promise.all([
      supabaseAdmin.from("survey_questions").select("id, position, text, kind").eq("survey_id", s.id).order("position"),
      supabaseAdmin.from("survey_answers").select("response_id, question_id, rating, answer_text, moderated").in("response_id", mine.map((r) => r.id)).limit(200000),
    ]);
    const Q = (check(qs) ?? []) as { id: string; position: number; text: string; kind: string }[];
    const A = (check(ans) ?? []) as { response_id: string; question_id: string; rating: number | null; answer_text: string | null; moderated: boolean }[];
    const mineIds = new Set(about.map((r) => r.id));
    const avg = (rows: { rating: number | null }[]) => { const v = rows.map((x) => x.rating).filter((x): x is number => !!x); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const base = { survey: { title: s.title, closes_on: s.closes_on }, answers: about.length };
    if (about.length < MIN_ANSWERS) return { ...base, enough: false, min: MIN_ANSWERS, overall: null, school_average: null, groups: [] as string[], scores: [] as unknown[], strongest: null, to_work_on: null, comments: [] as string[] };
    const rated = Q.filter((q) => q.kind === "Rating 1 – 5");
    const scores = rated.map((q) => { const mineA = A.filter((a) => a.question_id === q.id && mineIds.has(a.response_id)); const all = A.filter((a) => a.question_id === q.id); return { text: q.text, average: avg(mineA) === null ? null : r1(avg(mineA) as number), school: avg(all) === null ? null : r1(avg(all) as number) }; }).filter((x) => x.average !== null) as { text: string; average: number; school: number | null }[];
    const overall = scores.length ? r1(scores.reduce((a, x) => a + x.average, 0) / scores.length) : null;
    const sa = scores.filter((x) => x.school !== null);
    const sorted = [...scores].sort((a, b) => b.average - a.average);
    return {
      ...base, enough: true, min: MIN_ANSWERS, overall, school_average: sa.length ? r1(sa.reduce((a, x) => a + (x.school as number), 0) / sa.length) : null,
      groups: [...new Set(about.map((r) => r.group_label).filter(Boolean))].sort(), scores,
      strongest: sorted[0] ?? null, to_work_on: sorted.length > 1 ? sorted[sorted.length - 1] : null,
      comments: A.filter((a) => mineIds.has(a.response_id) && a.moderated && a.answer_text).map((a) => a.answer_text as string).slice(0, 20),
    };
  }
  return { survey: null, answers: 0, enough: false, min: MIN_ANSWERS, overall: null, school_average: null, groups: [] as string[], scores: [] as unknown[], strongest: null, to_work_on: null, comments: [] as string[] };
}

export async function staffSurveys(inst: string, me: string) {
  const today = istDate();
  const [rows, done] = await Promise.all([
    supabaseAdmin.from("surveys").select("id, title, closes_on, opens_on, anonymous").eq("institution_id", inst).eq("audience", "Staff").eq("kind", "Survey").eq("scheduled", true).lte("opens_on", today).order("closes_on", { ascending: false }).limit(50),
    supabaseAdmin.from("survey_participation").select("survey_id").eq("profile_id", me).limit(500),
  ]);
  const D = new Set(((check(done) ?? []) as { survey_id: string }[]).map((d) => d.survey_id));
  return { items: ((check(rows) ?? []) as { id: string; title: string; closes_on: string; anonymous: boolean }[]).map((s) => ({ id: s.id, title: s.title, closes_on: s.closes_on, anonymous: s.anonymous, state: D.has(s.id) ? "Answered" : s.closes_on < today ? "Closed" : "Open" })) };
}

async function openSurvey(inst: string, me: string, id: string) {
  const s = check(await supabaseAdmin.from("surveys").select("id, title, anonymous, closes_on, opens_on").eq("id", z.string().uuid().parse(id)).eq("institution_id", inst).eq("audience", "Staff").eq("kind", "Survey").eq("scheduled", true).maybeSingle()) as { id: string; title: string; anonymous: boolean; closes_on: string; opens_on: string } | null;
  if (!s) throw new HttpError(404, "Survey not found.");
  const today = istDate();
  if (s.opens_on > today || s.closes_on < today) throw new HttpError(409, "This survey is not open.");
  if (check(await supabaseAdmin.from("survey_participation").select("survey_id").eq("survey_id", id).eq("profile_id", me).maybeSingle())) throw new HttpError(409, "You have already answered this survey.");
  return s;
}

export async function surveyForm(inst: string, me: string, id: string) {
  const s = await openSurvey(inst, me, id);
  const q = (check(await supabaseAdmin.from("survey_questions").select("id, position, text, kind, options").eq("survey_id", id).order("position")) ?? []) as { id: string; position: number; text: string; kind: string; options: string }[];
  return { id: s.id, title: s.title, anonymous: s.anonymous, closes_on: s.closes_on, questions: q.map((x) => ({ id: x.id, text: x.text, kind: x.kind, options: x.options.split("|").filter(Boolean) })) };
}

export async function answerSurvey(inst: string, me: string, id: string, input: unknown) {
  const i = z.object({ answers: z.array(z.object({ question_id: z.string().uuid(), rating: z.number().int().min(1).max(5).optional(), choice: z.string().trim().max(80).optional(), text: z.string().trim().max(1000).optional() }).strict()).min(1).max(60) }).strict().parse(input);
  const s = await openSurvey(inst, me, id);
  const q = (check(await supabaseAdmin.from("survey_questions").select("id, kind, options").eq("survey_id", id)) ?? []) as { id: string; kind: string; options: string }[];
  const Q = new Map(q.map((x) => [x.id, x]));
  const rows = i.answers.map((a) => {
    const d = Q.get(a.question_id);
    if (!d) throw new HttpError(400, "One of the questions is not part of this survey.");
    if (d.kind === "Rating 1 – 5" && !a.rating) throw new HttpError(400, "Rate every question.");
    if (d.kind === "Multiple choice" && (!a.choice || !d.options.split("|").includes(a.choice))) throw new HttpError(400, "Choose one of the options.");
    return { question_id: a.question_id, rating: d.kind === "Rating 1 – 5" ? a.rating : null, choice: d.kind === "Multiple choice" ? a.choice : null, answer_text: d.kind === "Written answer" ? a.text || null : null };
  });
  // the participation row is written first: it is what stops a second answer
  check(await supabaseAdmin.from("survey_participation").insert({ survey_id: id, profile_id: me }).select("survey_id"));
  const r = check(await supabaseAdmin.from("survey_responses").insert({ survey_id: id, group_label: "Staff", respondent_id: s.anonymous ? null : me }).select("id").single()) as { id: string };
  check(await supabaseAdmin.from("survey_answers").insert(rows.map((x) => ({ ...x, response_id: r.id }))).select("response_id"));
  return { ok: true };
}
