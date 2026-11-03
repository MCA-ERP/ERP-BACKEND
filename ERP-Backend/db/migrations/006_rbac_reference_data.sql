-- ====================================================================
-- MIGRATION 006: RBAC REFERENCE DATA
-- System roles, permission catalogue and default role -> permission grants.
-- Idempotent: safe on databases that were seeded by hand earlier.
-- SuperAdmin is not granted rows; it bypasses permission checks in code.
-- ====================================================================

INSERT INTO public.roles (name, display_name, description, is_system_default) VALUES
    ('SuperAdmin',       'Super Administrator',         'Full platform multi-tenant administrative privileges', TRUE),
    ('InstitutionAdmin', 'Institution Administrator',   'Full institutional control and configuration', TRUE),
    ('Principal',        'Principal / Director',        'Campus academic oversight, faculty governance, approvals', TRUE),
    ('Registrar',        'Registrar / Academic Office', 'Admissions, enrollment records, transcripts, promotions', TRUE),
    ('Faculty',          'Faculty / Teacher',           'Class timetable, attendance, marks entry', TRUE),
    ('Student',          'Student',                     'Personal timetable, grades, attendance, fee payments', TRUE),
    ('Parent',           'Parent / Guardian',           'Ward attendance tracking, report cards, fee dues and payments', TRUE),
    ('Accountant',       'Accountant / Finance Officer','Fee setup, offline collections, invoices, reconciliation', TRUE),
    ('HR',               'Human Resources Manager',     'Staff records, recruitment, leaves, payroll', TRUE),
    ('Librarian',        'Librarian',                   'Book catalog, issues, returns, fines', TRUE)
ON CONFLICT (name) DO UPDATE
    SET display_name = EXCLUDED.display_name, description = EXCLUDED.description;

INSERT INTO public.permissions (code, module, description) VALUES
    ('admin.users.manage',           'auth',       'Create, edit, suspend users and assign roles'),
    ('admin.settings.manage',        'auth',       'Configure institutional settings and campuses'),
    ('admin.audit.view',             'auth',       'View system audit logs and security traces'),
    ('academics.setup.manage',       'academics',  'Manage academic years, grades, sections and subjects'),
    ('sis.student.view',             'sis',        'View student directories and profiles'),
    ('sis.student.create',           'sis',        'Enroll new students and create student records'),
    ('sis.student.edit',             'sis',        'Modify student personal and academic details'),
    ('sis.student.promote',          'sis',        'Execute year-end student promotions'),
    ('sis.documents.verify',         'sis',        'Review and verify submitted student documents'),
    ('admissions.enquiry.manage',    'admissions', 'Manage prospective student enquiries and leads'),
    ('admissions.application.review','admissions', 'Review admission forms and generate offer letters'),
    ('academics.curriculum.manage',  'academics',  'Configure subjects, courses and syllabus'),
    ('academics.timetable.view',     'academics',  'View scheduled timetables and room allocations'),
    ('academics.timetable.manage',   'academics',  'Create and modify class and examination timetables'),
    ('academics.attendance.mark',    'academics',  'Mark and update student attendance'),
    ('academics.attendance.view',    'academics',  'View attendance reports and low-attendance alerts'),
    ('exams.schedule.manage',        'exams',      'Schedule internal and external examinations'),
    ('exams.marks.entry',            'exams',      'Enter and upload exam and internal marks'),
    ('exams.results.publish',        'exams',      'Moderate, lock and publish exam result cards'),
    ('finance.fees.manage',          'finance',    'Define fee structures, categories, and installments'),
    ('finance.payment.collect',      'finance',    'Accept counter payments and print receipts'),
    ('finance.reports.view',         'finance',    'View financial summaries, dues list, and collection reports')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

-- InstitutionAdmin: every permission
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r CROSS JOIN public.permissions p
WHERE r.name = 'InstitutionAdmin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Default grants for the other roles
WITH grants (role_name, code) AS (VALUES
    ('Principal',  'admin.audit.view'),
    ('Principal',  'academics.setup.manage'),
    ('Principal',  'sis.student.view'),
    ('Principal',  'sis.student.create'),
    ('Principal',  'sis.student.edit'),
    ('Principal',  'sis.student.promote'),
    ('Principal',  'academics.curriculum.manage'),
    ('Principal',  'academics.timetable.view'),
    ('Principal',  'academics.timetable.manage'),
    ('Principal',  'academics.attendance.view'),
    ('Principal',  'exams.schedule.manage'),
    ('Principal',  'exams.results.publish'),
    ('Principal',  'finance.reports.view'),
    ('Registrar',  'sis.student.view'),
    ('Registrar',  'sis.student.create'),
    ('Registrar',  'sis.student.edit'),
    ('Registrar',  'sis.student.promote'),
    ('Registrar',  'sis.documents.verify'),
    ('Registrar',  'admissions.enquiry.manage'),
    ('Registrar',  'admissions.application.review'),
    ('Faculty',    'sis.student.view'),
    ('Faculty',    'academics.timetable.view'),
    ('Faculty',    'academics.attendance.mark'),
    ('Faculty',    'academics.attendance.view'),
    ('Faculty',    'exams.marks.entry'),
    ('Accountant', 'sis.student.view'),
    ('Accountant', 'finance.fees.manage'),
    ('Accountant', 'finance.payment.collect'),
    ('Accountant', 'finance.reports.view'),
    ('Student',    'academics.timetable.view'),
    ('Parent',     'academics.timetable.view')
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM grants g
JOIN public.roles r ON r.name = g.role_name
JOIN public.permissions p ON p.code = g.code
ON CONFLICT (role_id, permission_id) DO NOTHING;
