-- ====================================================================
-- SEED DATA 001: ROLES, PERMISSIONS, INSTITUTION & DEMO DATA
-- ====================================================================

-- 1. Insert Standard Roles
INSERT INTO public.roles (name, display_name, description, is_system_default)
VALUES 
    ('SuperAdmin', 'Super Administrator', 'Full platform multi-tenant administrative privileges', TRUE),
    ('InstitutionAdmin', 'Institution Administrator', 'Full institutional control and configuration', TRUE),
    ('Principal', 'Principal / Director', 'Campus academic oversight, faculty governance, approvals', TRUE),
    ('Registrar', 'Registrar / Academic Office', 'Admissions, enrollment records, transcripts, promotions', TRUE),
    ('Faculty', 'Faculty / Teacher', 'Class timetable, attendance, marks entry, coursework', TRUE),
    ('Student', 'Student', 'Personal timetable, grades, attendance, fee payments, hall ticket', TRUE),
    ('Parent', 'Parent / Guardian', 'Ward attendance tracking, report cards, fee dues and payments', TRUE),
    ('Accountant', 'Accountant / Finance Officer', 'Fee setup, offline collections, invoices, reconciliation', TRUE),
    ('HR', 'Human Resources Manager', 'Staff records, recruitment, leaves, biometric attendance, payroll', TRUE),
    ('Librarian', 'Librarian', 'Book catalog, issues, returns, fines', TRUE)
ON CONFLICT (name) DO UPDATE 
SET display_name = EXCLUDED.display_name, description = EXCLUDED.description;

-- 2. Insert Standard System Permissions
INSERT INTO public.permissions (code, module, description)
VALUES
    -- Auth & Administration
    ('admin.users.manage', 'auth', 'Create, edit, suspend users and assign roles'),
    ('admin.settings.manage', 'auth', 'Configure institutional settings, academic years, campuses'),
    ('admin.audit.view', 'auth', 'View system audit logs and security traces'),
    
    -- SIS (Student Information System)
    ('sis.student.view', 'sis', 'View student directories and profiles'),
    ('sis.student.create', 'sis', 'Enroll new students and create student records'),
    ('sis.student.edit', 'sis', 'Modify student personal and academic details'),
    ('sis.student.promote', 'sis', 'Execute semester/batch student promotions'),
    ('sis.documents.verify', 'sis', 'Review and verify submitted student documents'),
    
    -- Admissions CRM
    ('admissions.enquiry.manage', 'admissions', 'Manage prospective student enquiries and leads'),
    ('admissions.application.review', 'admissions', 'Review admission forms and generate offer letters'),
    
    -- Academics & Timetable
    ('academics.curriculum.manage', 'academics', 'Configure departments, programs, courses, and syllabus'),
    ('academics.timetable.view', 'academics', 'View scheduled timetables and room allocations'),
    ('academics.timetable.manage', 'academics', 'Create and modify class and examination timetables'),
    ('academics.attendance.mark', 'academics', 'Mark and update student subject attendance'),
    ('academics.attendance.view', 'academics', 'View attendance reports and low-attendance alerts'),
    
    -- Examinations
    ('exams.schedule.manage', 'exams', 'Schedule internal and external examinations'),
    ('exams.marks.entry', 'exams', 'Enter and upload exam and internal marks'),
    ('exams.results.publish', 'exams', 'Moderate, lock and publish exam result cards'),
    
    -- Fees & Finance
    ('finance.fees.manage', 'finance', 'Define fee structures, categories, and installments'),
    ('finance.payment.collect', 'finance', 'Accept counter payments, cash, cheques, and print receipts'),
    ('finance.reports.view', 'finance', 'View financial summaries, dues list, and collection reports')
ON CONFLICT (code) DO NOTHING;

-- 3. Insert Default Demo Institution
INSERT INTO public.institutions (id, code, name, type, website, contact_email, contact_phone, address)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'AITS01',
    'Apex Institute of Technology & Sciences',
    'University',
    'https://aits.edu',
    'registrar@aits.edu',
    '+91-9876543210',
    'Knowledge City, Tech Boulevard, Sector 62'
)
ON CONFLICT (code) DO NOTHING;

-- 4. Insert Default Main Campus
INSERT INTO public.campuses (id, institution_id, code, name, address, city, state, postal_code, country)
VALUES (
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'MAIN-01',
    'Main Urban Campus',
    'Knowledge City, Tech Boulevard',
    'Bangalore',
    'Karnataka',
    '560100',
    'India'
)
ON CONFLICT (institution_id, code) DO NOTHING;

-- 5. Insert Current Academic Year
INSERT INTO public.academic_years (id, institution_id, name, start_date, end_date, is_current)
VALUES (
    'd0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    '2024-2025',
    '2024-07-01',
    '2025-06-30',
    TRUE
)
ON CONFLICT (institution_id, name) DO NOTHING;

-- 6. Insert Computer Science Department
INSERT INTO public.departments (id, institution_id, code, name, description)
VALUES (
    'e0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'CSE',
    'Department of Computer Science & Engineering',
    'Department overseeing undergraduate and graduate computing disciplines'
)
ON CONFLICT (institution_id, code) DO NOTHING;

-- 7. Insert B.Tech Program
INSERT INTO public.programs (id, department_id, code, name, degree_level, duration_years, total_semesters)
VALUES (
    'f0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000001',
    'BTECH-CSE',
    'Bachelor of Technology in Computer Science',
    'Undergraduate',
    4,
    8
)
ON CONFLICT (department_id, code) DO NOTHING;
