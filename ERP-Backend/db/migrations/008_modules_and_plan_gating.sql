-- ====================================================================
-- MIGRATION 008: MODULE CATALOGUE AND PLAN GATING
-- modules          : every feature area that can be sold
-- plan_modules     : which modules each plan includes
-- institution_modules : per-school override (force on / force off)
-- Effective access = module globally enabled AND (core OR override OR plan default).
-- ====================================================================

CREATE TABLE public.modules (
    code        VARCHAR(40) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    is_core     BOOLEAN NOT NULL DEFAULT FALSE,   -- always on for every school, cannot be removed
    is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,    -- platform-wide kill switch
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.plan_modules (
    plan_id     UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    module_code VARCHAR(40) NOT NULL REFERENCES public.modules(code) ON DELETE CASCADE,
    PRIMARY KEY (plan_id, module_code)
);

CREATE TABLE public.institution_modules (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    module_code    VARCHAR(40) NOT NULL REFERENCES public.modules(code) ON DELETE CASCADE,
    enabled        BOOLEAN NOT NULL,
    set_by         UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    set_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (institution_id, module_code)
);

CREATE TRIGGER trg_modules_updated_at BEFORE UPDATE ON public.modules
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.institution_modules ENABLE ROW LEVEL SECURITY;

-- replaced by institution_modules + plan_modules
ALTER TABLE public.institutions DROP COLUMN IF EXISTS enabled_modules;

-- Catalogue. Tier = the lowest plan that includes the module.
INSERT INTO public.modules (code, name, description, is_core, sort_order) VALUES
    ('student_information', 'Student Information',          'Student records, guardians, enrolment and promotion', TRUE,  1),
    ('admissions',          'Admissions & Enquiries',       'Enquiries, applications and admission offers',        FALSE, 2),
    ('attendance',          'Attendance',                   'Daily and period attendance',                         FALSE, 3),
    ('fees',                'Fee Management',               'Fee structures, invoices and collections',            FALSE, 4),
    ('parent_app',          'Parent App',                   'Parent portal for attendance, results and fees',      FALSE, 5),
    ('timetable',           'Timetable',                    'Class and teacher timetables',                        FALSE, 6),
    ('exams',               'Examinations & Report Cards',  'Exam schedules, marks and report cards',              FALSE, 7),
    ('homework',            'Homework & Assignments',       'Homework and assignment tracking',                    FALSE, 8),
    ('teacher_app',         'Teacher App',                  'Teacher mobile app',                                  FALSE, 9),
    ('sms_whatsapp',        'SMS & WhatsApp Alerts',        'Automated alerts to parents',                         FALSE, 10),
    ('transport',           'Transport & GPS',              'Routes, vehicles and live tracking',                  FALSE, 11),
    ('library',             'Library',                      'Catalogue, issue and return',                         FALSE, 12),
    ('hr_payroll',          'HR & Payroll',                 'Staff records, leave and payroll',                    FALSE, 13),
    ('online_classes',      'Online Classes',               'Virtual classrooms',                                  FALSE, 14),
    ('certificates',        'Certificates & ID Cards',      'Certificates, transfer certificates and ID cards',    FALSE, 15),
    ('inventory',           'Inventory',                    'Stock and asset tracking',                            FALSE, 16),
    ('hostel',              'Hostel',                       'Hostel rooms and allocation',                         FALSE, 17),
    ('visitors',            'Visitor Management',           'Visitor log and passes',                              FALSE, 18),
    ('alumni',              'Alumni',                       'Alumni directory and events',                         FALSE, 19),
    ('custom_reports_api',  'Custom Reports & API',         'Custom reports and API access',                       FALSE, 20);

-- Plan mapping: each plan includes its own tier and every lower tier.
WITH tier(code, plan_code) AS (VALUES
    ('student_information', 'basic'), ('admissions', 'basic'), ('attendance', 'basic'), ('fees', 'basic'), ('parent_app', 'basic'),
    ('timetable', 'standard'), ('exams', 'standard'), ('homework', 'standard'), ('teacher_app', 'standard'), ('sms_whatsapp', 'standard'),
    ('transport', 'premium'), ('library', 'premium'), ('hr_payroll', 'premium'), ('online_classes', 'premium'),
    ('certificates', 'premium'), ('inventory', 'premium'),
    ('hostel', 'enterprise'), ('visitors', 'enterprise'), ('alumni', 'enterprise'), ('custom_reports_api', 'enterprise')
)
INSERT INTO public.plan_modules (plan_id, module_code)
SELECT p.id, t.code
FROM tier t
JOIN public.plans tp ON tp.code = t.plan_code
JOIN public.plans p ON p.sort_order >= tp.sort_order;
