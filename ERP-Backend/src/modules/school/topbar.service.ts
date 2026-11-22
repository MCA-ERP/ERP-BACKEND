import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { safeSearch } from "../../lib/query";
import { listSchoolAnnouncements } from "../admin/communication.service";

/** The School Admin top bar: one search box and the bell. Everything is scoped to the caller's own school. */
export async function search(inst: string, raw: unknown, canStudents: boolean, canStaff: boolean) {
  const q = safeSearch(raw);
  if (q.length < 2) return { hits: [] };
  const like = `%${q}%`;
  const [stu, staff] = await Promise.all([
    canStudents
      ? supabaseAdmin.from("students").select("id, registration_no, first_name, last_name").eq("institution_id", inst).or(`first_name.ilike.${like},last_name.ilike.${like},registration_no.ilike.${like}`).limit(6)
      : Promise.resolve({ data: [], error: null }),
    canStaff
      ? supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, designation, roles:role_id(display_name)").eq("institution_id", inst).or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`).limit(6)
      : Promise.resolve({ data: [], error: null }),
  ]);
  type S = { id: string; registration_no: string | null; first_name: string | null; last_name: string | null };
  type P = { id: string; first_name: string | null; last_name: string | null; email: string | null; designation: string | null; roles: { display_name: string } | { display_name: string }[] | null };
  const name = (x: { first_name: string | null; last_name: string | null }) => [x.first_name, x.last_name].filter(Boolean).join(" ").trim();
  const hits = [
    ...(check(stu) as unknown as S[]).map((s) => ({ type: "student" as const, id: s.id, title: name(s) || s.registration_no || "Student", subtitle: s.registration_no ? `Admission no. ${s.registration_no}` : "Student" })),
    ...(check(staff) as unknown as P[]).map((p) => {
      const role = Array.isArray(p.roles) ? p.roles[0] : p.roles;
      return { type: "staff" as const, id: p.id, title: name(p) || p.email || "Staff", subtitle: [p.designation || role?.display_name, p.email].filter(Boolean).join(" · ") };
    }),
  ];
  return { hits };
}

interface Alert { key: string; severity: "critical" | "warning" | "info"; title: string; detail: string; count: number; href: string }

/** What needs the school's attention, worked out from live data so an item disappears once it is dealt with. */
export async function notifications(inst: string, admin: boolean) {
  const alerts: Alert[] = [];
  const [ann, staffLeave, studentLeave] = await Promise.all([
    listSchoolAnnouncements(inst).catch(() => [] as unknown[]),
    admin ? supabaseAdmin.from("leave_requests").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Pending") : Promise.resolve({ count: 0 }),
    admin ? supabaseAdmin.from("student_leaves").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Pending") : Promise.resolve({ count: 0 }),
  ]);
  const unread = (ann as { read?: boolean; title?: string }[]).filter((a) => !a.read);
  if (unread.length) alerts.push({ key: "announcements", severity: "info", title: unread.length === 1 ? "New announcement" : `${unread.length} new announcements`, detail: unread[0].title ?? "From the platform team", count: unread.length, href: "/school" });
  const sl = (staffLeave as { count: number | null }).count ?? 0;
  if (sl) alerts.push({ key: "staff-leave", severity: "warning", title: `${sl} staff leave ${sl === 1 ? "request" : "requests"} waiting`, detail: "Approve or send back", count: sl, href: "/school/hr/leave-management" });
  const stl = (studentLeave as { count: number | null }).count ?? 0;
  if (stl) alerts.push({ key: "student-leave", severity: "warning", title: `${stl} student leave ${stl === 1 ? "request" : "requests"} waiting`, detail: "Approve or reject", count: stl, href: "/school/attendance/leave-management" });
  return { alerts, total: alerts.reduce((n, a) => n + a.count, 0) };
}
