import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requirePermission, requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as svc from "./school.service";
import * as dash from "./dashboard.service";
import * as fo from "./front-office.service";
import * as sm2 from "./student-mgmt.service";
import * as sx from "./student-extra.service";
import * as pr from "./parent.service";
import * as px from "./parent-extra.service";
import * as ac from "./academic.service";
import * as a2 from "./academic2.service";
import * as at from "./attendance.service";
import * as a2s from "./attendance2.service";
import * as a3 from "./attendance3.service";
import * as tt from "./timetable.service";
import * as adm2 from "./admission-extra.service";
import * as leaveSvc from "./leave.service";
import { schoolChat } from "./school-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";
import * as profileSvc from "./profile.service";
import * as support from "../admin/support.service";
import { listSchoolAnnouncements, markAnnouncementRead } from "../admin/communication.service";
import { actorName } from "../../lib/actor";
import * as billing from "../billing/billing.service";
import * as subsvc from "../admin/subscriptions.service";
import * as modcfg from "../admin/module-config.service";
import * as sm from "../admin/support-mgmt.service";
import * as svc2 from "../admin/schools.service";

export const schoolRouter = Router();

// Everything here is the school's own setup data; SuperAdmin must say which school via ?institution_id=
schoolRouter.use(authGuard);

const manage = requirePermission("academics.setup.manage");
const view = requirePermission("sis.student.view");

type Handler = (req: Request, res: Response, inst: string) => Promise<unknown>;
const h =
  (fn: Handler) =>
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const inst = requireInstitutionId(req, typeof req.query.institution_id === "string" ? req.query.institution_id : undefined);
      res.json(await fn(req, res, inst));
    } catch (err) {
      sendError(res, err, "Request failed");
    }
  };

const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD.");

const yearSchema = z.object({
  name: z.string().trim().min(3, "Enter a name like 2026-2027.").max(50),
  start_date: date,
  end_date: date,
  is_current: z.boolean().optional(),
});
const gradeSchema = z.object({
  code: z.string().trim().min(1).max(20).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(100),
  sort_order: z.number().int().optional(),
});
const sectionSchema = z.object({
  grade_id: z.string().uuid(),
  academic_year_id: z.string().uuid(),
  name: z.string().trim().min(1).max(50),
  capacity: z.number().int().min(1).max(500).optional(),
});
const subjectSchema = z.object({
  code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(150),
});

// ── dashboard ──
const q = (req: Request, k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
schoolRouter.get("/dashboard/overview", view, h((req, _res, inst) => dash.overview(inst, q(req, "year"))));
schoolRouter.get("/dashboard/students", view, h((req, _res, inst) => dash.studentStats(inst, { year: q(req, "year"), tab: q(req, "tab"), search: q(req, "search"), grade: q(req, "grade"), gender: q(req, "gender") })));
schoolRouter.get("/dashboard/staff", view, h((req, _res, inst) => dash.staffStats(inst, { tab: q(req, "tab"), search: q(req, "search"), type: q(req, "type") })));
schoolRouter.get("/dashboard/attendance", view, h((req, _res, inst) => dash.attendanceOverview(inst, q(req, "year"))));
schoolRouter.get("/dashboard/admissions", view, h((req, _res, inst) => dash.admissionOverview(inst, q(req, "year"))));
schoolRouter.get("/dashboard/academics", view, h((req, _res, inst) => dash.academicOverview(inst, q(req, "year"))));
schoolRouter.get("/dashboard/activity", view, h((req, _res, inst) => dash.recentActivity(inst, { tab: q(req, "tab"), search: q(req, "search") })));

// ── front office (reception, front-desk and school leadership roles) ──
const desk = requireRoles("InstitutionAdmin", "Principal", "VicePrincipal", "Receptionist", "FrontOfficeSecurity", "AdmissionsHead", "Registrar");
const reg = (req: Request) => String(req.params.register);
schoolRouter.get("/front-office/staff", desk, h((_req, _res, inst) => fo.staffChoices(inst).then((items) => ({ items }))));
schoolRouter.get("/front-office/:register", desk, h((req, _res, inst) => fo.list(inst, reg(req), req.query as Record<string, string | undefined>)));
schoolRouter.post("/front-office/:register", desk, h(async (req, res, inst) => { res.status(201); return { item: await fo.create(inst, reg(req), req.body, req.user?.profileId) }; }));
schoolRouter.get("/front-office/help-desk/categories", desk, h(async (_req, _res, inst) => ({ items: await fo.categories(inst) })));
schoolRouter.patch("/front-office/help-desk/categories/:name", desk, h(async (req, _res, inst) => ({ item: await fo.setReplyHours(inst, String(req.params.name), req.body) })));
schoolRouter.post("/front-office/adm-enquiries/:id/convert", desk, h(async (req, res, inst) => { res.status(201); return { item: await fo.convertEnquiry(inst, uuid(req), req.user?.profileId) }; }));
schoolRouter.get("/front-office/admission/fee-setup", desk, h(async (_req, _res, inst) => fo.feeSetup(inst)));
schoolRouter.put("/front-office/admission/fee-setup", desk, h(async (req, _res, inst) => fo.saveFeeSetup(inst, req.body)));
schoolRouter.get("/front-office/admission/levels", desk, h(async (_req, _res, inst) => ({ items: await fo.approvalLevels(inst) })));
schoolRouter.post("/front-office/admission/fee-collect", desk, h(async (req, res, inst) => { res.status(201); return { item: await fo.collectAdmissionFee(inst, req.body, req.user?.profileId) }; }));
schoolRouter.post("/front-office/adm-applications/:id/advance", desk, h(async (req, _res, inst) => ({ item: await fo.advance(inst, uuid(req), req.body) })));
schoolRouter.post("/front-office/adm-applications/:id/admission-number", desk, h(async (req, _res, inst) => ({ item: await fo.generateAdmissionNumber(inst, uuid(req)) })));
schoolRouter.post("/front-office/adm-applications/:id/allocate", desk, h(async (req, _res, inst) => ({ item: await fo.allocate(inst, uuid(req), req.body) })));
schoolRouter.get("/front-office/admission/programmes", desk, h(async (_req, _res, inst) => ({ items: await adm2.programmes(inst) })));
schoolRouter.put("/front-office/admission/programmes", desk, h(async (req, _res, inst) => ({ items: await adm2.saveProgrammes(inst, req.body) })));
schoolRouter.get("/front-office/admission/merit", desk, h(async (req, _res, inst) => adm2.meritList(inst, typeof req.query.programme === "string" ? req.query.programme : undefined)));
schoolRouter.get("/front-office/admission/seat-matrix", desk, h(async (_req, _res, inst) => ({ items: await adm2.seatMatrix(inst) })));
schoolRouter.get("/front-office/admission/offers", desk, h(async (_req, _res, inst) => ({ items: await adm2.offers(inst) })));
schoolRouter.patch("/front-office/admission/offers/:id", desk, h(async (req, _res, inst) => ({ item: await adm2.setOfferStatus(inst, uuid(req), req.body) })));
schoolRouter.post("/front-office/admission/release-expired", desk, h(async (_req, _res, inst) => adm2.releaseExpired(inst)));
schoolRouter.get("/front-office/admission/settings", desk, h(async (_req, _res, inst) => adm2.settings(inst)));
schoolRouter.put("/front-office/admission/settings", desk, h(async (req, _res, inst) => adm2.saveSettings(inst, req.body)));
schoolRouter.get("/front-office/adm-tests/:id/marks", desk, h(async (req, _res, inst) => fo.testMarks(inst, uuid(req))));
schoolRouter.put("/front-office/adm-tests/:id/marks", desk, h(async (req, _res, inst) => fo.saveMarks(inst, uuid(req), req.body)));
schoolRouter.patch("/front-office/:register/:id", desk, h(async (req, _res, inst) => ({ item: await fo.patch(inst, reg(req), uuid(req), req.body, req.user?.profileId) })));
schoolRouter.get("/front-office/enquiries/:id/followups", desk, h(async (req, _res, inst) => ({ items: await fo.followups(inst, uuid(req)) })));
schoolRouter.post("/front-office/enquiries/:id/followups", desk, h(async (req, res, inst) => { res.status(201); return { item: await fo.logFollowup(inst, uuid(req), req.body, req.user?.profileId) }; }));

// ── my leave (any staff member, about themselves only) ──
schoolRouter.get("/me/leave", h(async (req, _res, inst) => leaveSvc.myLeave(inst, me(req))));
schoolRouter.post("/me/leave", h(async (req, res, inst) => { res.status(201); return { item: await leaveSvc.apply(inst, me(req), req.body) }; }));
schoolRouter.get("/me/comp-offs", h(async (req) => ({ items: await leaveSvc.compOffs(me(req)) })));

// ── student management ──
const staffDesk = requireRoles("InstitutionAdmin", "Principal", "VicePrincipal", "Registrar", "AdmissionsHead", "ClassTeacher", "ExamCoordinator");
const stu = "/students-mgmt";
schoolRouter.get(stu + "/roster", view, h((_req, _res, inst) => sm2.roster(inst)));
schoolRouter.get(stu + "/documents", view, h(async (req, _res, inst) => ({ items: await sm2.documents(inst, typeof req.query.type === "string" ? req.query.type : undefined) })));
schoolRouter.post(stu + "/documents", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await sm2.addDocument(inst, req.body) }; }));
schoolRouter.patch(stu + "/documents/:id", staffDesk, h(async (req, _res, inst) => ({ item: await sm2.setDocumentStatus(inst, uuid(req), req.body) })));
schoolRouter.get(stu + "/id/settings", view, h((_req, _res, inst) => sm2.idSettings(inst)));
schoolRouter.put(stu + "/id/settings", staffDesk, h((req, _res, inst) => sm2.saveIdSettings(inst, req.body)));
schoolRouter.get(stu + "/id/cards", view, h(async (_req, _res, inst) => ({ items: await sm2.idCards(inst) })));
schoolRouter.post(stu + "/id/generate", staffDesk, h((req, _res, inst) => sm2.generateCards(inst, req.body?.all === true ? "all" : z.array(z.string().uuid()).max(500).parse(req.body?.ids ?? []))));
schoolRouter.get(stu + "/promotion", view, h((_req, _res, inst) => sm2.promotionList(inst)));
schoolRouter.post(stu + "/promotion", staffDesk, h((req, _res, inst) => sm2.promote(inst, req.body, req.user?.profileId)));
schoolRouter.get(stu + "/campuses", view, h(async (_req, _res, inst) => ({ items: await sx.campuses(inst) })));
schoolRouter.get(stu + "/records/:kind", view, h((req, _res, inst) => sx.listRecords(inst, String(req.params.kind))));
schoolRouter.post(stu + "/records", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await sx.addRecord(inst, req.body, req.user?.profileId) }; }));
schoolRouter.patch(stu + "/records/:id", staffDesk, h((req, _res, inst) => sx.setRecordStatus(inst, uuid(req), req.body)));
schoolRouter.get(stu + "/withdrawals", view, h(async (_req, _res, inst) => ({ items: await sx.listWithdrawals(inst) })));
schoolRouter.post(stu + "/withdrawals", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await sx.addWithdrawal(inst, req.body, req.user?.profileId) }; }));
schoolRouter.patch(stu + "/withdrawals/:id", staffDesk, h((req, _res, inst) => sx.setWithdrawalStatus(inst, uuid(req), req.body)));
schoolRouter.put(stu + "/withdrawals/:id/dues", staffDesk, h((req, _res, inst) => sx.setWithdrawalDues(inst, uuid(req), req.body)));
schoolRouter.get(stu + "/certificates", view, h(async (_req, _res, inst) => ({ items: await sx.listCertificates(inst) })));
schoolRouter.post(stu + "/certificates", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await sx.issueCertificate(inst, req.body, req.user?.profileId) }; }));
schoolRouter.get(stu + "/:id/certificate", view, h((req, _res, inst) => sx.certificateData(inst, uuid(req))));
schoolRouter.get(stu + "/:id", view, h((req, _res, inst) => sm2.getStudent(inst, uuid(req))));
schoolRouter.get(stu + "/:id/card", view, h((req, _res, inst) => sm2.cardData(inst, uuid(req))));
schoolRouter.put(stu + "/:id/guardian", staffDesk, h((req, _res, inst) => sm2.saveGuardian(inst, uuid(req), req.body)));
schoolRouter.put(stu + "/:id/assign", staffDesk, h((req, _res, inst) => sm2.assign(inst, uuid(req), req.body)));
schoolRouter.put(stu + "/:id/:part", staffDesk, h((req, _res, inst) => sm2.updateStudent(inst, uuid(req), String(req.params.part), req.body)));

// ── parents and alumni ──
const par = "/parents-mgmt";
schoolRouter.get(par, view, h((_req, _res, inst) => pr.listParents(inst)));
schoolRouter.post(par, staffDesk, h(async (req, res, inst) => { res.status(201); return pr.addParent(inst, req.body); }));
schoolRouter.post(par + "/bulk", staffDesk, h((req, _res, inst) => pr.bulkParents(inst, req.body)));
schoolRouter.get(par + "/family", view, h((_req, _res, inst) => pr.family(inst)));
schoolRouter.get(par + "/messages/:kind", view, h((req, _res, inst) => pr.listMessages(inst, String(req.params.kind))));
schoolRouter.post(par + "/messages", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await pr.addMessage(inst, req.body, req.user?.profileId) }; }));
schoolRouter.patch(par + "/messages/:id", staffDesk, h((req, _res, inst) => pr.setMessageStatus(inst, uuid(req), req.body)));
schoolRouter.get(par + "/requests/:kind", view, h(async (req, _res, inst) => px.listRequests(inst, String(req.params.kind))));
schoolRouter.post(par + "/requests", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await px.addRequest(inst, req.body, req.user?.profileId) }; }));
schoolRouter.patch(par + "/requests/:id", staffDesk, h((req, _res, inst) => px.setRequestStatus(inst, uuid(req), req.body)));
schoolRouter.get(par + "/feedback", view, h((req, _res, inst) => px.listFeedback(inst, typeof req.query.kind === "string" ? req.query.kind : undefined)));
schoolRouter.post(par + "/feedback", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await px.addFeedback(inst, req.body, req.user?.profileId) }; }));
schoolRouter.patch(par + "/feedback/:id", staffDesk, h((req, _res, inst) => px.setFeedbackStatus(inst, uuid(req), req.body)));
schoolRouter.get(par + "/login-activity", view, h((_req, _res, inst) => px.loginActivity(inst)));
const adminOnly = requireRoles("InstitutionAdmin", "Principal", "VicePrincipal");
schoolRouter.get("/academic-years", view, h((_req, _res, inst) => ac.listYears(inst)));
schoolRouter.post("/academic-years", adminOnly, h(async (req, res, inst) => { res.status(201); return { item: await ac.createYear(inst, req.body) }; }));
schoolRouter.put("/academic-years/:id", adminOnly, h((req, _res, inst) => ac.updateYear(inst, uuid(req), req.body)));
schoolRouter.post("/academic-years/:id/activate", adminOnly, h((req, _res, inst) => ac.activateYear(inst, uuid(req))));
schoolRouter.post("/academic-years/:id/close", adminOnly, h((req, _res, inst) => ac.closeYear(inst, uuid(req))));
schoolRouter.get("/classes", view, h((_req, _res, inst) => a2.listClasses(inst)));
schoolRouter.post("/classes", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.addClass(inst, req.body); }));
schoolRouter.put("/classes/:id", adminOnly, h((req, _res, inst) => a2.updateClass(inst, uuid(req), req.body)));
schoolRouter.get("/section-rows", view, h((_req, _res, inst) => a2.listSectionRows(inst)));
schoolRouter.post("/section-rows", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.addSectionRow(inst, req.body); }));
schoolRouter.put("/section-rows/:id", adminOnly, h((req, _res, inst) => a2.updateSectionRow(inst, uuid(req), req.body)));
schoolRouter.get("/subject-rows", view, h((_req, _res, inst) => a2.listSubjectRows(inst)));
schoolRouter.post("/subject-rows", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.addSubjectRow(inst, req.body); }));
schoolRouter.get("/subject-grid", view, h((_req, _res, inst) => a2.subjectGrid(inst)));
schoolRouter.put("/subject-grid", adminOnly, h((req, _res, inst) => a2.saveSubjectGrid(inst, req.body)));
schoolRouter.get("/teacher-subjects", view, h((_req, _res, inst) => a2.teacherSubjects(inst)));
schoolRouter.post("/teacher-subjects", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.assignTeacher(inst, req.body); }));
schoolRouter.delete("/teacher-subjects/:id", adminOnly, h((req, _res, inst) => a2.removeTeacherSubject(inst, uuid(req))));
schoolRouter.get("/curriculum", view, h((_req, _res, inst) => a2.listCurriculum(inst)));
schoolRouter.post("/curriculum", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.addChapter(inst, req.body); }));
schoolRouter.patch("/curriculum/:id", adminOnly, h((req, _res, inst) => a2.setChapterStatus(inst, uuid(req), req.body)));
schoolRouter.get("/lesson-plans", view, h((_req, _res, inst) => a2.listLessonPlans(inst)));
schoolRouter.post("/lesson-plans", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.addLessonPlan(inst, req.body); }));
schoolRouter.patch("/lesson-plans/:id", adminOnly, h((req, _res, inst) => a2.updateLessonPlan(inst, uuid(req), req.body)));
schoolRouter.get("/calendar", view, h((_req, _res, inst) => a2.listCalendar(inst)));
schoolRouter.post("/calendar", adminOnly, h(async (req, res, inst) => { res.status(201); return a2.addCalendarEvent(inst, req.body); }));
schoolRouter.patch("/calendar/:id", adminOnly, h((req, _res, inst) => a2.setEventPublished(inst, uuid(req), req.body)));
schoolRouter.delete("/calendar/:id", adminOnly, h((req, _res, inst) => a2.deleteCalendarEvent(inst, uuid(req))));
schoolRouter.put("/calendar-settings", adminOnly, h((req, _res, inst) => a2.saveCalendarSettings(inst, req.body)));
const teachDesk = requireRoles("InstitutionAdmin", "Principal", "VicePrincipal", "ClassTeacher", "Teacher");
schoolRouter.get("/attendance/sheet", view, h((req, _res, inst) => at.sheet(inst, String(req.query.section_id ?? ""), String(req.query.date ?? ""))));
schoolRouter.put("/attendance/sheet", teachDesk, h((req, _res, inst) => at.saveSheet(inst, req.body, req.user?.profileId)));
schoolRouter.get("/attendance/daily", view, h((req, _res, inst) => at.daily(inst, typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10))));
schoolRouter.get("/attendance/subjects", view, h((req, _res, inst) => at.sectionSubjects(inst, String(req.query.section_id ?? ""))));
schoolRouter.get("/attendance/summary", view, h((_req, _res, inst) => at.summary(inst)));
schoolRouter.get("/attendance/corrections", view, h((_req, _res, inst) => at.listCorrections(inst)));
schoolRouter.post("/attendance/corrections", teachDesk, h(async (req, res, inst) => { res.status(201); return { item: await at.requestCorrection(inst, req.body, req.user?.profileId) }; }));
schoolRouter.patch("/attendance/corrections/:id", adminOnly, h((req, _res, inst) => at.decideCorrection(inst, uuid(req), req.body, req.user?.profileId)));
schoolRouter.get("/academic-rules", view, h((_req, _res, inst) => at.getRules(inst)));
schoolRouter.put("/academic-rules", adminOnly, h((req, _res, inst) => at.saveRules(inst, req.body)));
const att = "/attendance";
const dateQ = (req: Request) => (typeof req.query.date === "string" ? req.query.date : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
schoolRouter.get(att + "/staff/sheet", view, h((req, _res, inst) => a2s.staffSheet(inst, dateQ(req))));
schoolRouter.put(att + "/staff/sheet", adminOnly, h((req, _res, inst) => a2s.saveStaffSheet(inst, req.body, req.user?.profileId)));
schoolRouter.get(att + "/staff/departments", view, h((req, _res, inst) => a2s.staffDepartments(inst, dateQ(req))));
schoolRouter.get(att + "/geo", view, h((req, _res, inst) => a2s.listGeo(inst, dateQ(req))));
schoolRouter.post(att + "/geo", adminOnly, h(async (req, res, inst) => { res.status(201); return a2s.addGeo(inst, req.body); }));
schoolRouter.patch(att + "/geo/:id", adminOnly, h((req, _res, inst) => a2s.resolveGeo(inst, uuid(req), req.body)));
schoolRouter.get(att + "/bio", view, h((_req, _res, inst) => a2s.listBio(inst)));
schoolRouter.post(att + "/bio/devices", adminOnly, h(async (req, res, inst) => { res.status(201); return a2s.addBioDevice(inst, req.body); }));
schoolRouter.put(att + "/bio/mappings", adminOnly, h((req, _res, inst) => a2s.mapBio(inst, req.body)));
schoolRouter.patch(att + "/bio/mappings/:id", adminOnly, h((req, _res, inst) => a2s.setFingerprints(inst, uuid(req), req.body)));
schoolRouter.post(att + "/bio/syncs", adminOnly, h(async (req, res, inst) => { res.status(201); return a2s.logSync(inst, req.body); }));
schoolRouter.get(att + "/readers", view, h((req, _res, inst) => a3.listReaders(inst, dateQ(req))));
schoolRouter.post(att + "/readers", adminOnly, h(async (req, res, inst) => { res.status(201); return a3.addReader(inst, req.body); }));
schoolRouter.patch(att + "/readers/:id", adminOnly, h((req, _res, inst) => a3.setReaderStatus(inst, uuid(req), req.body)));
schoolRouter.get(att + "/cards", view, h((_req, _res, inst) => a3.listCards(inst)));
schoolRouter.post(att + "/cards", teachDesk, h(async (req, res, inst) => { res.status(201); return a3.issueCard(inst, req.body); }));
schoolRouter.post(att + "/cards/:id/lost", teachDesk, h((req, _res, inst) => a3.markCardLost(inst, uuid(req))));
schoolRouter.get(att + "/scans", view, h((req, _res, inst) => a3.listScans(inst, dateQ(req))));
schoolRouter.post(att + "/scans", teachDesk, h(async (req, res, inst) => { res.status(201); return a3.addScan(inst, req.body); }));
schoolRouter.get(att + "/sync", view, h((req, _res, inst) => a3.syncSummary(inst, dateQ(req))));
schoolRouter.post(att + "/sync/push", teachDesk, h((req, _res, inst) => a3.pushAttendance(inst, req.user?.profileId)));
schoolRouter.post(att + "/sync/mark", teachDesk, h((req, _res, inst) => a3.markException(inst, req.body, req.user?.profileId)));
schoolRouter.get(att + "/alerts", view, h((req, _res, inst) => a3.parentAlerts(inst, dateQ(req))));
schoolRouter.get(att + "/leaves", view, h((_req, _res, inst) => a3.listLeaves(inst)));
schoolRouter.post(att + "/leaves/student", teachDesk, h(async (req, res, inst) => { res.status(201); return a3.addStudentLeave(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(att + "/leaves/:who/:id", adminOnly, h((req, _res, inst) => a3.decideLeave(inst, req.params.who === "staff" ? "staff" : "student", uuid(req), req.body, req.user?.profileId)));
schoolRouter.get(att + "/monthly", view, h((_req, _res, inst) => a3.monthly(inst)));
schoolRouter.get(att + "/student-wise", view, h((_req, _res, inst) => a3.studentWise(inst)));
schoolRouter.get("/att-settings", view, h((_req, _res, inst) => tt.getAttSettings(inst)));
schoolRouter.put("/att-settings", adminOnly, h((req, _res, inst) => tt.saveAttSettings(inst, req.body)));
const ttp = "/timetable";
schoolRouter.get(ttp + "/periods", view, h((_req, _res, inst) => tt.listPeriods(inst)));
schoolRouter.post(ttp + "/periods", adminOnly, h(async (req, res, inst) => { res.status(201); return tt.addPeriod(inst, req.body); }));
schoolRouter.post(ttp + "/periods/defaults", adminOnly, h(async (_req, res, inst) => { res.status(201); return tt.defaultPeriods(inst); }));
schoolRouter.delete(ttp + "/periods/:id", adminOnly, h((req, _res, inst) => tt.deletePeriod(inst, uuid(req))));
schoolRouter.get(ttp + "/grid/:id", view, h((req, _res, inst) => tt.grid(inst, uuid(req))));
schoolRouter.put(ttp + "/grid/:id", adminOnly, h((req, _res, inst) => tt.saveGrid(inst, uuid(req), req.body)));
schoolRouter.get(ttp + "/publish", view, h((_req, _res, inst) => tt.publishList(inst)));
schoolRouter.post(ttp + "/publish", adminOnly, h((req, _res, inst) => tt.publish(inst, req.body?.section_id ? uuid({ params: { id: req.body.section_id } } as unknown as Request) : "all")));
schoolRouter.get(ttp + "/rules", view, h((_req, _res, inst) => tt.getRules(inst)));
schoolRouter.put(ttp + "/rules", adminOnly, h((req, _res, inst) => tt.saveRules(inst, req.body)));
schoolRouter.post(ttp + "/limits", adminOnly, h(async (req, res, inst) => { res.status(201); return tt.addLimit(inst, req.body); }));
schoolRouter.delete(ttp + "/limits/:id", adminOnly, h((req, _res, inst) => tt.removeLimit(inst, uuid(req))));
schoolRouter.get(ttp + "/auto", view, h((_req, _res, inst) => tt.autoView(inst)));
schoolRouter.post(ttp + "/generate", adminOnly, h((_req, _res, inst) => tt.generate(inst)));
schoolRouter.post(ttp + "/slots/:id/lock", adminOnly, h((req, _res, inst) => tt.toggleLock(inst, uuid(req))));
schoolRouter.post(ttp + "/words", adminOnly, h((req, _res, inst) => tt.applyWords(inst, req.body)));
schoolRouter.get("/boards", view, h((_req, _res, inst) => ac.listBoards(inst)));
schoolRouter.put("/boards", adminOnly, h((req, _res, inst) => ac.saveBoard(inst, req.body)));
schoolRouter.get(par + "/:id", view, h((req, _res, inst) => pr.getParent(inst, uuid(req))));
schoolRouter.put(par + "/:id", staffDesk, h((req, _res, inst) => pr.saveParent(inst, uuid(req), req.body)));
schoolRouter.post(par + "/:id/link", staffDesk, h((req, _res, inst) => pr.linkStudent(inst, uuid(req), req.body)));
schoolRouter.put(par + "/:id/login", staffDesk, h((req, _res, inst) => pr.setLogin(inst, uuid(req), req.body)));
schoolRouter.get("/alumni", view, h((_req, _res, inst) => pr.listAlumni(inst)));
schoolRouter.post("/alumni", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await pr.addAlumnus(inst, req.body) }; }));
schoolRouter.post("/alumni/events", staffDesk, h(async (req, res, inst) => { res.status(201); return { item: await pr.addAlumniEvent(inst, req.body) }; }));

// ── assistant ──
schoolRouter.post("/assist/chat", view, h(async (req, _res, inst) => {
  const { messages, page } = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional() }).parse(req.body);
  if (messages[messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return schoolChat(messages, page, req.user?.profileId ?? "anonymous", inst, req.user?.roleDisplayName ?? "");
}));
schoolRouter.post("/assist/transcribe", view, express.raw({ type: "audio/*", limit: "2mb" }), h(async (req, _res) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, req.user?.profileId ?? "anonymous");
}));

// ── my profile (the signed-in person's own details) ──
const me = (req: Request): string => {
  const id = req.user?.profileId;
  if (!id) throw new HttpError(401, "Sign in again.");
  return id;
};
schoolRouter.get("/me/profile", h(async (req) => profileSvc.getMyProfile(me(req))));
schoolRouter.put("/me/contact", h(async (req) => {
  const input = z.object({
    mobile: z.string().trim().max(30).optional(), alt_phone: z.string().trim().max(30).optional(), personal_email: z.union([z.string().trim().email().max(255), z.literal("")]).optional(),
    date_of_birth: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional(), blood_group: z.string().trim().max(5).optional(), home_address: z.string().trim().max(500).optional(),
    emergency_name: z.string().trim().max(150).optional(), emergency_relation: z.string().trim().max(40).optional(), emergency_phone: z.string().trim().max(30).optional(),
  }).parse(req.body);
  return profileSvc.saveContact(me(req), input);
}));
schoolRouter.get("/me/qualifications", h(async (req) => ({ items: await profileSvc.listQualifications(me(req)) })));
schoolRouter.post("/me/qualifications", h(async (req, res) => {
  const input = z.object({ title: z.string().trim().min(2).max(200), institution: z.string().trim().min(2).max(200), year: z.number().int().min(1950).max(2100), result: z.string().trim().max(100).optional() }).parse(req.body);
  res.status(201);
  return { item: await profileSvc.addQualification(me(req), input) };
}));

schoolRouter.get("/setup/status", view, h((_req, _res, inst) => svc.getSetupStatus(inst)));

// Academic years
schoolRouter.get("/years", view, h((_req, _res, inst) => svc.listYears(inst).then((years) => ({ years }))));
schoolRouter.post("/years", manage, h(async (req, res, inst) => {
  res.status(201);
  return { year: await svc.createYear(inst, yearSchema.parse(req.body)) };
}));
schoolRouter.patch("/years/:id", manage, h(async (req, _res, inst) => ({
  year: await svc.updateYear(inst, uuid(req), yearSchema.partial().omit({ is_current: true }).extend({ is_locked: z.boolean().optional() }).parse(req.body)),
})));
schoolRouter.post("/years/:id/current", manage, h(async (req, _res, inst) => ({ year: await svc.setCurrentYear(inst, uuid(req)) })));

// Grades
schoolRouter.get("/grades", view, h((_req, _res, inst) => svc.listGrades(inst).then((grades) => ({ grades }))));
schoolRouter.post("/grades", manage, h(async (req, res, inst) => {
  res.status(201);
  return { grade: await svc.createGrade(inst, gradeSchema.parse(req.body)) };
}));
schoolRouter.post("/grades/defaults", manage, h((_req, _res, inst) => svc.addDefaultGrades(inst).then((grades) => ({ grades }))));
schoolRouter.patch("/grades/:id", manage, h(async (req, _res, inst) => ({
  grade: await svc.updateGrade(inst, uuid(req), z.object({ name: z.string().trim().min(1).max(100), sort_order: z.number().int(), is_active: z.boolean() }).partial().parse(req.body)),
})));

// Sections
schoolRouter.get("/sections", view, h((req, _res, inst) =>
  svc.listSections(inst, typeof req.query.academic_year_id === "string" ? req.query.academic_year_id : undefined).then((sections) => ({ sections }))
));
schoolRouter.post("/sections", manage, h(async (req, res, inst) => {
  res.status(201);
  return { section: await svc.createSection(inst, sectionSchema.parse(req.body)) };
}));
schoolRouter.post("/sections/defaults", manage, h(async (req, _res, inst) => {
  const { academic_year_id, names } = z
    .object({ academic_year_id: z.string().uuid(), names: z.array(z.string().trim().min(1).max(50)).min(1).max(10) })
    .parse(req.body);
  return { sections: await svc.addDefaultSections(inst, academic_year_id, names) };
}));
schoolRouter.patch("/sections/:id", manage, h(async (req, _res, inst) => ({
  section: await svc.updateSection(inst, uuid(req), z.object({ name: z.string().trim().min(1).max(50), capacity: z.number().int().min(1).max(500) }).partial().parse(req.body)),
})));
schoolRouter.delete("/sections/:id", manage, h((req, _res, inst) => svc.deleteSection(inst, uuid(req))));

// Subjects
schoolRouter.get("/subjects", view, h((_req, _res, inst) => svc.listSubjects(inst).then((subjects) => ({ subjects }))));
schoolRouter.post("/subjects", manage, h(async (req, res, inst) => {
  res.status(201);
  return { subject: await svc.createSubject(inst, subjectSchema.parse(req.body)) };
}));
schoolRouter.post("/subjects/defaults", manage, h((_req, _res, inst) => svc.addDefaultSubjects(inst).then((subjects) => ({ subjects }))));
schoolRouter.patch("/subjects/:id", manage, h(async (req, _res, inst) => ({
  subject: await svc.updateSubject(inst, uuid(req), z.object({ name: z.string().trim().min(1).max(150), is_active: z.boolean() }).partial().parse(req.body)),
})));

// Announcements from the platform team (any signed-in school user)
schoolRouter.get("/announcements", h((_req, _res, inst) => listSchoolAnnouncements(inst).then((announcements) => ({ announcements }))));

schoolRouter.post("/announcements/:id/read", h((req, _res, inst) => markAnnouncementRead(inst, uuid(req))));

// Help centre: anyone signed in to the school can read it
schoolRouter.get("/help", h(async (req, _res) => ({ items: await sm.listKb(req.query, true) })));
schoolRouter.post("/help/:id/view", h(async (req, _res) => sm.viewKb(uuid(req))));
schoolRouter.post("/help/:id/vote", h(async (req, _res) => sm.voteKb(uuid(req), z.object({ helpful: z.boolean() }).parse(req.body).helpful)));
schoolRouter.get("/support/categories", h(async () => ({ categories: await sm.activeCategories() })));
schoolRouter.get("/features", h((_req, _res, inst) => sm.listFeatures(inst).then((items) => ({ items }))));
schoolRouter.post("/features", manage, h(async (req, res, inst) => {
  res.status(201);
  return sm.createFeature(inst, await actorName(req), z.object({ title: z.string().trim().min(5, "Describe the feature in a few words.").max(200), description: z.string().trim().max(2000).nullable().optional() }).parse(req.body));
}));
schoolRouter.post("/features/:id/vote", manage, h((req, _res, inst) => sm.toggleVote(inst, uuid(req))));
schoolRouter.post("/feedback", manage, h(async (req, res, inst) => {
  res.status(201);
  return sm.submitFeedback(inst, await actorName(req), z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).nullable().optional(), ticket_id: z.string().uuid().nullable().optional() }).parse(req.body));
}));

// Support tickets raised by the school
schoolRouter.get("/support/tickets", manage, h((_req, _res, inst) => support.listSchoolTickets(inst).then((tickets) => ({ tickets }))));
schoolRouter.post("/support/tickets", manage, h(async (req, res, inst) => {
  const input = z
    .object({
      subject: z.string().trim().min(3, "Enter a short subject.").max(255),
      category: z.string().trim().min(1).max(50).default("General"),
      priority: z.enum(support.PRIORITIES).optional(),
      subtopic: z.string().trim().max(60).optional(),
      body: z.string().trim().min(1, "Describe the problem.").max(5000),
    })
    .parse(req.body);
  res.status(201);
  return support.createSchoolTicket(inst, await actorName(req), input);
}));
schoolRouter.get("/support/tickets/:id", manage, h((req, _res, inst) => support.getSchoolTicket(inst, uuid(req))));
schoolRouter.post("/support/tickets/:id/messages", manage, h(async (req, res, inst) => {
  const { body } = z.object({ body: z.string().trim().min(1, "Write a message.").max(5000) }).parse(req.body);
  res.status(201);
  return support.addSchoolMessage(inst, uuid(req), await actorName(req), body);
}));

// Billing: the school sees its own invoices and can pay online
const billingPerm = requirePermission("admin.settings.manage");
schoolRouter.get("/billing/invoices", billingPerm, h((req, _res, inst) => billing.listInvoices(req.query, inst)));
schoolRouter.get("/billing/invoices/:id", billingPerm, h((req, _res, inst) => billing.getInvoice(uuid(req), inst)));
schoolRouter.post("/billing/invoices/:id/order", billingPerm, h((req, _res, inst) => billing.createCheckoutOrder(inst, uuid(req))));
schoolRouter.post("/billing/verify", billingPerm, h((req, _res, inst) =>
  billing.verifyCheckout(
    inst,
    z.object({ razorpay_order_id: z.string().min(1), razorpay_payment_id: z.string().min(1), razorpay_signature: z.string().min(1) }).parse(req.body)
  )
));
schoolRouter.get("/flags", h(async (_req, _res, inst) => ({ flags: await modcfg.flagsForSchool(inst) })));
schoolRouter.get("/subscription", billingPerm, h(async (_req, _res, inst) => {
  const [details, requests, plans] = await Promise.all([subsvc.getSchoolSubscription(inst), subsvc.schoolRequests(inst), svc2.listPlans()]);
  return { subscription: details.subscription, usage: details.usage, requests, plans };
}));
schoolRouter.post("/subscription/request", billingPerm, h(async (req, res, inst) => {
  const b = z.object({ plan_code: z.string().trim().min(1), note: z.string().trim().max(500).optional() }).parse(req.body);
  res.status(201);
  return subsvc.createRequest(inst, req.user?.profileId, b.plan_code, b.note);
}));
schoolRouter.get("/billing/config", billingPerm, h(async () => ({ online_payments: billing.gatewayInfo().razorpay.configured })));
