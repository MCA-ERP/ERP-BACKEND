-- ====================================================================
-- MIGRATION 034: ACADEMIC MODULES AS THE DESIGN LISTS THEM
-- Admission, Students, Academics, Exams, Attendance, Timetable, Activities & Events.
-- ====================================================================

UPDATE public.modules SET name = 'Admission',  description = 'Online enquiries, applications, entrance tests and admission confirmation.' WHERE code = 'admissions';
UPDATE public.modules SET name = 'Students',   description = 'Student profiles, documents, promotions, transfer certificates and ID cards.' WHERE code = 'student_information';
UPDATE public.modules SET name = 'Exams',      description = 'Exam schedules, marks entry, grading scales and report cards.' WHERE code = 'exams';
UPDATE public.modules SET name = 'Attendance', description = 'Student and staff attendance, corrections, biometric, RFID and QR attendance, and alerts.' WHERE code = 'attendance';
UPDATE public.modules SET name = 'Timetable',  description = 'Class and teacher timetables, substitutions and room allocation.' WHERE code = 'timetable';

INSERT INTO public.modules (code, name, description, is_core, sort_order, category, addon_price_paise, offer_as_addon) VALUES
    ('academics',         'Academics',           'Classes, sections, subjects, timetable, lesson plans and homework.',                FALSE, 30, 'Academic', 6000, TRUE),
    ('activities_events', 'Activities & Events', 'School events, sports, clubs, competitions and achievements.',                      FALSE, 31, 'Academic', 2000, TRUE)
ON CONFLICT (code) DO NOTHING;

-- both come with Standard and above
INSERT INTO public.plan_modules (plan_id, module_code)
SELECT p.id, m.code FROM public.plans p CROSS JOIN (VALUES ('academics'), ('activities_events')) AS m(code)
WHERE p.code IN ('standard', 'premium', 'enterprise')
ON CONFLICT DO NOTHING;
