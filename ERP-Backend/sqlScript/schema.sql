-- ====================================================================
-- EDUCATION ERP: MASTER CONSOLIDATED DATABASE SCHEMA
-- Multi-tier, API-first architecture with PostgreSQL
-- ====================================================================

-- 1. AUTH & INSTITUTION SCHEMA
\i migrations/001_auth_and_rbac.sql

-- 2. STUDENT INFORMATION SYSTEM (SIS) SCHEMA
\i migrations/002_sis_student_information.sql

-- ====================================================================
-- UPCOMING PHASED MIGRATIONS (ROADMAP)
-- ====================================================================
-- 3. Admissions CRM (enquiries, applications, review, offers)
-- 4. Academics (courses, enrollments, timetables, attendance sessions)
-- 5. Examinations (exam schedules, hall tickets, marks, results, GPA/CGPA)
-- 6. Fees & Finance (fee structures, invoices, payment gateway sync, receipts)
-- 7. HR & Payroll (staff profiles, biometric logs, leave workflows, payslips)
-- 8. Campus Operations (library catalog, hostel beds, transport routes)
