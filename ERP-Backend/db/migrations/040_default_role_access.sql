-- ====================================================================
-- MIGRATION 040: STARTING PERMISSIONS AND MODULE ACCESS FOR THE DEFAULT SCHOOL ROLES
-- A sensible start for each role from what exists today. Everything can be changed under Role & Permissions.
-- Roles that are not listed for modules (School Admin, Principal) keep access to every module their school has.
-- ====================================================================

-- ── permissions ──
CREATE TEMP TABLE _rp (role_name TEXT, code TEXT);
INSERT INTO _rp VALUES
    ('VicePrincipal','admin.audit.view'),('VicePrincipal','academics.setup.manage'),('VicePrincipal','sis.student.view'),('VicePrincipal','sis.student.create'),('VicePrincipal','sis.student.edit'),
    ('VicePrincipal','sis.student.promote'),('VicePrincipal','academics.curriculum.manage'),('VicePrincipal','academics.timetable.view'),('VicePrincipal','academics.timetable.manage'),
    ('VicePrincipal','academics.attendance.view'),('VicePrincipal','exams.schedule.manage'),('VicePrincipal','finance.reports.view'),
    ('AdmissionsHead','sis.student.view'),('AdmissionsHead','sis.student.create'),('AdmissionsHead','sis.documents.verify'),('AdmissionsHead','admissions.enquiry.manage'),('AdmissionsHead','admissions.application.review'),('AdmissionsHead','approvals.admission'),
    ('ClassTeacher','sis.student.view'),('ClassTeacher','academics.timetable.view'),('ClassTeacher','academics.attendance.mark'),('ClassTeacher','academics.attendance.view'),('ClassTeacher','exams.marks.entry'),
    ('Receptionist','sis.student.view'),('Receptionist','admissions.enquiry.manage'),
    ('Librarian','sis.student.view'),
    ('TransportManager','sis.student.view'),('SchoolNurse','sis.student.view'),('Counsellor','sis.student.view'),('MessManager','sis.student.view'),
    ('StoreIncharge','finance.reports.view'),
    ('FrontOfficeSecurity','admissions.enquiry.manage'),
    ('ExamCoordinator','sis.student.view'),('ExamCoordinator','academics.timetable.view'),('ExamCoordinator','exams.schedule.manage'),('ExamCoordinator','exams.marks.entry'),('ExamCoordinator','exams.results.publish'),
    ('HR','sis.student.view');

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM _rp x JOIN public.roles r ON r.name = x.role_name JOIN public.permissions p ON p.code = x.code
ON CONFLICT DO NOTHING;
DROP TABLE _rp;

-- ── module access ──
CREATE TEMP TABLE _rm (role_name TEXT, module_code TEXT);
INSERT INTO _rm
SELECT r, m FROM (VALUES
    ('VicePrincipal', 'student_information,admissions,academics,attendance,timetable,exams,homework,teacher_app,sms_whatsapp,email,whatsapp,notifications,school_diary,parent_app,certificates,activities_events,library,transport,fees,visitors,online_classes,health_welfare,hostel,inventory,custom_reports_api,cafeteria,alumni,hr_payroll,employee_self_service'),
    ('HR', 'student_information,hr_payroll,payroll,employee_self_service,attendance,notifications,email'),
    ('Faculty', 'student_information,academics,attendance,timetable,exams,homework,teacher_app,school_diary,notifications,activities_events,online_classes,employee_self_service'),
    ('ClassTeacher', 'student_information,academics,attendance,timetable,exams,homework,teacher_app,school_diary,notifications,activities_events,online_classes,employee_self_service,certificates'),
    ('Accountant', 'student_information,fees,payroll,transport,hostel,inventory,certificates,notifications,email,employee_self_service'),
    ('Receptionist', 'student_information,admissions,visitors,notifications,sms_whatsapp,email'),
    ('Librarian', 'student_information,library,notifications,employee_self_service'),
    ('Registrar', 'student_information,admissions,academics,attendance,timetable,exams,certificates,notifications,email'),
    ('AdmissionsHead', 'student_information,admissions,certificates,sms_whatsapp,email,whatsapp,notifications'),
    ('TransportManager', 'student_information,transport,notifications,sms_whatsapp'),
    ('SchoolNurse', 'student_information,health_welfare,notifications'),
    ('Counsellor', 'student_information,health_welfare,notifications'),
    ('MessManager', 'student_information,cafeteria,hostel,notifications'),
    ('StoreIncharge', 'student_information,inventory,notifications'),
    ('FrontOfficeSecurity', 'student_information,visitors,notifications,sms_whatsapp'),
    ('ExamCoordinator', 'student_information,academics,attendance,timetable,exams,notifications'),
    ('Parent', 'student_information,parent_app,school_diary,notifications,academics,attendance,timetable,exams,homework,fees,transport,library,health_welfare,cafeteria,activities_events,certificates'),
    ('Student', 'student_information,academics,attendance,timetable,exams,homework,library,online_classes,activities_events,school_diary,notifications,cafeteria,certificates')
) AS t(r, mods), LATERAL unnest(string_to_array(mods, ',')) AS m;

INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, x.module_code FROM _rm x JOIN public.roles r ON r.name = x.role_name JOIN public.modules m ON m.code = x.module_code
WHERE NOT EXISTS (SELECT 1 FROM public.role_modules rm WHERE rm.role_id = r.id)
ON CONFLICT DO NOTHING;
DROP TABLE _rm;
