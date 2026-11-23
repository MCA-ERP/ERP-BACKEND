import { moduleGate } from "../../lib/portal-modules";
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
import * as t2 from "./timetable2.service";
import * as ex from "./exam-config.service";
import * as es from "./exam.service";
import * as mk from "./marks.service";
import * as rs from "./results.service";
import * as cp from "./competitive.service";
import * as lm from "./lms.service";
import * as fe from "./fees.service";
import * as fe2 from "./fees2.service";
import * as fe3 from "./fees3.service";
import * as fe4 from "./fees4.service";
import * as hr from "./hr.service";
import * as hr2 from "./hr2.service";
import * as hr3 from "./hr3.service";
import * as hr4 from "./hr4.service";
import * as pay from "./pay.service";
import * as pay2 from "./pay2.service";
import * as tr from "./transport.service";
import * as tr2 from "./tr2.service";
import * as lib from "./lib.service";
import * as lb2 from "./lib2.service";
import * as iv from "./inv.service";
import * as iv2 from "./inv2.service";
import * as cm from "./comm.service";
import * as cm2 from "./comm2.service";
import * as sv from "./survey.service";
import * as ho from "./hostel.service";
import * as cam from "./campus.service";
import * as h2 from "./health2.service";
import * as actv from "./act.service";
import * as rpt from "./reports.service";
import * as cus from "./custom.service";
import * as stg from "./settings.service";
import * as st2 from "./settings2.service";
import { seedSchoolDefaults } from "./defaults.service";
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
import * as topbar from "./topbar.service";

import * as accFees from "../accounts/accounts-fees.service";

export const schoolRouter = Router();

// Everything here is the school's own setup data; SuperAdmin must say which school via ?institution_id=
schoolRouter.use(authGuard);
schoolRouter.use(moduleGate);

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
schoolRouter.get(ttp + "/teachers", view, h((_req, _res, inst) => t2.teacherList(inst)));
schoolRouter.get(ttp + "/teacher-week/:id", view, h((req, _res, inst) => t2.teacherWeek(inst, uuid(req))));
schoolRouter.get(ttp + "/allocations", view, h((_req, _res, inst) => t2.allocations(inst)));
schoolRouter.get(ttp + "/rooms", view, h((_req, _res, inst) => t2.listRooms(inst)));
schoolRouter.post(ttp + "/rooms", adminOnly, h(async (req, res, inst) => { res.status(201); return t2.addRoom(inst, req.body); }));
schoolRouter.put(ttp + "/rooms/:id", adminOnly, h((req, _res, inst) => t2.updateRoom(inst, uuid(req), req.body)));
schoolRouter.get(ttp + "/conflicts", view, h((_req, _res, inst) => t2.conflicts(inst)));
schoolRouter.get(ttp + "/workload", view, h((_req, _res, inst) => t2.workload(inst)));
schoolRouter.get(ttp + "/substitution/today", view, h((req, _res, inst) => t2.substitutionToday(inst, dateQ(req))));
schoolRouter.get(ttp + "/substitution/free", view, h((req, _res, inst) => t2.freePeriods(inst, dateQ(req), typeof req.query.period_id === "string" ? req.query.period_id : undefined)));
schoolRouter.get(ttp + "/substitution/history", view, h((_req, _res, inst) => t2.listSubstitutions(inst)));
schoolRouter.post(ttp + "/substitution", adminOnly, h(async (req, res, inst) => { res.status(201); return t2.assignSubstitute(inst, req.body, req.user?.profileId); }));
schoolRouter.post(ttp + "/substitution/auto", adminOnly, h((req, _res, inst) => t2.assignBest(inst, dateQ(req), req.user?.profileId)));
schoolRouter.patch(ttp + "/substitution/:id", adminOnly, h((req, _res, inst) => t2.setSubstitutionStatus(inst, uuid(req), req.body)));
schoolRouter.get("/exam-types", view, h((_req, _res, inst) => ex.listExamTypes(inst)));
schoolRouter.post("/exam-types", adminOnly, h(async (req, res, inst) => { res.status(201); return ex.addExamType(inst, req.body); }));
schoolRouter.put("/exam-types/:id", adminOnly, h((req, _res, inst) => ex.updateExamType(inst, uuid(req), req.body)));
schoolRouter.get("/marks-settings", view, h((_req, _res, inst) => ex.getMarksSettings(inst)));
schoolRouter.put("/marks-settings", adminOnly, h((req, _res, inst) => ex.saveMarksSettings(inst, req.body)));
const exm = "/exams";
const qs = (req: Request, k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : "");
schoolRouter.get(exm, view, h((_req, _res, inst) => es.listExams(inst)));
schoolRouter.post(exm, adminOnly, h(async (req, res, inst) => { res.status(201); return es.addExam(inst, req.body); }));
schoolRouter.put(exm + "/item/:id", adminOnly, h((req, _res, inst) => es.updateExam(inst, uuid(req), req.body)));
schoolRouter.get(exm + "/papers", view, h((req, _res, inst) => es.listPapers(inst, qs(req, "exam_id") || undefined)));
schoolRouter.post(exm + "/papers", adminOnly, h(async (req, res, inst) => { res.status(201); return es.addPaper(inst, req.body); }));
schoolRouter.delete(exm + "/papers/:id", adminOnly, h((req, _res, inst) => es.deletePaper(inst, uuid(req))));
schoolRouter.get(exm + "/date-sheet", view, h((req, _res, inst) => es.dateSheet(inst, qs(req, "exam_id"))));
schoolRouter.post(exm + "/date-sheet/generate", adminOnly, h((req, _res, inst) => es.generateSheet(inst, req.body)));
schoolRouter.post(exm + "/date-sheet/publish", adminOnly, h((req, _res, inst) => es.publishSheet(inst, req.body)));
schoolRouter.post(exm + "/date-sheet/send", adminOnly, h((req, _res, inst) => es.sendSheet(inst, req.body, req.user?.profileId)));
schoolRouter.get(exm + "/seating", view, h((req, _res, inst) => es.seating(inst, qs(req, "exam_id"), qs(req, "subject_id") || undefined)));
schoolRouter.get(exm + "/eligibility", view, h((req, _res, inst) => es.eligibility(inst, qs(req, "exam_id"))));
schoolRouter.get(exm + "/hall-tickets", view, h((req, _res, inst) => es.hallTickets(inst, qs(req, "exam_id"), qs(req, "student_id") || undefined)));
schoolRouter.get(exm + "/marks", view, h((req, _res, inst) => mk.sheet(inst, { exam_id: qs(req, "exam_id"), section_id: qs(req, "section_id"), subject_id: qs(req, "subject_id"), component: qs(req, "component") || "Theory" })));
schoolRouter.put(exm + "/marks", teachDesk, h((req, _res, inst) => mk.saveSheet(inst, req.body, req.user?.profileId)));
schoolRouter.post(exm + "/marks/bulk", teachDesk, h((req, _res, inst) => mk.bulk(inst, req.body, req.user?.profileId)));
schoolRouter.get(exm + "/coscholastic", view, h((req, _res, inst) => mk.coscholastic(inst, { section_id: qs(req, "section_id"), term: qs(req, "term") })));
schoolRouter.put(exm + "/coscholastic", teachDesk, h((req, _res, inst) => mk.saveCoscholastic(inst, req.body)));
schoolRouter.get(exm + "/questions", view, h((_req, _res, inst) => mk.listQuestions(inst)));
schoolRouter.post(exm + "/questions", teachDesk, h(async (req, res, inst) => { res.status(201); return mk.addQuestion(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(exm + "/questions/:id", adminOnly, h((req, _res, inst) => mk.setQuestionStatus(inst, uuid(req), req.body)));
schoolRouter.get(exm + "/verification", view, h((_req, _res, inst) => rs.verificationList(inst)));
schoolRouter.post(exm + "/verification", adminOnly, h((req, _res, inst) => rs.decide(inst, req.body)));
schoolRouter.get(exm + "/results", view, h((req, _res, inst) => rs.results(inst, qs(req, "exam_id"), qs(req, "section_id"))));
schoolRouter.get(exm + "/analysis", view, h((req, _res, inst) => rs.analysis(inst, qs(req, "exam_id"), qs(req, "section_id"))));
schoolRouter.get(exm + "/report-templates", view, h((_req, _res, inst) => rs.templates(inst)));
schoolRouter.patch(exm + "/report-templates/:id", adminOnly, h((req, _res, inst) => rs.setTemplate(inst, uuid(req), req.body)));
schoolRouter.get(exm + "/report-cards", view, h((req, _res, inst) => rs.cardRuns(inst, qs(req, "exam_id"))));
schoolRouter.post(exm + "/report-cards/generate", adminOnly, h((req, _res, inst) => rs.generate(inst, req.body)));
schoolRouter.post(exm + "/report-cards/publish", adminOnly, h((req, _res, inst) => rs.publishCards(inst, req.body, req.user?.profileId)));
schoolRouter.get(exm + "/report-card", view, h((req, _res, inst) => rs.card(inst, qs(req, "exam_id"), qs(req, "student_id"))));
schoolRouter.get(exm + "/holistic", view, h((_req, _res, inst) => rs.holistic(inst)));
const cmp = "/competitive";
schoolRouter.get(cmp + "/programmes", view, h((_req, _res, inst) => cp.programmes(inst)));
schoolRouter.post(cmp + "/programmes", adminOnly, h(async (req, res, inst) => { res.status(201); return cp.addProgramme(inst, req.body); }));
schoolRouter.post(cmp + "/members", adminOnly, h((req, _res, inst) => cp.addMembers(inst, req.body)));
schoolRouter.get(cmp + "/tests", view, h((_req, _res, inst) => cp.tests(inst)));
schoolRouter.post(cmp + "/tests", adminOnly, h(async (req, res, inst) => { res.status(201); return cp.addTest(inst, req.body); }));
schoolRouter.post(cmp + "/results", adminOnly, h((req, _res, inst) => cp.addResults(inst, req.body)));
schoolRouter.get(cmp + "/readiness", view, h((req, _res, inst) => cp.readiness(inst, qs(req, "programme_id"))));
schoolRouter.get(cmp + "/bank", view, h((_req, _res, inst) => cp.bank(inst)));
schoolRouter.put(cmp + "/bank", adminOnly, h((req, _res, inst) => cp.saveBank(inst, req.body)));
schoolRouter.get(cmp + "/registrations", view, h((_req, _res, inst) => cp.registrations(inst)));
schoolRouter.post(cmp + "/registrations", adminOnly, h(async (req, res, inst) => { res.status(201); return cp.addRegistration(inst, req.body); }));
schoolRouter.patch(cmp + "/registrations/:id", adminOnly, h((req, _res, inst) => cp.setRegistration(inst, uuid(req), req.body)));
schoolRouter.post(cmp + "/registrations/:id/remind", adminOnly, h((req, _res, inst) => cp.remindParent(inst, uuid(req), req.user?.profileId)));
const lms = "/lms";
schoolRouter.get(lms + "/homework", view, h((_req, _res, inst) => lm.listHomework(inst)));
schoolRouter.post(lms + "/homework", teachDesk, h(async (req, res, inst) => { res.status(201); return lm.addHomework(inst, req.body, req.user?.profileId); }));
schoolRouter.put(lms + "/homework/:id", teachDesk, h((req, _res, inst) => lm.updateHomework(inst, uuid(req), req.body)));
schoolRouter.get(lms + "/assignments", view, h((_req, _res, inst) => lm.listAssignments(inst)));
schoolRouter.post(lms + "/assignments", teachDesk, h(async (req, res, inst) => { res.status(201); return lm.addAssignment(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(lms + "/assignments/:id", teachDesk, h((req, _res, inst) => lm.setAssignmentStatus(inst, uuid(req), req.body)));
schoolRouter.get(lms + "/materials", view, h((_req, _res, inst) => lm.listMaterials(inst)));
schoolRouter.post(lms + "/materials", teachDesk, h(async (req, res, inst) => { res.status(201); return lm.addMaterial(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(lms + "/materials/:id", teachDesk, h((req, _res, inst) => lm.setMaterialStatus(inst, uuid(req), req.body)));
schoolRouter.get(lms + "/sessions", view, h((_req, _res, inst) => lm.listSessions(inst)));
schoolRouter.post(lms + "/sessions", teachDesk, h(async (req, res, inst) => { res.status(201); return lm.addSession(inst, req.body); }));
schoolRouter.patch(lms + "/sessions/:id", teachDesk, h((req, _res, inst) => lm.setSessionStatus(inst, uuid(req), req.body)));
schoolRouter.get(lms + "/tests", view, h((_req, _res, inst) => lm.listTests(inst)));
schoolRouter.post(lms + "/tests", teachDesk, h(async (req, res, inst) => { res.status(201); return lm.addTest(inst, req.body); }));
schoolRouter.patch(lms + "/tests/:id", teachDesk, h((req, _res, inst) => lm.setTestStatus(inst, uuid(req), req.body)));
schoolRouter.get(lms + "/submissions", view, h((_req, _res, inst) => lm.listSubmissions(inst)));
schoolRouter.post(lms + "/submissions", teachDesk, h(async (req, res, inst) => { res.status(201); return lm.addSubmission(inst, req.body); }));
schoolRouter.patch(lms + "/submissions/:id", teachDesk, h((req, _res, inst) => lm.evaluate(inst, uuid(req), req.body)));
const fee = "/fees";
const finDesk = requireRoles("InstitutionAdmin", "Principal", "VicePrincipal", "Accountant", "Registrar");
schoolRouter.get(fee + "/categories", finDesk, h((_req, _res, inst) => fe.categories(inst)));
schoolRouter.post(fee + "/categories", finDesk, h(async (req, res, inst) => { res.status(201); return fe.addCategory(inst, req.body); }));
schoolRouter.patch(fee + "/categories/:id", finDesk, h((req, _res, inst) => fe.setCategory(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/heads", finDesk, h((_req, _res, inst) => fe.heads(inst)));
schoolRouter.post(fee + "/heads", finDesk, h(async (req, res, inst) => { res.status(201); return fe.addHead(inst, req.body); }));
schoolRouter.patch(fee + "/heads/:id", finDesk, h((req, _res, inst) => fe.setHead(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/groups", finDesk, h((_req, _res, inst) => fe.groups(inst)));
schoolRouter.post(fee + "/groups", finDesk, h(async (req, res, inst) => { res.status(201); return fe.addGroup(inst, req.body); }));
schoolRouter.post(fee + "/defaults", finDesk, h(async (_req, res, inst) => { res.status(201); return fe.defaults(inst); }));
schoolRouter.get(fee + "/structure", finDesk, h((_req, _res, inst) => fe.structure(inst)));
schoolRouter.put(fee + "/structure", finDesk, h((req, _res, inst) => fe.saveStructure(inst, req.body)));
schoolRouter.get(fee + "/section-wise", finDesk, h((_req, _res, inst) => fe.sectionWise(inst)));
schoolRouter.put(fee + "/section-wise", finDesk, h((req, _res, inst) => fe.saveOverride(inst, req.body)));
schoolRouter.delete(fee + "/section-wise/:section/:head", finDesk, h((req, _res, inst) => fe.removeOverride(inst, z.string().uuid().parse(req.params.section), z.string().uuid().parse(req.params.head))));
schoolRouter.get(fee + "/optional", finDesk, h((_req, _res, inst) => fe.optional(inst)));
schoolRouter.post(fee + "/optional", finDesk, h(async (req, res, inst) => { res.status(201); return fe.addOptional(inst, req.body); }));
schoolRouter.get(fee + "/plan/:id", finDesk, h((req, _res, inst) => fe.studentPlan(inst, uuid(req))));
schoolRouter.put(fee + "/plan/:id", finDesk, h((req, _res, inst) => fe.savePlan(inst, uuid(req), req.body)));
schoolRouter.post(fee + "/bulk", finDesk, h((req, _res, inst) => fe.bulkAssign(inst, req.body)));
schoolRouter.get(fee + "/terms", finDesk, h(async (_req, _res, inst) => ({ terms: await fe.termSplit(inst) })));
schoolRouter.get(fee + "/dues/:id", finDesk, h((req, _res, inst) => fe.dues(inst, uuid(req))));
schoolRouter.post(fee + "/collect", finDesk, h(async (req, res, inst) => { res.status(201); return fe.collect(inst, req.body, req.user?.profileId); }));
schoolRouter.get(fee + "/payments", finDesk, h((req, _res, inst) => fe.payments(inst, typeof req.query.collected_at === "string" ? req.query.collected_at : undefined)));
schoolRouter.get(fee + "/receipt/:id", finDesk, h((req, _res, inst) => fe.receipt(inst, uuid(req))));
schoolRouter.get(fee + "/concessions", finDesk, h((_req, _res, inst) => fe.concessions(inst)));
schoolRouter.post(fee + "/concessions", finDesk, h(async (req, res, inst) => { res.status(201); return fe.addConcession(inst, req.body); }));
schoolRouter.patch(fee + "/concessions/:id", adminOnly, h((req, _res, inst) => fe.decideConcession(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/installments", finDesk, h((_req, _res, inst) => fe.installments(inst)));
schoolRouter.put(fee + "/installments", adminOnly, h((req, _res, inst) => fe.saveInstallments(inst, req.body)));
schoolRouter.get(fee + "/schedule/:id", finDesk, h((req, _res, inst) => fe.schedule(inst, uuid(req))));
schoolRouter.get(fee + "/late-fee", finDesk, h((_req, _res, inst) => fe.lateFee(inst)));
schoolRouter.put(fee + "/late-fee", adminOnly, h((req, _res, inst) => fe.saveLateFee(inst, req.body)));
schoolRouter.get(fee + "/fine-rules", finDesk, h((_req, _res, inst) => fe.fineRules(inst)));
schoolRouter.put(fee + "/fine-rules", adminOnly, h((req, _res, inst) => fe.saveFineRules(inst, req.body)));
schoolRouter.get(fee + "/fines", finDesk, h((_req, _res, inst) => fe2.fines(inst)));
schoolRouter.post(fee + "/fines", finDesk, h(async (req, res, inst) => { res.status(201); return fe2.addFine(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(fee + "/fines/:id", finDesk, h((req, _res, inst) => fe2.settleFine(inst, uuid(req), req.body, req.user?.role ?? "")));
schoolRouter.get(fee + "/pending/:kind", finDesk, h((req, _res, inst) => fe2.pending(inst, z.enum(["outstanding", "overdue", "defaulters"]).parse(req.params.kind))));
schoolRouter.post(fee + "/remind", finDesk, h((req, _res, inst) => fe2.remind(inst, req.body, req.user?.profileId)));
schoolRouter.get(fee + "/receipts", finDesk, h((_req, _res, inst) => fe2.receipts(inst)));
schoolRouter.post(fee + "/receipts/:id/cancel", adminOnly, h((req, _res, inst) => fe2.cancelReceipt(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/refunds", finDesk, h((_req, _res, inst) => fe2.refunds(inst)));
schoolRouter.post(fee + "/refunds", finDesk, h(async (req, res, inst) => { res.status(201); return fe2.addRefund(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(fee + "/refunds/:id", finDesk, h((req, _res, inst) => { const st = (req.body as { status?: string } | undefined)?.status; if (st !== "Paid" && !["InstitutionAdmin", "Principal", "VicePrincipal"].includes(req.user?.role ?? "")) throw new HttpError(403, "Only the principal or school admin can decide a refund."); return fe2.moveRefund(inst, uuid(req), req.body); }));
schoolRouter.get(fee + "/concession-totals", finDesk, h((_req, _res, inst) => fe2.concessionTotals(inst)));
schoolRouter.get(fee + "/expense-categories", finDesk, h((_req, _res, inst) => fe3.expenseCategories(inst)));
schoolRouter.post(fee + "/expense-categories", finDesk, h(async (req, res, inst) => { res.status(201); return fe3.addExpenseCategory(inst, req.body); }));
schoolRouter.post(fee + "/expense-defaults", finDesk, h(async (_req, res, inst) => { res.status(201); return fe3.expenseDefaults(inst); }));
schoolRouter.patch(fee + "/expense-categories/:id", finDesk, h((req, _res, inst) => fe3.setExpenseCategory(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/expenses", finDesk, h((_req, _res, inst) => fe3.expenses(inst)));
schoolRouter.post(fee + "/expenses", finDesk, h(async (req, res, inst) => { res.status(201); return fe3.addExpense(inst, req.body, req.user?.profileId); }));
schoolRouter.patch(fee + "/expenses/:id", finDesk, h((req, _res, inst) => fe3.decideExpense(inst, uuid(req), req.body, req.user?.role ?? "")));
schoolRouter.get(fee + "/ledger", finDesk, h((req, _res, inst) => fe3.ledger(inst, typeof req.query.book === "string" ? req.query.book : undefined)));
schoolRouter.get(fee + "/reports", finDesk, h((_req, _res, inst) => fe3.reports(inst)));
schoolRouter.get(fee + "/tally/mapping", finDesk, h((_req, _res, inst) => fe3.ledgerMapping(inst)));
schoolRouter.put(fee + "/tally/mapping", finDesk, h((req, _res, inst) => fe3.saveMapping(inst, req.body)));
schoolRouter.post(fee + "/tally/mapping/standard", finDesk, h((_req, _res, inst) => fe3.standardMapping(inst)));
schoolRouter.get(fee + "/tally/vouchers", finDesk, h((req, _res, inst) => fe3.tallyVouchers(inst, String(req.query.from ?? ""), String(req.query.to ?? ""), String(req.query.type ?? "All"))));
schoolRouter.post(fee + "/tally/exports", finDesk, h(async (req, res, inst) => { res.status(201); return fe3.logExport(inst, req.body, req.user?.profileId); }));
schoolRouter.get(fee + "/tally/exports", finDesk, h((_req, _res, inst) => fe3.exportLog(inst)));
schoolRouter.get(fee + "/canteen", finDesk, h((_req, _res, inst) => fe3.canteen(inst)));
schoolRouter.post(fee + "/canteen", finDesk, h(async (req, res, inst) => { res.status(201); return fe3.addCanteen(inst, req.body, req.user?.profileId); }));
schoolRouter.get(fee + "/concession-types", finDesk, h((_req, _res, inst) => accFees.concessionTypes(inst)));
schoolRouter.get(fee + "/alert-rules", finDesk, h((_req, _res, inst) => fe3.alertRules(inst)));
schoolRouter.put(fee + "/alert-rules", adminOnly, h((req, _res, inst) => fe3.saveAlertRule(inst, req.body)));
schoolRouter.get(fee + "/insights", finDesk, h((_req, _res, inst) => fe3.insights(inst)));
schoolRouter.post(fee + "/insights/review", finDesk, h((req, _res, inst) => fe3.reviewInsight(inst, req.body)));
schoolRouter.get(fee + "/reminder-config", finDesk, h((_req, _res, inst) => fe3.reminderConfig(inst)));
schoolRouter.put(fee + "/reminder-config", adminOnly, h((req, _res, inst) => fe3.saveReminderConfig(inst, req.body)));
schoolRouter.get(fee + "/reminder-queue", finDesk, h((_req, _res, inst) => fe4.reminderQueue(inst)));
schoolRouter.post(fee + "/reminder-queue/hold", finDesk, h((req, _res, inst) => fe4.holdReminder(inst, req.body)));
schoolRouter.post(fee + "/reminder-queue/send", finDesk, h((req, _res, inst) => fe4.sendReminders(inst, req.body, req.user?.profileId)));
schoolRouter.get(fee + "/reminder-log", finDesk, h((_req, _res, inst) => fe4.reminderLog(inst)));
schoolRouter.get(fee + "/reminder-results", finDesk, h((_req, _res, inst) => fe4.reminderResults(inst)));
schoolRouter.get(fee + "/recon/live", finDesk, h((_req, _res, inst) => fe4.reconLive(inst)));
schoolRouter.get(fee + "/recon/settlements", finDesk, h((_req, _res, inst) => fe4.settlements(inst)));
schoolRouter.post(fee + "/recon/settlements", finDesk, h(async (req, res, inst) => { res.status(201); return fe4.recordSettlement(inst, req.body, `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`); }));
schoolRouter.put(fee + "/recon/settlements/:id", finDesk, h((req, _res, inst) => fe4.bankCredit(inst, uuid(req), req.body, `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`)));
schoolRouter.get(fee + "/recon/payments", finDesk, h((_req, _res, inst) => fe4.paymentMatching(inst)));
schoolRouter.get(fee + "/recon/exceptions", finDesk, h((_req, _res, inst) => fe4.exceptions(inst)));
schoolRouter.post(fee + "/recon/exceptions/:id", finDesk, h((req, _res, inst) => fe4.fixException(inst, uuid(req), req.body, `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`, req.user?.profileId)));
schoolRouter.get(fee + "/recon/bank", finDesk, h((_req, _res, inst) => fe4.bankLines(inst)));
schoolRouter.post(fee + "/recon/bank", finDesk, h(async (req, res, inst) => { res.status(201); return fe4.uploadStatement(inst, req.body, `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`); }));
schoolRouter.post(fee + "/recon/bank/:id/confirm", finDesk, h((req, _res, inst) => fe4.confirmLine(inst, uuid(req), `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`)));
schoolRouter.get(fee + "/recon/rules", finDesk, h((_req, _res, inst) => fe4.reconRules(inst)));
schoolRouter.put(fee + "/recon/rules", adminOnly, h((req, _res, inst) => fe4.saveReconRule(inst, req.body, `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`)));
schoolRouter.get(fee + "/recon/audit", finDesk, h((_req, _res, inst) => fe4.reconAudit(inst)));
schoolRouter.get(fee + "/budgets", finDesk, h((_req, _res, inst) => fe4.budgets(inst)));
schoolRouter.post(fee + "/budgets", adminOnly, h(async (req, res, inst) => { res.status(201); return fe4.addBudget(inst, req.body); }));
schoolRouter.patch(fee + "/budgets/:id", finDesk, h((req, _res, inst) => fe4.reviseBudget(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/budget-actual", finDesk, h((_req, _res, inst) => fe4.budgetVsActual(inst)));
schoolRouter.get(fee + "/cash-flow", finDesk, h((_req, _res, inst) => fe4.cashFlow(inst)));
schoolRouter.put(fee + "/cash-flow", adminOnly, h((req, _res, inst) => fe4.saveCashPlan(inst, req.body)));
schoolRouter.get(fee + "/fee-income", finDesk, h((_req, _res, inst) => fe4.feeIncome(inst)));
schoolRouter.get(fee + "/claims", finDesk, h((_req, _res, inst) => fe4.claims(inst)));
schoolRouter.post(fee + "/claims", finDesk, h(async (req, res, inst) => { res.status(201); return fe4.addClaim(inst, req.body); }));
schoolRouter.patch(fee + "/claims/:id", finDesk, h((req, _res, inst) => fe4.moveClaim(inst, uuid(req), req.body, req.user?.role ?? "", req.user?.profileId)));
schoolRouter.get(fee + "/advances", finDesk, h((_req, _res, inst) => fe4.advances(inst)));
schoolRouter.post(fee + "/advances", finDesk, h(async (req, res, inst) => { res.status(201); return fe4.addAdvance(inst, req.body); }));
schoolRouter.patch(fee + "/advances/:id", finDesk, h((req, _res, inst) => fe4.settleAdvance(inst, uuid(req), req.body)));
schoolRouter.get(fee + "/claim-rules", finDesk, h((_req, _res, inst) => fe4.claimRules(inst)));
schoolRouter.get("/hr/directory", adminOnly, h((_req, _res, inst) => hr.directory(inst)));
schoolRouter.patch("/hr/staff/:id", adminOnly, h((req, _res, inst) => hr.updateStaff(inst, uuid(req), req.body)));
schoolRouter.get("/hr/flow", adminOnly, h((_req, _res, inst) => hr2.flow(inst)));
schoolRouter.get("/hr/departments", adminOnly, h((_req, _res, inst) => hr2.departments(inst)));
schoolRouter.post("/hr/departments", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addDepartment(inst, req.body); }));
schoolRouter.post("/hr/departments/from-staff", adminOnly, h(async (_req, res, inst) => { res.status(201); return hr2.departmentsFromStaff(inst); }));
schoolRouter.patch("/hr/departments/:id", adminOnly, h((req, _res, inst) => hr2.setDepartment(inst, uuid(req), req.body)));
schoolRouter.get("/hr/designations", adminOnly, h((_req, _res, inst) => hr2.designations(inst)));
schoolRouter.post("/hr/designations", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addDesignation(inst, req.body); }));
schoolRouter.post("/hr/designations/from-staff", adminOnly, h(async (_req, res, inst) => { res.status(201); return hr2.designationsFromStaff(inst); }));
schoolRouter.patch("/hr/designations/:id", adminOnly, h((req, _res, inst) => hr2.setDesignation(inst, uuid(req), req.body)));
schoolRouter.get("/hr/registration", adminOnly, h((_req, _res, inst) => hr2.registrationLists(inst)));
schoolRouter.post("/hr/employees", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addEmployee(inst, req.body, req.user?.role ?? ""); }));
schoolRouter.post("/hr/employees/bulk", adminOnly, h((req, _res, inst) => hr2.bulkImport(inst, req.body, req.user?.role ?? "")));
schoolRouter.get("/hr/profile/:id", adminOnly, h((req, _res, inst) => hr2.profile(inst, uuid(req))));
schoolRouter.put("/hr/profile/:id", adminOnly, h((req, _res, inst) => hr2.saveProfile(inst, uuid(req), req.body)));
schoolRouter.post("/hr/profile/:id/qualifications", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addQualification(inst, uuid(req), req.body); }));
schoolRouter.post("/hr/profile/:id/experience", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addExperience(inst, uuid(req), req.body); }));
schoolRouter.delete("/hr/qualifications/:id", adminOnly, h((req, _res, inst) => hr2.removeRecord(inst, "qualification", uuid(req))));
schoolRouter.delete("/hr/experience/:id", adminOnly, h((req, _res, inst) => hr2.removeRecord(inst, "experience", uuid(req))));
schoolRouter.get("/hr/openings", adminOnly, h((_req, _res, inst) => hr2.openings(inst)));
schoolRouter.post("/hr/openings", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addOpening(inst, req.body); }));
schoolRouter.patch("/hr/openings/:id", adminOnly, h((req, _res, inst) => hr2.setOpening(inst, uuid(req), req.body)));
schoolRouter.get("/hr/candidates", adminOnly, h((_req, _res, inst) => hr2.candidates(inst)));
schoolRouter.post("/hr/candidates", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.addCandidate(inst, req.body); }));
schoolRouter.post("/hr/candidates/:id/move", adminOnly, h((req, _res, inst) => hr2.moveCandidate(inst, uuid(req), req.body)));
schoolRouter.put("/hr/candidates/:id/demo", adminOnly, h((req, _res, inst) => hr2.setDemo(inst, uuid(req), req.body)));
schoolRouter.get("/hr/interviews", adminOnly, h((_req, _res, inst) => hr2.interviews(inst)));
schoolRouter.post("/hr/interviews", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.scheduleInterview(inst, req.body); }));
schoolRouter.patch("/hr/interviews/:id", adminOnly, h((req, _res, inst) => hr2.finishInterview(inst, uuid(req), req.body)));
schoolRouter.get("/hr/checks", adminOnly, h((_req, _res, inst) => hr2.backgroundChecks(inst)));
schoolRouter.put("/hr/checks/:id", adminOnly, h((req, _res, inst) => hr2.verifyCheck(inst, uuid(req), req.body)));
schoolRouter.get("/hr/offers", adminOnly, h((_req, _res, inst) => hr2.offers(inst)));
schoolRouter.post("/hr/offers", adminOnly, h(async (req, res, inst) => { res.status(201); return hr2.createOffer(inst, req.body, req.user?.role ?? "", req.user?.profileId); }));
schoolRouter.patch("/hr/offers/:id", adminOnly, h((req, _res, inst) => hr2.answerOffer(inst, uuid(req), req.body)));
schoolRouter.get("/hr/leave-types", adminOnly, h((_req, _res, inst) => hr3.leaveTypes(inst)));
schoolRouter.post("/hr/leave-types", adminOnly, h(async (req, res, inst) => { res.status(201); return hr3.addLeaveType(inst, req.body); }));
schoolRouter.patch("/hr/leave-types/:id", adminOnly, h((req, _res, inst) => hr3.setLeaveType(inst, uuid(req), req.body)));
schoolRouter.get("/hr/leave-policy", adminOnly, h((_req, _res, inst) => hr3.leavePolicy(inst)));
schoolRouter.put("/hr/leave-policy", adminOnly, h((req, _res, inst) => hr3.saveLeavePolicy(inst, req.body)));
schoolRouter.get("/hr/leave-approvals", adminOnly, h((_req, _res, inst) => hr3.leaveApprovals(inst)));
schoolRouter.post("/hr/leave-approvals/:id", adminOnly, h((req, _res, inst) => hr3.decideLeaveStep(inst, uuid(req), req.body, req.user?.role ?? "", req.user?.profileId)));
schoolRouter.get("/hr/leave-balance", adminOnly, h((_req, _res, inst) => hr3.leaveBalance(inst)));
schoolRouter.get("/hr/comp-offs", adminOnly, h((_req, _res, inst) => hr3.compOffs(inst)));
schoolRouter.post("/hr/comp-offs", adminOnly, h(async (req, res, inst) => { res.status(201); return hr3.grantCompOff(inst, req.body); }));
schoolRouter.post("/hr/comp-offs/:id/use", adminOnly, h((req, _res, inst) => hr3.useCompOff(inst, uuid(req))));
schoolRouter.get("/hr/documents/:type", adminOnly, h((req, _res, inst) => hr3.documents(inst, String(req.params.type))));
schoolRouter.post("/hr/documents", adminOnly, h(async (req, res, inst) => { res.status(201); return hr3.addDocument(inst, req.body); }));
schoolRouter.post("/hr/documents/:id/verify", adminOnly, h((req, _res, inst) => hr3.verifyDocument(inst, uuid(req))));
schoolRouter.get("/hr/appraisals/:kind", adminOnly, h((req, _res, inst) => hr3.appraisals(inst, String(req.params.kind))));
schoolRouter.post("/hr/appraisals", adminOnly, h(async (req, res, inst) => { res.status(201); return hr3.addAppraisal(inst, req.body); }));
schoolRouter.patch("/hr/appraisals/:id", adminOnly, h((req, _res, inst) => hr3.updateAppraisal(inst, uuid(req), req.body)));
schoolRouter.get("/hr/feedback360", adminOnly, h((_req, _res, inst) => hr3.feedback360(inst)));
schoolRouter.put("/hr/feedback360/:id", adminOnly, h((req, _res, inst) => hr3.saveFeedback360(inst, uuid(req), req.body)));
schoolRouter.get("/hr/competency/:id", adminOnly, h((req, _res, inst) => hr3.competency(inst, uuid(req))));
schoolRouter.put("/hr/competency/:id", adminOnly, h((req, _res, inst) => hr3.saveCompetency(inst, uuid(req), req.body)));
schoolRouter.get("/hr/cycle", adminOnly, h((_req, _res, inst) => hr3.cycle(inst)));
schoolRouter.post("/hr/cycle/start", adminOnly, h(async (req, res, inst) => { res.status(201); return hr3.startCycle(inst, req.user?.fullName ?? "Principal"); }));
schoolRouter.put("/hr/cycle/:id", adminOnly, h((req, _res, inst) => hr3.scoreCycle(inst, uuid(req), req.body)));
schoolRouter.get("/hr/increments", adminOnly, h((_req, _res, inst) => hr3.increments(inst)));
schoolRouter.put("/hr/increments/:id", adminOnly, h((req, _res, inst) => hr3.saveIncrement(inst, uuid(req), req.body)));
schoolRouter.post("/hr/increments/send", adminOnly, h((_req, _res, inst) => hr3.sendIncrements(inst)));
schoolRouter.get("/hr/kras/:group", adminOnly, h((req, _res, inst) => hr3.kras(inst, String(req.params.group))));
schoolRouter.post("/hr/kras", adminOnly, h(async (req, res, inst) => { res.status(201); return hr3.addKra(inst, req.body); }));
schoolRouter.delete("/hr/kras/:id", adminOnly, h((req, _res, inst) => hr3.removeKra(inst, uuid(req))));
schoolRouter.get("/hr/exits", adminOnly, h((req, _res, inst) => hr4.exits(inst)));
schoolRouter.post("/hr/exits", adminOnly, h(async (req, res, inst) => { res.status(201); return hr4.addExit(inst, req.body); }));
schoolRouter.post("/hr/exits/:id/decide", adminOnly, h((req, _res, inst) => hr4.decideExit(inst, uuid(req), req.body)));
schoolRouter.post("/hr/exits/:id/relieve", adminOnly, h((req, _res, inst) => hr4.relieve(inst, uuid(req))));
schoolRouter.get("/hr/clearance", adminOnly, h((req, _res, inst) => hr4.clearance(inst)));
schoolRouter.post("/hr/clearance/:id", adminOnly, h((req, _res, inst) => hr4.clearDept(inst, uuid(req), req.body)));
schoolRouter.get("/hr/full-and-final", adminOnly, h((req, _res, inst) => hr4.fullAndFinal(inst)));
schoolRouter.get("/hr/profile360/:id", adminOnly, h((req, _res, inst) => hr4.profile360(inst, uuid(req))));
schoolRouter.post("/hr/profile360/:id/salary", adminOnly, h((req, _res, inst) => hr4.reviseSalary(inst, uuid(req), req.body)));
schoolRouter.get("/hr/analytics", adminOnly, h((req, _res, inst) => hr4.analytics(inst)));
schoolRouter.get("/hr/compliance", adminOnly, h((req, _res, inst) => hr4.compliance(inst)));
schoolRouter.post("/hr/compliance/seed", adminOnly, h(async (_req, res, inst) => { res.status(201); return hr4.seedCompliance(inst); }));
schoolRouter.post("/hr/compliance/:id/file", adminOnly, h((req, _res, inst) => hr4.fileCompliance(inst, uuid(req), req.body)));
schoolRouter.get("/hr/scheduled", adminOnly, h((req, _res, inst) => hr4.scheduled(inst)));
schoolRouter.post("/hr/scheduled", adminOnly, h(async (req, res, inst) => { res.status(201); return hr4.addScheduled(inst, req.body); }));
schoolRouter.post("/hr/scheduled/:id", adminOnly, h((req, _res, inst) => hr4.actScheduled(inst, uuid(req), req.body)));
schoolRouter.get("/hr/vacancies", adminOnly, h((req, _res, inst) => hr4.vacancies(inst)));
schoolRouter.post("/hr/vacancies", adminOnly, h(async (req, res, inst) => { res.status(201); return hr4.addVacancy(inst, req.body, `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`); }));
schoolRouter.post("/hr/vacancies/:id", adminOnly, h((req, _res, inst) => hr4.moveVacancy(inst, uuid(req), req.body, req.user?.role ?? "")));
schoolRouter.get("/hr/sanctioned", adminOnly, h((req, _res, inst) => hr4.sanctioned(inst)));
schoolRouter.post("/hr/sanctioned", adminOnly, h(async (req, res, inst) => { res.status(201); return hr4.addSanctioned(inst, req.body); }));
schoolRouter.get("/pay/heads", adminOnly, h((req, _res, inst) => pay.heads(inst, typeof req.query.type === "string" ? req.query.type : undefined)));
schoolRouter.post("/pay/heads", adminOnly, h(async (req, res, inst) => { res.status(201); return pay.addHead(inst, req.body); }));
schoolRouter.patch("/pay/heads/:id", adminOnly, h((req, _res, inst) => pay.setHead(inst, uuid(req), req.body)));
schoolRouter.get("/pay/structures", adminOnly, h((req, _res, inst) => pay.structures(inst)));
schoolRouter.put("/pay/assign", adminOnly, h((req, _res, inst) => pay.assignStructure(inst, req.body)));
schoolRouter.put("/pay/assign-employee", adminOnly, h((req, _res, inst) => pay.assignEmployee(inst, req.body)));
schoolRouter.put("/pay/other-deduction/:id", adminOnly, h((req, _res, inst) => pay.setOtherDeduction(inst, uuid(req), req.body)));
schoolRouter.get("/pay/attendance", adminOnly, h((req, _res, inst) => pay.attendanceCalc(inst, String(req.query.month ?? ""))));
schoolRouter.get("/pay/runs", adminOnly, h((req, _res, inst) => pay.runs(inst)));
schoolRouter.post("/pay/calculate", adminOnly, h((req, _res, inst) => pay.calculate(inst, req.body)));
schoolRouter.get("/pay/runs/:id", adminOnly, h((req, _res, inst) => pay.runLines(inst, uuid(req))));
schoolRouter.get("/hr/probation", adminOnly, h((req, _res, inst) => pay.probation(inst)));
schoolRouter.post("/hr/probation", adminOnly, h(async (req, res, inst) => { res.status(201); return pay.addProbation(inst, req.body); }));
schoolRouter.post("/hr/probation/:id", adminOnly, h((req, _res, inst) => pay.decideProbation(inst, uuid(req), req.body)));
schoolRouter.get("/hr/joiners", adminOnly, h((req, _res, inst) => pay.joiners(inst)));
schoolRouter.post("/hr/joiners/:id", adminOnly, h((req, _res, inst) => pay.tick(inst, uuid(req), req.body)));
schoolRouter.get("/pay/approval", adminOnly, h((req, _res, inst) => pay2.approval(inst)));
schoolRouter.post("/pay/approval", adminOnly, h((req, _res, inst) => pay2.decideRun(inst, req.body, req.user?.role ?? "", `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`)));
schoolRouter.get("/pay/history", adminOnly, h((req, _res, inst) => pay2.history(inst)));
schoolRouter.get("/pay/payslips", adminOnly, h((req, _res, inst) => pay2.payslips(inst, String(req.query.month ?? ""))));
schoolRouter.post("/pay/payslips/share", adminOnly, h((req, _res, inst) => pay2.sharePayslips(inst, req.body)));
schoolRouter.get("/pay/payments", adminOnly, h((req, _res, inst) => pay2.payments(inst, req.query.failed === "1")));
schoolRouter.post("/pay/payments", adminOnly, h((req, _res, inst) => pay2.recordPayments(inst, req.body, req.user?.role ?? "", `${req.user?.fullName ?? "Staff"} (${req.user?.roleDisplayName ?? req.user?.role ?? ""})`)));
schoolRouter.patch("/pay/payments/:id", adminOnly, h((req, _res, inst) => pay2.updatePayment(inst, uuid(req), req.body)));
schoolRouter.get("/pay/annual", adminOnly, h((req, _res, inst) => pay2.annual(inst, String(req.query.year ?? ""))));
schoolRouter.get("/pay/deduction-report", adminOnly, h((req, _res, inst) => pay2.deductionReport(inst)));
schoolRouter.get("/pay/settings", adminOnly, h((req, _res, inst) => pay2.settings(inst)));
schoolRouter.put("/pay/settings", adminOnly, h((req, _res, inst) => pay2.saveSettings(inst, req.body)));
schoolRouter.get("/pay/bank-file", adminOnly, h((req, _res, inst) => pay2.bankFile(inst, String(req.query.month ?? ""))));
schoolRouter.get("/pay/pf-ecr", adminOnly, h((req, _res, inst) => pay2.pfEcr(inst, String(req.query.month ?? ""))));
schoolRouter.get("/pay/esi-file", adminOnly, h((req, _res, inst) => pay2.esiFile(inst, String(req.query.month ?? ""))));
schoolRouter.get("/pay/pt-tds", adminOnly, h((req, _res, inst) => pay2.ptTds(inst, String(req.query.month ?? ""))));
schoolRouter.get("/pay/bank/:id", adminOnly, h((req, _res, inst) => pay2.staffBank(inst, uuid(req))));
schoolRouter.put("/pay/bank/:id", adminOnly, h((req, _res, inst) => pay2.setBank(inst, uuid(req), req.body)));
schoolRouter.get("/tr/vehicles", adminOnly, h((req, _res, inst) => pay2.vehicles(inst)));
schoolRouter.post("/tr/vehicles", adminOnly, h(async (req, res, inst) => { res.status(201); return pay2.addVehicle(inst, req.body); }));
schoolRouter.patch("/tr/vehicles/:id", adminOnly, h((req, _res, inst) => pay2.setVehicle(inst, uuid(req), req.body)));
schoolRouter.post("/tr/vehicle-docs", adminOnly, h(async (req, res, inst) => { res.status(201); return pay2.addVehicleDoc(inst, req.body); }));
schoolRouter.get("/tr/routes", adminOnly, h((req, _res, inst) => tr.routes(inst)));
schoolRouter.post("/tr/routes", adminOnly, h(async (req, res, inst) => { res.status(201); return tr.addRoute(inst, req.body); }));
schoolRouter.patch("/tr/routes/:id", adminOnly, h((req, _res, inst) => tr.setRoute(inst, uuid(req), req.body)));
schoolRouter.get("/tr/routes/:id", adminOnly, h((req, _res, inst) => tr.routeDetail(inst, uuid(req))));
schoolRouter.get("/tr/stops", adminOnly, h((req, _res, inst) => tr.stops(inst)));
schoolRouter.post("/tr/stops", adminOnly, h(async (req, res, inst) => { res.status(201); return tr.addStop(inst, req.body); }));
schoolRouter.patch("/tr/stops/:id", adminOnly, h((req, _res, inst) => tr.setStop(inst, uuid(req), req.body)));
schoolRouter.get("/tr/drivers", adminOnly, h((req, _res, inst) => tr.drivers(inst)));
schoolRouter.post("/tr/drivers", adminOnly, h(async (req, res, inst) => { res.status(201); return tr.addDriver(inst, req.body); }));
schoolRouter.patch("/tr/drivers/:id", adminOnly, h((req, _res, inst) => tr.setDriver(inst, uuid(req), req.body)));
schoolRouter.get("/tr/attendants", adminOnly, h((req, _res, inst) => tr.attendants(inst)));
schoolRouter.post("/tr/attendants", adminOnly, h(async (req, res, inst) => { res.status(201); return tr.addAttendant(inst, req.body); }));
schoolRouter.patch("/tr/attendants/:id", adminOnly, h((req, _res, inst) => tr.setAttendant(inst, uuid(req), req.body)));
schoolRouter.get("/tr/allocations", adminOnly, h((req, _res, inst) => tr.allocations(inst)));
schoolRouter.post("/tr/allocations", adminOnly, h((req, _res, inst) => tr.assign(inst, req.body)));
schoolRouter.patch("/tr/allocations/:id", adminOnly, h((req, _res, inst) => tr.changeAllocation(inst, uuid(req), req.body)));
schoolRouter.get("/tr/fees", adminOnly, h((req, _res, inst) => tr.fees(inst)));
schoolRouter.get("/tr/trips", adminOnly, h((req, _res, inst) => tr2.trips(inst)));
schoolRouter.get("/tr/live", adminOnly, h((req, _res, inst) => tr2.live(inst)));
schoolRouter.get("/tr/driver-trip/:id", adminOnly, h((req, _res, inst) => tr2.driverTrip(inst, uuid(req))));
schoolRouter.post("/tr/trips/start/:id", adminOnly, h(async (req, res, inst) => { res.status(201); return tr2.startTrip(inst, uuid(req)); }));
schoolRouter.post("/tr/trips/:id/arrive", adminOnly, h((req, _res, inst) => tr2.arrive(inst, uuid(req), req.body)));
schoolRouter.get("/tr/roster/:id", adminOnly, h((req, _res, inst) => tr2.busRoster(inst, uuid(req), String(req.query.type ?? ""))));
schoolRouter.post("/tr/boardings", adminOnly, h((req, _res, inst) => tr2.markBoarding(inst, req.body)));
schoolRouter.get("/tr/missed", adminOnly, h((req, _res, inst) => tr2.missed(inst)));
schoolRouter.get("/tr/maintenance", adminOnly, h((req, _res, inst) => tr2.maintenance(inst, req.query.type ? String(req.query.type ?? "") : undefined)));
schoolRouter.post("/tr/maintenance", adminOnly, h(async (req, res, inst) => { res.status(201); return tr2.addMaintenance(inst, req.body); }));
schoolRouter.patch("/tr/maintenance/:id", adminOnly, h((req, _res, inst) => tr2.setMaintenance(inst, uuid(req), req.body)));
schoolRouter.get("/tr/settings", adminOnly, h((req, _res, inst) => tr2.trSettings(inst)));
schoolRouter.put("/tr/settings", adminOnly, h((req, _res, inst) => tr2.saveTrSettings(inst, req.body)));
schoolRouter.get("/tr/planner", adminOnly, h((req, _res, inst) => tr2.planner(inst, Math.max(1, Number(req.query.seats) || 48), Number(req.query.longest) || 50)));
schoolRouter.get("/lib/books", adminOnly, h((req, _res, inst) => tr2.books(inst)));
schoolRouter.post("/lib/books", adminOnly, h(async (req, res, inst) => { res.status(201); return tr2.addBook(inst, req.body); }));
schoolRouter.put("/lib/books/:id", adminOnly, h((req, _res, inst) => tr2.updateBook(inst, uuid(req), req.body)));
schoolRouter.get("/lib/categories", adminOnly, h((req, _res, inst) => lib.categories(inst)));
schoolRouter.post("/lib/categories", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.addCategory(inst, req.body); }));
schoolRouter.post("/lib/categories/from-books", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.categoriesFromBooks(inst); }));
schoolRouter.patch("/lib/categories/:id", adminOnly, h((req, _res, inst) => lib.setCategory(inst, uuid(req), req.body)));
schoolRouter.get("/lib/publishers", adminOnly, h((req, _res, inst) => lib.publishers(inst)));
schoolRouter.post("/lib/publishers", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.addPublisher(inst, req.body); }));
schoolRouter.post("/lib/publishers/from-books", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.publishersFromBooks(inst); }));
schoolRouter.patch("/lib/publishers/:id", adminOnly, h((req, _res, inst) => lib.setPublisher(inst, uuid(req), req.body)));
schoolRouter.get("/lib/authors", adminOnly, h((req, _res, inst) => lib.authors(inst)));
schoolRouter.post("/lib/authors", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.addAuthor(inst, req.body); }));
schoolRouter.post("/lib/authors/from-books", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.authorsFromBooks(inst); }));
schoolRouter.patch("/lib/authors/:id", adminOnly, h((req, _res, inst) => lib.setAuthor(inst, uuid(req), req.body)));
schoolRouter.get("/lib/copies", adminOnly, h((req, _res, inst) => lib.copies(inst)));
schoolRouter.post("/lib/copies", adminOnly, h(async (req, res, inst) => { res.status(201); return lib.addCopies(inst, req.body); }));
schoolRouter.patch("/lib/copies/:id", adminOnly, h((req, _res, inst) => lib.setCopy(inst, uuid(req), req.body)));
schoolRouter.get("/lib/settings", adminOnly, h((req, _res, inst) => lb2.settings(inst)));
schoolRouter.put("/lib/settings", adminOnly, h((req, _res, inst) => lb2.saveSettings(inst, req.body)));
schoolRouter.get("/lib/members/:kind", adminOnly, h((req, _res, inst) => lb2.members(inst, String(req.params.kind))));
schoolRouter.post("/lib/members", adminOnly, h(async (req, res, inst) => { res.status(201); return lb2.addMember(inst, req.body); }));
schoolRouter.post("/lib/members/enrol/:kind", adminOnly, h(async (req, res, inst) => { res.status(201); return lb2.enrolAll(inst, String(req.params.kind)); }));
schoolRouter.patch("/lib/members/:id", adminOnly, h((req, _res, inst) => lb2.setMember(inst, uuid(req), req.body)));
schoolRouter.get("/lib/issues", adminOnly, h((req, _res, inst) => lb2.issues(inst, req.query.view ? String(req.query.view) : undefined)));
schoolRouter.get("/lib/issue-form", adminOnly, h((req, _res, inst) => lb2.issueForm(inst)));
schoolRouter.post("/lib/issues", adminOnly, h(async (req, res, inst) => { res.status(201); return lb2.issueBook(inst, req.body); }));
schoolRouter.post("/lib/issues/:id/return", adminOnly, h((req, _res, inst) => lb2.returnBook(inst, uuid(req))));
schoolRouter.post("/lib/issues/:id/renew", adminOnly, h((req, _res, inst) => lb2.renew(inst, uuid(req))));
schoolRouter.post("/lib/issues/:id/lost", adminOnly, h((req, _res, inst) => lb2.markLost(inst, uuid(req))));
schoolRouter.get("/lib/reservations", adminOnly, h((req, _res, inst) => lb2.reservations(inst)));
schoolRouter.post("/lib/reservations", adminOnly, h(async (req, res, inst) => { res.status(201); return lb2.addReservation(inst, req.body); }));
schoolRouter.post("/lib/reservations/:id/cancel", adminOnly, h((req, _res, inst) => lb2.cancelReservation(inst, uuid(req))));
schoolRouter.get("/lib/fines", adminOnly, h((req, _res, inst) => lb2.fines(inst)));
schoolRouter.patch("/lib/fines/:id", adminOnly, h((req, _res, inst) => lb2.settleFine(inst, uuid(req), req.body)));
schoolRouter.get("/inv/item-categories", adminOnly, h((req, _res, inst) => lb2.itemCategories(inst)));
schoolRouter.post("/inv/item-categories", adminOnly, h(async (req, res, inst) => { res.status(201); return lb2.addItemCategory(inst, req.body); }));
schoolRouter.patch("/inv/item-categories/:id", adminOnly, h((req, _res, inst) => lb2.setItemCategory(inst, uuid(req), req.body)));
schoolRouter.get("/inv/items", adminOnly, h((req, _res, inst) => lb2.items(inst)));
schoolRouter.post("/inv/items", adminOnly, h(async (req, res, inst) => { res.status(201); return lb2.addItem(inst, req.body); }));
schoolRouter.put("/inv/items/:id", adminOnly, h((req, _res, inst) => lb2.updateItem(inst, uuid(req), req.body)));
schoolRouter.get("/inv/suppliers", adminOnly, h((req, _res, inst) => iv.suppliers(inst)));
schoolRouter.post("/inv/suppliers", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.addSupplier(inst, req.body); }));
schoolRouter.patch("/inv/suppliers/:id", adminOnly, h((req, _res, inst) => iv.setSupplier(inst, uuid(req), req.body)));
schoolRouter.get("/inv/requests", adminOnly, h((req, _res, inst) => iv.requests(inst)));
schoolRouter.post("/inv/requests", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.addRequest(inst, req.body); }));
schoolRouter.patch("/inv/requests/:id", adminOnly, h((req, _res, inst) => iv.decideRequest(inst, uuid(req), req.body)));
schoolRouter.get("/inv/orders", adminOnly, h((req, _res, inst) => iv.orders(inst)));
schoolRouter.post("/inv/orders", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.createOrder(inst, req.body); }));
schoolRouter.post("/inv/orders/:id/decide", adminOnly, h((req, _res, inst) => iv.decideOrder(inst, uuid(req), req.body)));
schoolRouter.get("/inv/receipts", adminOnly, h((req, _res, inst) => iv.receipts(inst)));
schoolRouter.post("/inv/receipts", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.receive(inst, req.body); }));
schoolRouter.get("/inv/adjustments", adminOnly, h((req, _res, inst) => iv.adjustments(inst)));
schoolRouter.post("/inv/adjustments", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.addAdjustment(inst, req.body); }));
schoolRouter.post("/inv/adjustments/:id/decide", adminOnly, h((req, _res, inst) => iv.decideAdjustment(inst, uuid(req), req.body)));
schoolRouter.get("/inv/stock-issues/:kind", adminOnly, h((req, _res, inst) => iv.stockIssues(inst, String(req.params.kind))));
schoolRouter.post("/inv/stock-issues", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.issueStock(inst, req.body); }));
schoolRouter.get("/inv/assets", adminOnly, h((req, _res, inst) => iv.assets(inst)));
schoolRouter.post("/inv/assets", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.addAsset(inst, req.body); }));
schoolRouter.patch("/inv/assets/:id", adminOnly, h((req, _res, inst) => iv.updateAsset(inst, uuid(req), req.body)));
schoolRouter.get("/inv/upkeep/:kind", adminOnly, h((req, _res, inst) => iv.upkeep(inst, String(req.params.kind))));
schoolRouter.post("/inv/upkeep", adminOnly, h(async (req, res, inst) => { res.status(201); return iv.addUpkeep(inst, req.body); }));
schoolRouter.post("/inv/upkeep/:id/done", adminOnly, h((req, _res, inst) => iv.finishUpkeep(inst, uuid(req))));
schoolRouter.get("/inv/vendors", adminOnly, h((req, _res, inst) => iv2.vendors(inst)));
schoolRouter.put("/inv/vendors/:id", adminOnly, h((req, _res, inst) => iv2.saveVendor(inst, uuid(req), req.body)));
schoolRouter.post("/inv/vendors/:id/action", adminOnly, h((req, _res, inst) => iv2.vendorAction(inst, uuid(req), req.body)));
schoolRouter.get("/inv/scorecards", adminOnly, h((req, _res, inst) => iv2.scorecards(inst)));
schoolRouter.get("/inv/rfqs", adminOnly, h((req, _res, inst) => iv2.rfqs(inst)));
schoolRouter.post("/inv/rfqs", adminOnly, h(async (req, res, inst) => { res.status(201); return iv2.addRfq(inst, req.body); }));
schoolRouter.post("/inv/quotes", adminOnly, h(async (req, res, inst) => { res.status(201); return iv2.addQuote(inst, req.body); }));
schoolRouter.post("/inv/rfqs/:id/award", adminOnly, h((req, _res, inst) => iv2.award(inst, uuid(req), req.body)));
schoolRouter.get("/inv/bills", adminOnly, h((req, _res, inst) => iv2.bills(inst)));
schoolRouter.post("/inv/bills", adminOnly, h(async (req, res, inst) => { res.status(201); return iv2.addBill(inst, req.body); }));
schoolRouter.post("/inv/bills/:id/decide", adminOnly, h((req, _res, inst) => iv2.decideBill(inst, uuid(req), req.body)));
schoolRouter.get("/inv/store", adminOnly, h((req, _res, inst) => iv2.storeReport(inst)));
schoolRouter.post("/inv/store", adminOnly, h(async (req, res, inst) => { res.status(201); return iv2.addStoreBill(inst, req.body); }));
schoolRouter.get("/comm/circulars", adminOnly, h((req, _res, inst) => cm.circulars(inst)));
schoolRouter.post("/comm/circulars", adminOnly, h(async (req, res, inst) => { res.status(201); return cm.addCircular(inst, req.body); }));
schoolRouter.post("/comm/circulars/:id/decide", adminOnly, h((req, _res, inst) => cm.decideCircular(inst, uuid(req), req.body)));
schoolRouter.get("/comm/announcements", adminOnly, h((req, _res, inst) => cm.announcements(inst)));
schoolRouter.post("/comm/announcements", adminOnly, h(async (req, res, inst) => { res.status(201); return cm.addAnnouncement(inst, req.body); }));
schoolRouter.post("/comm/announcements/:id/decide", adminOnly, h((req, _res, inst) => cm.decideAnnouncement(inst, uuid(req), req.body)));
schoolRouter.get("/comm/notices", adminOnly, h((req, _res, inst) => cm.notices(inst)));
schoolRouter.post("/comm/notices", adminOnly, h(async (req, res, inst) => { res.status(201); return cm.addNotice(inst, req.body); }));
schoolRouter.get("/comm/templates", adminOnly, h((req, _res, inst) => cm.templates(inst)));
schoolRouter.post("/comm/templates/:id/status", adminOnly, h((req, _res, inst) => cm.templateStatus(inst, uuid(req), req.body)));
schoolRouter.get("/comm/options", adminOnly, h((req, _res, inst) => cm.composeOptions(inst)));
schoolRouter.get("/comm/messages/:channel", adminOnly, h((req, _res, inst) => cm.messages(inst, String(req.params.channel))));
schoolRouter.post("/comm/messages", adminOnly, h(async (req, res, inst) => { res.status(201); return cm.sendMessage(inst, req.body); }));
schoolRouter.get("/comm/diary", adminOnly, h((req, _res, inst) => cm2.diary(inst)));
schoolRouter.post("/comm/diary", adminOnly, h(async (req, res, inst) => { res.status(201); return cm2.addDiary(inst, req.body); }));
schoolRouter.post("/comm/diary/:id/ack", adminOnly, h((req, _res, inst) => cm2.ackDiary(inst, uuid(req))));
schoolRouter.post("/comm/diary-templates", adminOnly, h(async (req, res, inst) => { res.status(201); return cm2.addDiaryTemplate(inst, req.body); }));
schoolRouter.put("/comm/diary-templates/:id", adminOnly, h((req, _res, inst) => cm2.editDiaryTemplate(inst, uuid(req), req.body)));
schoolRouter.get("/comm/conversations", adminOnly, h((req, _res, inst) => cm2.conversations(inst)));
schoolRouter.get("/comm/all-messages", adminOnly, h((req, _res, inst) => cm2.allMessages(inst)));
schoolRouter.get("/comm/chatbot", adminOnly, h((req, _res, inst) => cm2.chatbot(inst)));
schoolRouter.post("/comm/chatbot/unanswered/:id/answer", adminOnly, h((req, _res, inst) => cm2.answerUnanswered(inst, uuid(req), req.body)));
schoolRouter.patch("/comm/chatbot/faqs/:id", adminOnly, h((req, _res, inst) => cm2.editFaq(inst, uuid(req), req.body)));
schoolRouter.get("/comm/albums", adminOnly, h((req, _res, inst) => cm2.albums(inst)));
schoolRouter.post("/comm/albums", adminOnly, h(async (req, res, inst) => { res.status(201); return cm2.addAlbum(inst, req.body); }));
schoolRouter.post("/comm/albums/:id/decide", adminOnly, h((req, _res, inst) => cm2.decideAlbum(inst, uuid(req), req.body)));
schoolRouter.get("/comm/consent", adminOnly, h((req, _res, inst) => cm2.consent(inst)));
schoolRouter.post("/comm/consent/:id/received", adminOnly, h((req, _res, inst) => cm2.consentReceived(inst, uuid(req))));
schoolRouter.get("/comm/chat-reports", adminOnly, h((req, _res, inst) => cm2.chatReports(inst)));
schoolRouter.post("/comm/chat-reports/:id/decide", adminOnly, h((req, _res, inst) => cm2.decideChatReport(inst, uuid(req), req.body)));
schoolRouter.get("/comm/chat-rules", adminOnly, h((req, _res, inst) => cm2.chatRules(inst)));
schoolRouter.put("/comm/chat-rules", adminOnly, h((req, _res, inst) => cm2.saveChatRules(inst, req.body)));
schoolRouter.get("/comm/chat-activity", adminOnly, h((req, _res, inst) => cm2.chatActivity(inst)));
schoolRouter.get("/comm/surveys", adminOnly, h((req, _res, inst) => sv.surveys(inst)));
schoolRouter.post("/comm/surveys", adminOnly, h(async (req, res, inst) => { res.status(201); return sv.createSurvey(inst, req.body); }));
schoolRouter.post("/comm/surveys/:id/schedule", adminOnly, h((req, _res, inst) => sv.scheduleSurvey(inst, uuid(req))));
schoolRouter.get("/comm/surveys/:id/results", adminOnly, h((req, _res, inst) => sv.results(inst, uuid(req))));
schoolRouter.get("/comm/teacher-feedback", adminOnly, h((req, _res, inst) => sv.teacherFeedback(inst)));
schoolRouter.get("/hostel/hostels", adminOnly, h((req, _res, inst) => ho.hostels(inst)));
schoolRouter.post("/hostel/hostels", adminOnly, h(async (req, res, inst) => { res.status(201); return ho.addHostel(inst, req.body); }));
schoolRouter.get("/hostel/buildings", adminOnly, h((req, _res, inst) => ho.buildings(inst)));
schoolRouter.get("/hostel/rooms", adminOnly, h((req, _res, inst) => ho.rooms(inst)));
schoolRouter.patch("/hostel/rooms/:id", adminOnly, h((req, _res, inst) => ho.setMaintenance(inst, uuid(req), req.body)));
schoolRouter.patch("/hostel/room-types/:name", adminOnly, h((req, _res, inst) => ho.editRoomType(inst, String(req.params.name), req.body)));
schoolRouter.get("/hostel/beds", adminOnly, h((req, _res, inst) => ho.beds(inst)));
schoolRouter.get("/hostel/allocations", adminOnly, h((req, _res, inst) => ho.allocations(inst)));
schoolRouter.post("/hostel/allocations", adminOnly, h(async (req, res, inst) => { res.status(201); return ho.allocate(inst, req.body); }));
schoolRouter.post("/hostel/allocations/:id/action", adminOnly, h((req, _res, inst) => ho.allocationAction(inst, uuid(req), req.body)));
schoolRouter.get("/hostel/attendance", adminOnly, h((req, _res, inst) => ho.attendance(inst)));
schoolRouter.post("/hostel/attendance/roll-call", adminOnly, h((req, _res, inst) => ho.rollCall(inst)));
schoolRouter.post("/hostel/attendance/out", adminOnly, h(async (req, res, inst) => { res.status(201); return ho.recordOut(inst, req.body); }));
schoolRouter.post("/hostel/attendance/:id/returned", adminOnly, h((req, _res, inst) => ho.markReturned(inst, uuid(req))));
schoolRouter.get("/hostel/meal-plans", adminOnly, h((req, _res, inst) => ho.mealPlans(inst)));
schoolRouter.patch("/hostel/meal-plans/:id", adminOnly, h((req, _res, inst) => ho.editPlan(inst, uuid(req), req.body)));
schoolRouter.get("/hostel/menu", adminOnly, h((req, _res, inst) => ho.menu(inst)));
schoolRouter.put("/hostel/menu", adminOnly, h((req, _res, inst) => ho.saveMenu(inst, req.body)));
schoolRouter.get("/hostel/day-scholars", adminOnly, h((req, _res, inst) => ho.dayScholars(inst)));
schoolRouter.post("/hostel/day-scholars", adminOnly, h((req, _res, inst) => ho.startMess(inst, req.body)));
schoolRouter.post("/hostel/day-scholars/:id/stop", adminOnly, h((req, _res, inst) => ho.stopMess(inst, uuid(req))));
schoolRouter.get("/hostel/mess-requests", adminOnly, h((req, _res, inst) => ho.messRequests(inst)));
schoolRouter.post("/hostel/mess-requests/:id/decide", adminOnly, h((req, _res, inst) => ho.decideRequest(inst, uuid(req), req.body)));
schoolRouter.get("/hostel/charges", adminOnly, h((req, _res, inst) => ho.charges(inst)));
schoolRouter.get("/hostel/complaints", adminOnly, h((req, _res, inst) => cam.complaints(inst)));
schoolRouter.post("/hostel/complaints", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addComplaint(inst, req.body); }));
schoolRouter.post("/hostel/complaints/:id/action", adminOnly, h((req, _res, inst) => cam.complaintAction(inst, uuid(req), req.body)));
schoolRouter.get("/hostel/fees", adminOnly, h((req, _res, inst) => cam.hostelFees(inst)));
schoolRouter.get("/hostel/canteen", adminOnly, h((req, _res, inst) => cam.canteen(inst)));
schoolRouter.get("/hostel/canteen/card/:id", adminOnly, h((req, _res, inst) => cam.canteenCard(inst, uuid(req))));
schoolRouter.post("/hostel/canteen/items", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addCanteenItem(inst, req.body); }));
schoolRouter.post("/hostel/canteen/wallet/:id", adminOnly, h((req, _res, inst) => cam.topUp(inst, uuid(req), req.body)));
schoolRouter.post("/hostel/canteen/sell", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.sell(inst, req.body); }));
schoolRouter.get("/hostel/day-menu", adminOnly, h((req, _res, inst) => cam.dayMenu(inst, typeof req.query.from === "string" ? req.query.from : undefined)));
schoolRouter.put("/hostel/day-menu", adminOnly, h((req, _res, inst) => cam.saveDayMenu(inst, req.body)));
schoolRouter.post("/hostel/day-menu/publish", adminOnly, h((req, _res, inst) => cam.publishDayMenu(inst, req.body)));
schoolRouter.get("/visitors/list", adminOnly, h((req, _res, inst) => cam.visitors(inst)));
schoolRouter.post("/visitors/list", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addVisitor(inst, req.body); }));
schoolRouter.post("/visitors/list/:id/action", adminOnly, h((req, _res, inst) => cam.visitorAction(inst, uuid(req), req.body)));
schoolRouter.get("/visitors/gate-passes/:kind", adminOnly, h((req, _res, inst) => cam.gatePasses(inst, String(req.params.kind))));
schoolRouter.post("/visitors/gate-passes", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addGatePass(inst, req.body); }));
schoolRouter.post("/visitors/gate-passes/:id/action", adminOnly, h((req, _res, inst) => cam.gatePassAction(inst, uuid(req), req.body)));
schoolRouter.get("/visitors/incidents", adminOnly, h((req, _res, inst) => cam.incidents(inst)));
schoolRouter.post("/visitors/incidents", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addIncident(inst, req.body); }));
schoolRouter.patch("/visitors/incidents/:id", adminOnly, h((req, _res, inst) => cam.setIncident(inst, uuid(req), req.body)));
schoolRouter.get("/visitors/emergency", adminOnly, h((req, _res, inst) => cam.emergencyContacts(inst)));
schoolRouter.patch("/visitors/emergency/:id", adminOnly, h((req, _res, inst) => cam.editContact(inst, uuid(req), req.body)));
schoolRouter.get("/health/profiles", adminOnly, h((req, _res, inst) => cam.health(inst)));
schoolRouter.put("/health/profiles/:id", adminOnly, h((req, _res, inst) => cam.saveHealth(inst, uuid(req), req.body)));
schoolRouter.put("/health/vaccines/:id", adminOnly, h((req, _res, inst) => cam.saveVaccines(inst, uuid(req), req.body)));
schoolRouter.post("/health/vaccines/:id/remind", adminOnly, h((req, _res, inst) => cam.remindParent(inst, uuid(req))));
schoolRouter.post("/health/updates/:id/decide", adminOnly, h((req, _res, inst) => cam.decideHealthUpdate(inst, uuid(req), req.body)));
schoolRouter.get("/health/visits", adminOnly, h((req, _res, inst) => cam.medicalVisits(inst)));
schoolRouter.post("/health/visits", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addVisit(inst, req.body); }));
schoolRouter.post("/health/visits/:id/status", adminOnly, h((req, _res, inst) => cam.setVisit(inst, uuid(req), req.body)));
schoolRouter.get("/health/first-aid", adminOnly, h((req, _res, inst) => cam.firstAid(inst)));
schoolRouter.post("/health/first-aid", adminOnly, h(async (req, res, inst) => { res.status(201); return cam.addFirstAid(inst, req.body); }));
schoolRouter.post("/health/first-aid/:id/status", adminOnly, h((req, _res, inst) => cam.setFirstAid(inst, uuid(req), req.body)));
schoolRouter.get("/health/records", adminOnly, h((req, _res, inst) => h2.healthRecords(inst)));
schoolRouter.get("/health/screenings", adminOnly, h((req, _res, inst) => h2.screenings(inst)));
schoolRouter.post("/health/screenings", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.addScreening(inst, req.body); }));
schoolRouter.get("/health/medication", adminOnly, h((req, _res, inst) => h2.medication(inst)));
schoolRouter.post("/health/medication", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.addMedication(inst, req.body); }));
schoolRouter.post("/health/medication/:id/dose", adminOnly, h((req, _res, inst) => h2.giveDose(inst, uuid(req), req.body)));
schoolRouter.post("/health/medication/:id/stop", adminOnly, h((req, _res, inst) => h2.stopMedication(inst, uuid(req))));
schoolRouter.get("/health/counselling", adminOnly, h((req, _res, inst) => h2.counselling(inst)));
schoolRouter.post("/health/counselling", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.addSession(inst, req.body); }));
schoolRouter.post("/health/counselling/:id/status", adminOnly, h((req, _res, inst) => h2.setSession(inst, uuid(req), req.body)));
schoolRouter.get("/health/welfare", adminOnly, h((req, _res, inst) => h2.welfare(inst)));
schoolRouter.post("/health/welfare", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.addCase(inst, req.body); }));
schoolRouter.post("/health/welfare/:id/close", adminOnly, h((req, _res, inst) => h2.closeCase(inst, uuid(req))));
schoolRouter.get("/cert/templates", adminOnly, h((req, _res, inst) => h2.certTemplates(inst)));
schoolRouter.post("/cert/templates", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.addCertTemplate(inst, req.body); }));
schoolRouter.put("/cert/templates/:id", adminOnly, h((req, _res, inst) => h2.editCertTemplate(inst, uuid(req), req.body)));
schoolRouter.get("/cert/students", adminOnly, h((req, _res, inst) => h2.certStudents(inst)));
schoolRouter.get("/cert/facts/:id/:kind", adminOnly, h((req, _res, inst) => h2.certFacts(inst, uuid(req), String(req.params.kind))));
schoolRouter.post("/cert/issue", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.issueCert(inst, req.body); }));
schoolRouter.get("/cert/issued/:kind", adminOnly, h((req, _res, inst) => h2.issuedCerts(inst, String(req.params.kind))));
schoolRouter.get("/cert/register/:kind", adminOnly, h((req, _res, inst) => h2.certRegister(inst, String(req.params.kind))));
schoolRouter.post("/cert/request", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.requestCert(inst, req.body); }));
schoolRouter.post("/cert/:id/decide", adminOnly, h((req, _res, inst) => h2.decideCert(inst, uuid(req), req.body)));
schoolRouter.get("/cert/verify/:code", adminOnly, h((req, _res, inst) => h2.verifyCert(inst, decodeURIComponent(String(req.params.code)))));
schoolRouter.get("/cert/docs/:kind", adminOnly, h((req, _res, inst) => h2.repoDocs(inst, String(req.params.kind))));
schoolRouter.post("/cert/docs", adminOnly, h(async (req, res, inst) => { res.status(201); return h2.addRepoDoc(inst, req.body); }));
schoolRouter.post("/cert/docs/:id/status", adminOnly, h((req, _res, inst) => h2.setRepoDoc(inst, uuid(req), req.body)));
schoolRouter.get("/events/options", adminOnly, h((req, _res, inst) => h2.eventOptions(inst)));
schoolRouter.get("/act/list/:key", adminOnly, h((req, _res, inst) => actv.actList(inst, String(req.params.key))));
schoolRouter.post("/act/list/:key", adminOnly, h(async (req, res, inst) => { res.status(201); return actv.actAdd(inst, String(req.params.key), req.body); }));
schoolRouter.patch("/act/list/:key/:id", adminOnly, h((req, _res, inst) => actv.actEdit(inst, String(req.params.key), uuid(req), req.body)));
schoolRouter.get("/act/event-summary", adminOnly, h((req, _res, inst) => actv.eventSummary(inst)));
schoolRouter.get("/act/houses", adminOnly, h((req, _res, inst) => actv.houses(inst)));
schoolRouter.post("/act/houses", adminOnly, h(async (req, res, inst) => { res.status(201); return actv.addHouse(inst, req.body); }));
schoolRouter.post("/act/house-points", adminOnly, h(async (req, res, inst) => { res.status(201); return actv.awardPoints(inst, req.body); }));
schoolRouter.get("/act/events", adminOnly, h((req, _res, inst) => actv.eventMgmt(inst)));
schoolRouter.post("/act/events", adminOnly, h(async (req, res, inst) => { res.status(201); return actv.addMgmtEvent(inst, req.body); }));
schoolRouter.patch("/act/events/:id", adminOnly, h((req, _res, inst) => actv.editMgmtEvent(inst, uuid(req), req.body)));
schoolRouter.post("/act/volunteers", adminOnly, h(async (req, res, inst) => { res.status(201); return actv.addVolunteer(inst, req.body); }));
schoolRouter.post("/act/volunteers/:id/confirm", adminOnly, h((req, _res, inst) => actv.confirmVolunteer(inst, uuid(req))));
schoolRouter.post("/act/duties", adminOnly, h(async (req, res, inst) => { res.status(201); return actv.addDuty(inst, req.body); }));
schoolRouter.get("/rpt/student-strength", adminOnly, h((_req, _res, inst) => rpt.studentStrength(inst)));
schoolRouter.get("/rpt/syllabus", adminOnly, h((_req, _res, inst) => rpt.syllabusSummary(inst)));
schoolRouter.get("/rpt/staff-month", adminOnly, h((_req, _res, inst) => rpt.staffMonth(inst)));
schoolRouter.get("/rpt/hr-strength", adminOnly, h((_req, _res, inst) => rpt.hrStrength(inst)));
schoolRouter.get("/rpt/fees", adminOnly, h((_req, _res, inst) => rpt.feeSummary(inst)));
schoolRouter.get("/rpt/admissions", adminOnly, h((_req, _res, inst) => rpt.admissionReport(inst)));
schoolRouter.get("/custom/options", adminOnly, h((req, _res, inst) => cus.builderOptions()));
schoolRouter.post("/custom/run", adminOnly, h((req, _res, inst) => cus.runReport(inst, req.body)));
schoolRouter.post("/custom/saved", adminOnly, h(async (req, res, inst) => { res.status(201); return cus.saveReport(inst, req.body, req.user?.fullName ?? "Admin"); }));
schoolRouter.get("/custom/saved", adminOnly, h((req, _res, inst) => cus.savedReports(inst)));
schoolRouter.post("/custom/saved/:id/run", adminOnly, h((req, _res, inst) => cus.runSaved(inst, uuid(req))));
schoolRouter.delete("/custom/saved/:id", adminOnly, h((req, _res, inst) => cus.deleteSaved(inst, uuid(req))));
schoolRouter.get("/export/catalog", adminOnly, h((req, _res, inst) => cus.exportCatalog(inst)));
schoolRouter.get("/export/data/:key", adminOnly, h((req, _res, inst) => cus.exportData(inst, String(req.params.key))));
schoolRouter.get("/profile", adminOnly, h((req, _res, inst) => cus.profile(inst)));
schoolRouter.put("/profile/logo", adminOnly, h((req, _res, inst) => cus.saveLogo(inst, req.body)));
schoolRouter.put("/profile/:part", adminOnly, h((req, _res, inst) => cus.saveProfile(inst, String(req.params.part), req.body)));
schoolRouter.get("/settings-board", adminOnly, h((req, _res, inst) => stg.board(inst)));
schoolRouter.put("/settings-board", adminOnly, h((req, _res, inst) => stg.saveBoard(inst, req.body)));
schoolRouter.get("/settings-campuses", adminOnly, h((req, _res, inst) => stg.campuses(inst)));
schoolRouter.put("/settings-campuses/:id/gstin", adminOnly, h((req, _res, inst) => stg.setGstin(inst, uuid(req), req.body)));
schoolRouter.get("/settings-group/:key", adminOnly, h((req, _res, inst) => stg.getSettings(inst, String(req.params.key))));
schoolRouter.put("/settings-group/:key", adminOnly, h((req, _res, inst) => stg.saveSettings(inst, String(req.params.key), req.body)));
schoolRouter.get("/settings2/kv/:key", adminOnly, h((req, _res, inst) => st2.kvGet(inst, String(req.params.key))));
schoolRouter.put("/settings2/kv/:key", adminOnly, h((req, _res, inst) => st2.kvSave(inst, String(req.params.key), req.body)));
schoolRouter.get("/settings2/levels", adminOnly, h((req, _res, inst) => st2.levels(inst)));
schoolRouter.put("/settings2/levels", adminOnly, h((req, _res, inst) => st2.saveLevels(inst, req.body)));
schoolRouter.get("/settings2/role-menus", adminOnly, h((req, _res, inst) => st2.roleMenus(inst)));
schoolRouter.put("/settings2/role-menus", adminOnly, h((req, _res, inst) => st2.saveRoleMenus(inst, req.body)));
schoolRouter.get("/settings2/users", adminOnly, h((req, _res, inst) => st2.users(inst)));
schoolRouter.post("/settings2/users/:id", adminOnly, h((req, _res, inst) => st2.setUser(inst, uuid(req), req.body, req.user?.profileId)));
schoolRouter.post("/settings2/roles", adminOnly, h(async (req, res, inst) => { res.status(201); return st2.addRole(inst, await actorName(req), req.body); }));
schoolRouter.delete("/settings2/roles/:id", adminOnly, h(async (req, _res, inst) => st2.removeRole(inst, await actorName(req), uuid(req))));
schoolRouter.get("/my-menu", h((req, _res, inst) => st2.myMenu(inst, req.user?.roleDisplayName ?? "")));
schoolRouter.get("/settings2/roles", adminOnly, h((req, _res, inst) => st2.roles(inst)));
schoolRouter.get("/settings2/integrations", adminOnly, h((req, _res, inst) => st2.integrations()));
schoolRouter.get("/settings2/audit", adminOnly, h((req, _res, inst) => st2.audit(inst)));
schoolRouter.get("/settings2/dpdp", adminOnly, h((req, _res, inst) => st2.dpdp(inst)));
schoolRouter.post("/settings2/data-requests/:id", adminOnly, h((req, _res, inst) => st2.decideRequest(inst, uuid(req), req.body)));
schoolRouter.post("/setup-defaults", adminOnly, h((_req, _res, inst) => seedSchoolDefaults(inst)));
schoolRouter.get(fee + "/new-admissions", finDesk, h((_req, _res, inst) => fe.newAdmissions(inst)));
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
  return schoolChat(messages, page, req.user?.profileId ?? "anonymous", inst, req.user?.roleDisplayName ?? "", req.user?.role === "SuperAdmin" ? null : (req.user?.modules ?? []));
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

// the top bar: search box and bell
schoolRouter.get("/topbar/search", h((req, _res, inst) => topbar.search(inst, req.query.q, ["InstitutionAdmin", "Principal", "VicePrincipal", "Teacher", "Accountant", "Receptionist"].includes(req.user?.role ?? "") || (req.user?.permissions ?? []).includes("sis.student.view"), ["InstitutionAdmin", "Principal", "VicePrincipal"].includes(req.user?.role ?? ""))));
schoolRouter.get("/topbar/notifications", h((req, _res, inst) => topbar.notifications(inst, ["InstitutionAdmin", "Principal", "VicePrincipal"].includes(req.user?.role ?? ""))));

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
