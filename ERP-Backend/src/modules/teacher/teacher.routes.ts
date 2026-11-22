import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireModule, requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as t from "./teacher.service";
import * as m from "./teacher-me.service";
import * as cl from "./teacher-classes.service";
import * as at from "./teacher-attendance.service";
import * as tt from "./teacher-timetable.service";
import * as wk from "./teacher-work.service";
import * as ol from "./teacher-online.service";
import * as ex from "./teacher-exams.service";
import * as cm from "./teacher-comm.service";
import * as lv from "./teacher-leave.service";
import * as rp from "./teacher-reports.service";
import * as fb from "./teacher-feedback.service";
import { teacherChat } from "./teacher-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";

/** The Teacher portal. Only teaching roles get in; every handler works on the signed-in teacher's own profile and school. */
export const teacherRouter = Router();

export const TEACHER_ROLES = ["Faculty", "ClassTeacher", "HOD"];
teacherRouter.use(authGuard);
teacherRouter.use(requireRoles(...TEACHER_ROLES));
// the portal opens with the Teacher App (or Employee Self-Service, for staff who only need My Profile)
teacherRouter.use((req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || ["teacher_app", "employee_self_service"].some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "Your school's plan does not include the Teacher portal. Ask your administrator to add the Teacher App module.", code: "MODULE_NOT_IN_PLAN" });
});

type Ctx = { inst: string; me: string; req: Request };
const h = (fn: (c: Ctx, res: Response) => Promise<unknown>, status = 200) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    const inst = requireInstitutionId(req, typeof req.query.institution_id === "string" ? req.query.institution_id : undefined);
    const me = req.user?.profileId;
    if (!me) throw new HttpError(401, "Sign in again.");
    const body = await fn({ inst, me, req }, res);
    res.status(status).json(body);
  } catch (err) {
    sendError(res, err, "Request failed");
  }
};
const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const qs = (req: Request, k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
const self = requireModule("employee_self_service");
/** Passes when the school has any one of the modules. */
const any = (...codes: string[]) => (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || codes.some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "This feature is not included in your school's plan.", code: "MODULE_NOT_IN_PLAN" });
};
const classesGate = any("student_information", "academics");

// ── dashboard ──
teacherRouter.get("/me", h(({ inst, me }) => t.whoAmI(inst, me)));
teacherRouter.get("/dashboard", h(({ inst, me }) => t.dashboard(inst, me)));
teacherRouter.get("/substitutions", h(({ inst, me }) => t.mySubstitutions(inst, me)));
teacherRouter.post("/substitutions/:id/accept", h(({ inst, me, req }) => t.acceptSubstitution(inst, me, uuid(req))));
teacherRouter.get("/notifications", h(({ inst, me }) => t.notifications(inst, me)));
teacherRouter.post("/notifications/read", h(({ inst, me, req }) => t.markNotificationsRead(inst, me, req.body)));
teacherRouter.get("/checkin", h(({ inst, me }) => t.checkinState(inst, me)));
teacherRouter.post("/checkin/locate", h(({ inst, me, req }) => t.locate(inst, me, req.body)));
teacherRouter.post("/checkin", h(({ inst, me, req }) => t.checkin(inst, me, req.body)));
teacherRouter.get("/event-duties", h(({ inst, me }) => t.myDuties(inst, me)));
teacherRouter.post("/event-duties/:id/respond", h(({ inst, me, req }) => t.respondToDuty(inst, me, uuid(req), req.body)));
teacherRouter.get("/students/search", h(({ inst, me, req }) => t.searchMyStudents(inst, me, req.query.q)));

// ── help desk and calendar ──
teacherRouter.get("/help/categories", h(({ inst }) => t.helpCategories(inst)));
teacherRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
teacherRouter.post("/help/tickets", h(({ inst, me, req }) => t.raiseTicket(inst, me, req.body), 201));
teacherRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));
teacherRouter.get("/calendar", h(({ inst, me, req }) => {
  const from = qs(req, "from"), to = qs(req, "to");
  if (!from || !to) throw new HttpError(400, "Say which dates to show.");
  return t.calendar(inst, me, from, to);
}));

// ── my profile (needs Employee Self-Service in the school's plan) ──
teacherRouter.get("/profile", self, h(({ inst, me }) => m.profile(inst, me)));
teacherRouter.put("/profile/contact", self, h(({ inst, me, req }) => m.saveContact(inst, me, req.body)));
teacherRouter.get("/profile/qualifications", self, h(({ me }) => m.qualifications(me)));
teacherRouter.post("/profile/qualifications", self, h(async ({ me, req }) => ({ item: await m.addQualification(me, req.body) }), 201));
teacherRouter.get("/profile/documents", self, h(({ inst, me }) => m.documents(inst, me)));
teacherRouter.post("/profile/documents", self, h(({ inst, me, req }) => m.uploadDocument(inst, me, req.body), 201));
teacherRouter.get("/payslips", self, h(({ inst, me, req }) => m.payslips(inst, me, qs(req, "month"))));
teacherRouter.get("/feedback/peers", self, h(({ inst, me }) => m.peerFeedback(inst, me)));
teacherRouter.post("/feedback/peers/:id", self, h(({ inst, me, req }) => m.submitPeer(inst, me, uuid(req), req.body)));
teacherRouter.get("/feedback/results", self, h(({ inst, me }) => m.feedbackResults(inst, me)));
teacherRouter.get("/feedback/competencies", self, h(({ inst, me }) => m.competencies(inst, me)));
teacherRouter.get("/claims", self, h(({ inst, me }) => m.claims(inst, me)));
teacherRouter.post("/claims", self, h(({ inst, me, req }) => m.submitClaim(inst, me, req.body), 201));
teacherRouter.get("/appraisal", self, h(({ inst, me }) => m.appraisal(inst, me)));
teacherRouter.post("/appraisal/self", self, h(({ inst, me, req }) => m.submitAppraisal(inst, me, req.body)));

// ── my classes, house points, subjects ──
teacherRouter.get("/classes", classesGate, h(({ inst, me }) => cl.classList(inst, me)));
teacherRouter.get("/classes/sections", classesGate, h(({ inst, me }) => cl.sectionList(inst, me)));
teacherRouter.get("/students", classesGate, h(({ inst, me }) => cl.studentList(inst, me)));
teacherRouter.get("/students/:id", classesGate, h(({ inst, me, req }) => cl.studentProfile(inst, me, uuid(req))));
teacherRouter.get("/health-alerts/:id", classesGate, h(({ inst, me, req }) => cl.healthAlerts(inst, me, uuid(req))));
teacherRouter.get("/house-points", any("activities_events", "house_points"), h(({ inst, me }) => cl.housePoints(inst, me)));
teacherRouter.post("/house-points", any("activities_events", "house_points"), h(({ inst, me, req }) => cl.awardPoints(inst, me, req.body), 201));
teacherRouter.get("/subjects", any("academics"), h(({ inst, me }) => cl.subjectList(inst, me)));
teacherRouter.get("/syllabus", any("academics"), h(({ inst, me }) => cl.syllabus(inst, me)));
teacherRouter.post("/syllabus/progress", any("academics"), h(({ inst, me, req }) => cl.setProgress(inst, me, req.body)));

// ── attendance ──
const attGate = any("attendance");
teacherRouter.get("/attendance/registers", attGate, h(({ inst, me }) => at.myRegisters(inst, me)));
teacherRouter.get("/attendance/sheet/:id", attGate, h(({ inst, me, req }) => at.registerSheet(inst, me, uuid(req), qs(req, "date") ?? "")));
teacherRouter.post("/attendance/sheet", attGate, h(({ inst, me, req }) => at.saveRegister(inst, me, req.body)));
teacherRouter.get("/attendance/edit-requests", attGate, h(({ inst, me }) => at.editRequests(inst, me)));
teacherRouter.post("/attendance/edit-requests", attGate, h(({ inst, me, req }) => at.sendEditRequest(inst, me, req.body), 201));
teacherRouter.get("/attendance/marked/:id", attGate, h(({ inst, me, req }) => at.markedOn(inst, me, uuid(req), qs(req, "date") ?? "")));
teacherRouter.get("/attendance/leaves", attGate, h(({ inst, me }) => at.studentLeaves(inst, me)));
teacherRouter.post("/attendance/leaves/:id/decide", attGate, h(({ inst, me, req }) => at.decideStudentLeave(inst, me, uuid(req), req.body)));
teacherRouter.get("/attendance/history/daily", attGate, h(({ inst, me }) => at.historyDaily(inst, me)));
teacherRouter.get("/attendance/history/monthly", attGate, h(({ inst, me }) => at.historyMonthly(inst, me)));
teacherRouter.get("/attendance/history/yearly", attGate, h(({ inst, me }) => at.historyYearly(inst, me)));

// ── timetable and substitution ──
const ttGate = any("timetable");
teacherRouter.get("/timetable/daily", ttGate, h(({ inst, me }) => tt.daily(inst, me)));
teacherRouter.get("/timetable/weekly", ttGate, h(({ inst, me }) => tt.weekly(inst, me)));
teacherRouter.get("/timetable/substitutions", ttGate, h(({ inst, me }) => tt.assigned(inst, me)));
teacherRouter.get("/timetable/free-periods", ttGate, h(({ inst, me }) => tt.freePeriods(inst, me)));
teacherRouter.get("/timetable/covers", ttGate, h(({ inst, me }) => tt.todaysCovers(inst, me)));
teacherRouter.get("/timetable/covers/:id/notes", ttGate, h(({ inst, me, req }) => tt.lessonNotes(inst, me, uuid(req))));

// ── lesson planning ──
const lpGate = any("academics");
teacherRouter.get("/lesson-plans", lpGate, h(({ inst, me }) => wk.lessonPlans(inst, me)));
teacherRouter.post("/lesson-plans", lpGate, h(({ inst, me, req }) => wk.addLessonPlan(inst, me, req.body), 201));
teacherRouter.post("/lesson-plans/:id/submit", lpGate, h(({ inst, me, req }) => wk.submitLessonPlan(inst, me, uuid(req))));
teacherRouter.get("/chapters/:id", lpGate, h(({ inst, me, req }) => wk.chapterProgress(inst, me, uuid(req))));

// ── homework ──
const hwGate = any("homework", "online_classes");
teacherRouter.get("/homework", hwGate, h(({ inst, me }) => wk.homeworkList(inst, me)));
teacherRouter.post("/homework", hwGate, h(({ inst, me, req }) => wk.addHomework(inst, me, req.body), 201));
teacherRouter.get("/homework/submissions", hwGate, h(({ inst, me }) => wk.homeworkSubmissions(inst, me)));
teacherRouter.post("/homework/submissions/check", hwGate, h(({ inst, me, req }) => wk.checkSubmission(inst, me, req.body)));
teacherRouter.post("/homework/submissions/accept-late", hwGate, h(({ inst, me, req }) => wk.acceptLate(inst, me, req.body)));
teacherRouter.post("/homework/submissions/remind", hwGate, h(({ inst, me, req }) => wk.remindParent(inst, me, req.body)));
teacherRouter.patch("/homework/:id", hwGate, h(({ inst, me, req }) => wk.updateHomework(inst, me, uuid(req), req.body)));

// ── assignments ──
teacherRouter.get("/assignments", hwGate, h(({ inst, me }) => wk.assignmentList(inst, me)));
teacherRouter.post("/assignments", hwGate, h(({ inst, me, req }) => wk.addAssignment(inst, me, req.body), 201));
teacherRouter.post("/assignments/:id/assign", hwGate, h(({ inst, me, req }) => wk.assignNow(inst, me, uuid(req))));
teacherRouter.post("/assignments/:id/notify", hwGate, h(({ inst, me, req }) => wk.notifyAgain(inst, me, uuid(req))));
teacherRouter.post("/assignments/:id/extend", hwGate, h(({ inst, me, req }) => wk.extendDue(inst, me, uuid(req), req.body)));
teacherRouter.get("/assignments/:id/marks", hwGate, h(({ inst, me, req }) => wk.assignmentMarks(inst, me, uuid(req))));
teacherRouter.post("/assignments/:id/marks", hwGate, h(({ inst, me, req }) => wk.saveMarks(inst, me, uuid(req), req.body)));
teacherRouter.post("/assignments/:id/feedback", hwGate, h(({ inst, me, req }) => wk.sendFeedback(inst, me, uuid(req), req.body)));

// ── study materials ──
teacherRouter.get("/materials", hwGate, h(({ inst, me }) => wk.materials(inst, me)));
teacherRouter.post("/materials", hwGate, h(({ inst, me, req }) => wk.addMaterial(inst, me, req.body), 201));
teacherRouter.get("/materials/shared", hwGate, h(({ inst, me }) => wk.sharedMaterials(inst, me)));
teacherRouter.post("/materials/shared/:id/save", hwGate, h(({ inst, me, req }) => wk.saveShared(inst, me, uuid(req), req.body ?? {})));
teacherRouter.post("/materials/:id/sharing", hwGate, h(({ inst, me, req }) => wk.setSharing(inst, me, uuid(req), req.body)));

// ── online learning ──
const olGate = any("online_classes", "homework");
teacherRouter.get("/online/classes", olGate, h(({ inst, me }) => ol.onlineClasses(inst, me)));
teacherRouter.post("/online/classes", olGate, h(({ inst, me, req }) => ol.scheduleClass(inst, me, req.body), 201));
teacherRouter.post("/online/classes/:id/cancel", olGate, h(({ inst, me, req }) => ol.cancelClass(inst, me, uuid(req))));
teacherRouter.post("/online/classes/:id/recording", olGate, h(({ inst, me, req }) => ol.uploadRecording(inst, me, uuid(req), req.body)));
teacherRouter.get("/online/tests", olGate, h(({ inst, me }) => ol.onlineTests(inst, me)));
teacherRouter.post("/online/tests", olGate, h(({ inst, me, req }) => ol.createTest(inst, me, req.body), 201));
teacherRouter.patch("/online/tests/:id", olGate, h(({ inst, me, req }) => ol.updateTest(inst, me, uuid(req), req.body)));
teacherRouter.get("/online/tests/:id/results", olGate, h(({ inst, me, req }) => ol.testResults(inst, me, uuid(req))));

// ── examinations ──
const exGate = any("exams");
teacherRouter.get("/exams/schedule", exGate, h(({ inst, me }) => ex.schedule(inst, me)));
teacherRouter.post("/exams/papers", exGate, h(({ inst, me, req }) => ex.uploadPaper(inst, me, req.body)));
teacherRouter.get("/exams/invigilation", exGate, h(({ inst, me }) => ex.invigilation(inst, me)));
teacherRouter.post("/exams/invigilation/:id/swap", exGate, h(({ inst, me, req }) => ex.requestSwap(inst, me, uuid(req), req.body ?? {})));
teacherRouter.get("/exams/marks/choices", exGate, h(({ inst, me }) => ex.marksChoices(inst, me)));
teacherRouter.get("/exams/marks/sheet", exGate, h(({ inst, me, req }) => ex.marksSheet(inst, me, { exam_id: qs(req, "exam_id") ?? "", section_id: qs(req, "section_id") ?? "", component: qs(req, "component") ?? "" })));
teacherRouter.post("/exams/marks/sheet", exGate, h(({ inst, me, req }) => ex.saveMarks(inst, me, req.body)));
teacherRouter.get("/exams/coscholastic/:id", exGate, h(({ inst, me, req }) => ex.coscholasticSheet(inst, me, uuid(req), qs(req, "term") ?? "Term 1")));
teacherRouter.post("/exams/coscholastic", exGate, h(({ inst, me, req }) => ex.saveCoscholasticGrades(inst, me, req.body)));
teacherRouter.get("/exams/gradebook/classes", exGate, h(({ inst, me }) => ex.gradebookClasses(inst, me)));
teacherRouter.get("/exams/gradebook/:id", exGate, h(({ inst, me, req }) => ex.gradebookStudents(inst, me, uuid(req))));
teacherRouter.get("/exams/holistic/:id", exGate, h(({ inst, me, req }) => ex.holisticCards(inst, me, uuid(req))));
teacherRouter.post("/exams/holistic", exGate, h(({ inst, me, req }) => ex.saveHolistic(inst, me, req.body)));
const cpGate = any("competitive_prep");
teacherRouter.get("/competitive/batches", cpGate, h(({ inst, me }) => ex.compBatches(inst, me)));
teacherRouter.get("/competitive/analysis", cpGate, h(({ inst, me }) => ex.compAnalysis(inst, me)));
teacherRouter.get("/competitive/mock", cpGate, h(({ inst, me }) => ex.compMockForm(inst, me)));
teacherRouter.post("/competitive/mock", cpGate, h(({ inst, me, req }) => ex.createMock(inst, me, req.body), 201));

// ── parent messages ──
const pmGate = any("school_diary", "notifications", "parent_app");
teacherRouter.get("/messages/inbox", pmGate, h(({ inst, me }) => ol.inbox(inst, me)));
teacherRouter.post("/messages/:id/read", pmGate, h(({ inst, me, req }) => ol.markRead(inst, me, uuid(req))));
teacherRouter.post("/messages/:id/reply", pmGate, h(({ inst, me, req }) => ol.replyTo(inst, me, uuid(req), req.body), 201));
teacherRouter.get("/messages/replies", pmGate, h(({ inst, me }) => ol.replies(inst, me)));
teacherRouter.get("/messages/sent", pmGate, h(({ inst, me }) => ol.sentMessages(inst, me)));
teacherRouter.post("/messages/sent", pmGate, h(({ inst, me, req }) => ol.sendMessage(inst, me, req.body), 201));

// ── school notices, meeting slots, chat, gallery, diary ──
teacherRouter.get("/notices/circulars", h(({ inst, me }) => cm.circulars(inst, me)));
teacherRouter.post("/notices/circulars/:id/acknowledge", h(({ inst, me, req }) => cm.acknowledge(inst, me, uuid(req))));
teacherRouter.get("/notices/announcements", h(({ inst }) => cm.announcements(inst)));
teacherRouter.get("/ptm/slots", pmGate, h(({ inst, me }) => cm.ptmSlots(inst, me)));
teacherRouter.post("/ptm/slots/:id/toggle", pmGate, h(({ inst, me, req }) => cm.toggleSlot(inst, me, uuid(req))));
teacherRouter.post("/ptm/slots/:id/met", pmGate, h(({ inst, me, req }) => cm.markMet(inst, me, uuid(req))));
const chatGate = any("chat", "school_diary", "notifications", "parent_app");
teacherRouter.get("/chat/threads", chatGate, h(({ inst, me }) => cm.chatThreads(inst, me)));
teacherRouter.get("/chat/files", chatGate, h(({ inst, me }) => cm.sharedFiles(inst, me)));
teacherRouter.get("/chat/threads/:id", chatGate, h(({ inst, me, req }) => cm.chatMessages(inst, me, uuid(req))));
teacherRouter.post("/chat/threads/:id/messages", chatGate, h(({ inst, me, req }) => cm.sendChat(inst, me, uuid(req), req.body), 201));
const galGate = any("photo_gallery", "school_diary", "notifications", "parent_app");
teacherRouter.get("/gallery", galGate, h(({ inst, me }) => cm.albums(inst, me)));
teacherRouter.post("/gallery", galGate, h(({ inst, me, req }) => cm.uploadAlbum(inst, me, req.body), 201));
const diaryGate = any("school_diary");
teacherRouter.get("/diary", diaryGate, h(({ inst, me }) => cm.diary(inst, me)));
teacherRouter.post("/diary", diaryGate, h(({ inst, me, req }) => cm.addDiary(inst, me, req.body), 201));
teacherRouter.get("/diary/remarks", diaryGate, h(({ inst, me }) => cm.remarks(inst, me)));
teacherRouter.post("/diary/remarks", diaryGate, h(({ inst, me, req }) => cm.addRemark(inst, me, req.body), 201));

// ── leave ──
teacherRouter.get("/leave", self, h(({ inst, me }) => lv.leaveOverview(inst, me)));
teacherRouter.post("/leave", self, h(({ inst, me, req }) => lv.applyLeave(inst, me, req.body), 201));
teacherRouter.get("/leave/team", self, h(({ inst, me }) => lv.teamLeave(inst, me)));
teacherRouter.post("/leave/team/:id", self, h(({ inst, me, req }) => lv.decideTeam(inst, me, uuid(req), req.body)));

// ── reports ──
teacherRouter.get("/reports/sections", h(({ inst, me }) => rp.reportSections(inst, me)));
teacherRouter.get("/reports/attendance/:id", attGate, h(({ inst, me, req }) => rp.classAttendanceReport(inst, me, uuid(req))));
teacherRouter.get("/reports/academic/:id", exGate, h(({ inst, me, req }) => rp.classAcademicReport(inst, me, uuid(req))));
teacherRouter.get("/reports/student/:id", exGate, h(({ inst, me, req }) => rp.studentReport(inst, me, uuid(req))));
teacherRouter.post("/reports/remark", exGate, h(({ inst, me, req }) => rp.saveRemark(inst, me, req.body)));

// ── my feedback ──
const svGate = any("surveys", "teacher_app", "school_diary");
teacherRouter.get("/my-feedback", svGate, h(({ inst, me }) => fb.studentFeedback(inst, me)));
teacherRouter.get("/surveys", svGate, h(({ inst, me }) => fb.staffSurveys(inst, me)));
teacherRouter.get("/surveys/:id", svGate, h(({ inst, me, req }) => fb.surveyForm(inst, me, uuid(req))));
teacherRouter.post("/surveys/:id", svGate, h(({ inst, me, req }) => fb.answerSurvey(inst, me, uuid(req), req.body), 201));

// ── assistant (this teacher's own data only) ──
teacherRouter.post("/assist/chat", h(({ inst, me, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return teacherChat(b.messages, b.page, b.guide ?? "", inst, me, req.user?.roleDisplayName ?? "");
}));
teacherRouter.post("/assist/transcribe", express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));
