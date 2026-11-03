export interface TimetableSlot {
  day: string;
  time: string;
  subject: string;
  code: string;
  room: string;
  faculty: string;
}

/**
 * Weekly timetable. Returns no slots until the timetable module is built
 * (planned: periods, rooms and teacher assignments with clash detection).
 */
export function getWeeklyTimetable(): TimetableSlot[] {
  return [];
}
