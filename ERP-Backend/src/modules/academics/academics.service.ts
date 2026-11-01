import { supabaseAdmin } from "../../../db/client";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────
export interface TimetableSlot {
  day: string;
  time: string;
  subject: string;
  code: string;
  room: string;
  faculty: string;
}

// ─────────────────────────────────────────────
//  Service Methods
// ─────────────────────────────────────────────

/**
 * Fetch department list with programs. Falls back to demo data.
 */
export async function listDepartments() {
  const { data: departments, error } = await supabaseAdmin
    .from("departments")
    .select("*, programs(*)")
    .order("name", { ascending: true });

  if (error || !departments?.length) {
    return [
      { code: "CSE", name: "Computer Science & Engineering", programs: [{ code: "BTECH-CSE", name: "B.Tech Computer Science", duration_years: 4 }] },
      { code: "ECE", name: "Electronics & Communication Engineering", programs: [{ code: "BTECH-ECE", name: "B.Tech Electronics & Comm", duration_years: 4 }] },
      { code: "MECH", name: "Mechanical Engineering", programs: [{ code: "BTECH-MECH", name: "B.Tech Mechanical", duration_years: 4 }] },
      { code: "MGMT", name: "School of Management Studies", programs: [{ code: "MBA-GEN", name: "Master of Business Administration", duration_years: 2 }] },
    ];
  }

  return departments;
}

/**
 * Return the weekly master timetable slots.
 * In a production system, this would be fetched from a timetable_slots table.
 */
export function getWeeklyTimetable(): TimetableSlot[] {
  return [
    { day: "Monday",    time: "09:00 - 10:00", subject: "Data Structures & Algorithms",       code: "CS201",  room: "Lab 3",          faculty: "Dr. K. Raman" },
    { day: "Monday",    time: "10:15 - 11:15", subject: "Operating Systems",                  code: "CS204",  room: "Room 402",        faculty: "Prof. S. Iyer" },
    { day: "Monday",    time: "11:30 - 12:30", subject: "Discrete Mathematics",               code: "MA201",  room: "Hall B",          faculty: "Dr. A. Mehra" },
    { day: "Monday",    time: "01:30 - 03:30", subject: "Database Systems Lab",               code: "CS208P", room: "Software Lab 1",  faculty: "Dr. K. Raman" },
    { day: "Tuesday",   time: "09:00 - 10:00", subject: "Computer Networks",                  code: "CS205",  room: "Room 402",        faculty: "Prof. N. Sen" },
    { day: "Tuesday",   time: "10:15 - 11:15", subject: "Data Structures & Algorithms",       code: "CS201",  room: "Room 402",        faculty: "Dr. K. Raman" },
    { day: "Tuesday",   time: "11:30 - 12:30", subject: "Software Engineering",               code: "CS209",  room: "Room 402",        faculty: "Prof. V. Sharma" },
    { day: "Wednesday", time: "09:00 - 10:00", subject: "Discrete Mathematics",               code: "MA201",  room: "Hall B",          faculty: "Dr. A. Mehra" },
    { day: "Wednesday", time: "10:15 - 11:15", subject: "Operating Systems",                  code: "CS204",  room: "Room 402",        faculty: "Prof. S. Iyer" },
    { day: "Wednesday", time: "01:30 - 03:30", subject: "Operating Systems Lab",              code: "CS204P", room: "Systems Lab",     faculty: "Prof. S. Iyer" },
    { day: "Thursday",  time: "09:00 - 10:00", subject: "Computer Networks",                  code: "CS205",  room: "Room 402",        faculty: "Prof. N. Sen" },
    { day: "Thursday",  time: "10:15 - 11:15", subject: "Database Management Systems",        code: "CS208",  room: "Room 402",        faculty: "Dr. P. Nair" },
    { day: "Thursday",  time: "11:30 - 12:30", subject: "Software Engineering",               code: "CS209",  room: "Room 402",        faculty: "Prof. V. Sharma" },
    { day: "Friday",    time: "09:00 - 10:00", subject: "Database Management Systems",        code: "CS208",  room: "Room 402",        faculty: "Dr. P. Nair" },
    { day: "Friday",    time: "10:15 - 11:15", subject: "Data Structures & Algorithms",       code: "CS201",  room: "Room 402",        faculty: "Dr. K. Raman" },
    { day: "Friday",    time: "11:30 - 12:30", subject: "Open Elective: Technical Writing",   code: "OE201",  room: "Seminar Hall",    faculty: "Prof. M. Joshi" },
  ];
}
