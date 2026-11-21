import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";

/** Basic data every new school starts with: classes (pre-primary to 12), subjects for each class, school-day periods and role menus. Safe to run again: it only adds what is missing. */
const GRADES: [string, string, number, string][] = [["NUR", "Nursery", 1, "Pre-primary"], ["LKG", "LKG", 2, "Pre-primary"], ["UKG", "UKG", 3, "Pre-primary"], ...Array.from({ length: 12 }, (_, i): [string, string, number, string] => [`G${i + 1}`, `Class ${i + 1}`, i + 4, i < 5 ? "Primary" : i < 8 ? "Middle" : i < 10 ? "Secondary" : "Senior secondary"])];
const SUBJECTS: [string, string, string, string][] = [["TEL", "Telugu", "Language", "Theory"], ["HIN", "Hindi", "Language", "Theory"], ["ENG", "English", "Language", "Theory"], ["MAT", "Mathematics", "Core", "Theory"], ["SCI", "Science", "Core", "Theory + practical"], ["SOC", "Social Studies", "Core", "Theory"], ["EVS", "EVS", "Core", "Theory"], ["COM", "Computer Science", "Skill", "Theory + practical"], ["GK", "General Knowledge", "Co-scholastic", "Theory"], ["PHY", "Physics", "Science", "Theory + practical"], ["CHE", "Chemistry", "Science", "Theory + practical"], ["BIO", "Biology", "Science", "Theory + practical"], ["PE", "Physical Education", "Co-scholastic", "Theory"], ["ART", "Art", "Co-scholastic", "Theory"]];
const forGrade = (n: number): string[] => (n <= 3 ? ["ENG", "TEL", "MAT", "EVS", "GK", "ART"] : n <= 8 ? ["TEL", "HIN", "ENG", "MAT", "EVS", "COM", "GK", "PE", "ART"] : n <= 13 ? ["TEL", "HIN", "ENG", "MAT", "SCI", "SOC", "COM", "GK", "PE", "ART"] : ["ENG", "MAT", "PHY", "CHE", "BIO", "COM", "PE"]);
const PERIODS: [string, string, string, string][] = [["P1", "08:20", "09:00", "Teaching"], ["P2", "09:00", "09:40", "Teaching"], ["Break", "09:40", "09:55", "Break"], ["P3", "09:55", "10:35", "Teaching"], ["P4", "10:35", "11:15", "Teaching"], ["P5", "11:15", "11:55", "Teaching"], ["Lunch", "11:55", "12:35", "Break"], ["P6", "12:35", "13:15", "Teaching"], ["P7", "13:15", "13:55", "Teaching"], ["P8", "13:55", "14:35", "Teaching"]];
export const DEFAULT_ROLE_MENU: Record<string, string[]> = { "School Admin": [], Principal: ["dashboard", "profile", "mywork", "front-office", "admission", "students", "parents", "academics", "attendance", "timetable", "examinations", "lms", "fees", "hr", "payroll", "transport", "library", "inventory", "communication", "hostel", "visitors", "health", "certificates", "activities", "reports"], Accountant: ["dashboard", "fees", "payroll", "reports"], Receptionist: ["dashboard", "front-office", "admission", "visitors"], Teacher: ["dashboard", "students", "attendance", "timetable", "examinations", "lms", "communication", "health"], Librarian: ["dashboard", "library"], "Transport Manager": ["dashboard", "transport"] };

export async function seedSchoolDefaults(inst: string) {
  const added = { classes: 0, subjects: 0, links: 0, periods: 0, role_menu: false };
  const ex = check(await supabaseAdmin.from("grades").select("code, name").eq("institution_id", inst)) as { code: string; name: string }[]; const gHave = new Set(ex.flatMap((x) => [x.code, ...GRADES.filter((g) => g[1].toLowerCase() === x.name.toLowerCase()).map((g) => g[0])]));
  const newG = GRADES.filter((g) => !gHave.has(g[0]));
  if (newG.length) { check(await supabaseAdmin.from("grades").insert(newG.map(([code, name, sort_order, stage]) => ({ institution_id: inst, code, name, sort_order, stage }))).select("id")); added.classes = newG.length; }
  const sHave = new Set((check(await supabaseAdmin.from("subjects").select("code").eq("institution_id", inst)) as { code: string }[]).map((x) => x.code));
  const newS = SUBJECTS.filter((s) => !sHave.has(s[0]));
  if (newS.length) { check(await supabaseAdmin.from("subjects").insert(newS.map(([code, name, category, subject_type]) => ({ institution_id: inst, code, name, category, subject_type }))).select("id")); added.subjects = newS.length; }
  const grades = check(await supabaseAdmin.from("grades").select("id, code").eq("institution_id", inst)) as { id: string; code: string }[]; const subs = check(await supabaseAdmin.from("subjects").select("id, code").eq("institution_id", inst)) as { id: string; code: string }[];
  const links = check(await supabaseAdmin.from("grade_subjects").select("grade_id, subject_id").in("grade_id", grades.map((g) => g.id))) as { grade_id: string; subject_id: string }[];
  const filled = new Set(links.map((l) => l.grade_id)); // only classes with no subjects yet, so a school's own choices are never undone
  const fresh = grades.filter((g) => !filled.has(g.id)).flatMap((g) => { const n = GRADES.find((x) => x[0] === g.code)?.[2]; return n ? forGrade(n).map((c) => ({ grade_id: g.id, subject_id: subs.find((s) => s.code === c)?.id })).filter((x): x is { grade_id: string; subject_id: string } => !!x.subject_id) : []; });
  if (fresh.length) { check(await supabaseAdmin.from("grade_subjects").insert(fresh).select("grade_id")); added.links = fresh.length; }
  const pHave = check(await supabaseAdmin.from("tt_periods").select("id").eq("institution_id", inst).limit(1)) as unknown[];
  if (!pHave.length) { check(await supabaseAdmin.from("tt_periods").insert(PERIODS.map(([label, starts, ends, kind]) => ({ institution_id: inst, label, starts, ends, kind }))).select("id")); added.periods = PERIODS.length; }
  const rm = check(await supabaseAdmin.from("school_settings").select("key").eq("institution_id", inst).eq("key", "role_menu").maybeSingle());
  if (!rm) { check(await supabaseAdmin.from("school_settings").insert({ institution_id: inst, key: "role_menu", value: DEFAULT_ROLE_MENU }).select("key")); added.role_menu = true; }
  return added;
}
