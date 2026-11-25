/** Who may give which role when registering staff for a school. */

/** Logins HR and the Vice Principal may create. Admin, Principal, Vice Principal, HR, Accountant and school-defined
 *  roles are left to the School Admin or Principal, so nobody can make themselves an approver's or a senior login. */
export const HR_MAY_CREATE = ["Faculty", "ClassTeacher", "Librarian", "Receptionist", "SchoolNurse", "Counsellor", "TransportManager", "MessManager", "StoreIncharge", "ExamCoordinator", "Registrar", "AdmissionsHead", "FrontOfficeSecurity"];

/** Accounts that are never created through staff registration. */
const NOT_STAFF = ["SuperAdmin", "Student", "Parent", "Applicant"];
/** Roles above the Principal. */
const ABOVE_PRINCIPAL = ["InstitutionAdmin", "Chairman"];

/** `schoolRoles` are the role names that belong to this school (school scope only, never a platform role). */
export function mayCreate(actor: string, role: string, schoolRoles: readonly string[]): boolean {
  if (NOT_STAFF.includes(role) || !schoolRoles.includes(role)) return false;
  if (actor === "InstitutionAdmin" || actor === "SuperAdmin") return true;
  if (actor === "Principal") return !ABOVE_PRINCIPAL.includes(role);
  if (actor === "VicePrincipal" || actor === "HR") return HR_MAY_CREATE.includes(role);
  return false;
}

/** Staff accounts the Vice Principal may turn on or off. */
const VP_MAY_MANAGE = [...HR_MAY_CREATE, "HOD", "Driver", "CanteenOperator"];

/** Whether the signed-in person may turn an account with this role on or off. */
export function mayManage(actor: string, role: string): boolean {
  if (actor === "InstitutionAdmin" || actor === "SuperAdmin") return true;
  if (actor === "Principal") return !ABOVE_PRINCIPAL.includes(role);
  if (actor === "VicePrincipal") return VP_MAY_MANAGE.includes(role);
  return false;
}
