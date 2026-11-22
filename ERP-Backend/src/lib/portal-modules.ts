import type { NextFunction, Request, Response } from "express";

/** Which catalogue modules (Super Admin › Module Management) a school needs for each part of the School portal.
 *  A part is available when the school has ANY of the listed modules. Parts not listed are always available. */
export const PREFIX_MODULES: Record<string, string[]> = {
  "/hr": ["hr_payroll"], "/pay": ["payroll", "hr_payroll"], "/inv": ["inventory"], "/comm": ["sms_whatsapp", "email", "notifications", "whatsapp", "school_diary", "helpdesk", "surveys", "photo_gallery", "chat", "ai_chatbot"],
  "/hostel": ["hostel", "cafeteria"], "/tr": ["transport"], "/lib": ["library"], "/front-office": ["admissions", "online_admissions", "visitors"], "/health": ["health_welfare"], "/cert": ["certificates"], "/act": ["activities_events", "house_points"],
  "/visitors": ["visitors"], "/attendance": ["attendance"], "/timetable": ["timetable"], "/exams": ["exams"], "/lms": ["homework", "online_classes"], "/fees": ["fees"], "/students-mgmt": ["student_information"], "/parents-mgmt": ["parent_app"], "/competitive": ["competitive_prep"], "/assist": ["school_assistant"],
};
/** The same rule for the sidebar, by menu module key. */
export const MENU_MODULES: Record<string, string[]> = {
  "front-office": ["admissions", "online_admissions", "visitors"], admission: ["admissions", "online_admissions"], students: ["student_information"], parents: ["parent_app"], academics: ["academics", "student_information"], attendance: ["attendance"], timetable: ["timetable"], examinations: ["exams"], lms: ["homework", "online_classes"],
  fees: ["fees"], hr: ["hr_payroll"], payroll: ["payroll", "hr_payroll"], transport: ["transport"], library: ["library"], inventory: ["inventory"], communication: PREFIX_MODULES["/comm"], hostel: ["hostel", "cafeteria"], visitors: ["visitors"], health: ["health_welfare"], certificates: ["certificates"], activities: ["activities_events", "house_points"],
};

export function moduleGate(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user || user.role === "SuperAdmin") return next();
  const need = PREFIX_MODULES[`/${req.path.split("/")[1] ?? ""}`];
  if (!need) return next();
  const have = user.modules ?? [];
  if (need.some((m) => have.includes(m))) return next();
  res.status(403).json({ error: "Your school's plan does not include this feature. Ask your administrator to upgrade or add the module.", code: "MODULE_NOT_IN_PLAN" });
}
