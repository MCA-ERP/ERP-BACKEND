-- ====================================================================
-- MIGRATION 018: MODULE MANAGEMENT
-- Categories, build status (is the module actually built?), add-on prices,
-- dependencies, feature flags, bundles and releases. Also brings the catalogue in
-- line with the design: Email, Notifications and Payroll become their own modules.
-- ====================================================================

ALTER TABLE public.modules
    ADD COLUMN IF NOT EXISTS category          VARCHAR(20) NOT NULL DEFAULT 'Academic'
        CHECK (category IN ('Academic', 'Administrative', 'Communication', 'Advanced')),
    ADD COLUMN IF NOT EXISTS build_status      VARCHAR(10) NOT NULL DEFAULT 'planned'
        CHECK (build_status IN ('live', 'beta', 'planned')),
    ADD COLUMN IF NOT EXISTS addon_price_paise INTEGER NOT NULL DEFAULT 0 CHECK (addon_price_paise >= 0),
    ADD COLUMN IF NOT EXISTS version           VARCHAR(20);

-- catalogue alignment with the design
UPDATE public.modules SET name = 'HR', description = 'Staff records, leave, staff attendance and appraisals' WHERE code = 'hr_payroll';
UPDATE public.modules SET name = 'Analytics', description = 'Cross-campus dashboards, custom reports and a data export API' WHERE code = 'custom_reports_api';
UPDATE public.modules SET name = 'Online Classes (LMS)', description = 'Online classes, recorded lessons, quizzes and assignments' WHERE code = 'online_classes';
UPDATE public.modules SET name = 'Students', description = 'Student profiles, documents, promotions, transfer certificates and ID cards' WHERE code = 'student_information';

INSERT INTO public.modules (code, name, description, is_core, sort_order) VALUES
    ('payroll',       'Payroll',       'Salary structures, payslips, PF, ESI and TDS', FALSE, 22),
    ('email',         'Email',         'Transactional and bulk email from the school', FALSE, 23),
    ('notifications', 'Notifications', 'Push and in-app notifications in the parent, teacher and student apps', FALSE, 24)
ON CONFLICT (code) DO NOTHING;

UPDATE public.modules SET category = CASE code
    WHEN 'student_information' THEN 'Academic'  WHEN 'admissions' THEN 'Academic'  WHEN 'attendance' THEN 'Academic'
    WHEN 'timetable' THEN 'Academic'            WHEN 'exams' THEN 'Academic'       WHEN 'homework' THEN 'Academic'
    WHEN 'certificates' THEN 'Academic'
    WHEN 'fees' THEN 'Administrative'           WHEN 'hr_payroll' THEN 'Administrative' WHEN 'payroll' THEN 'Administrative'
    WHEN 'transport' THEN 'Administrative'      WHEN 'library' THEN 'Administrative'    WHEN 'visitors' THEN 'Administrative'
    WHEN 'cafeteria' THEN 'Administrative'
    WHEN 'parent_app' THEN 'Communication'      WHEN 'teacher_app' THEN 'Communication' WHEN 'sms_whatsapp' THEN 'Communication'
    WHEN 'email' THEN 'Communication'           WHEN 'notifications' THEN 'Communication'
    ELSE 'Advanced' END;

-- only Student Information is built so far (students, enrolment, academic years, grades, sections, subjects)
UPDATE public.modules SET build_status = 'live', version = '1.0.0' WHERE code = 'student_information';

-- plans: the new modules follow the tier they belong to
WITH tier(code, min_order) AS (
    VALUES ('email', 1), ('notifications', 1), ('payroll', 3)
)
INSERT INTO public.plan_modules (plan_id, module_code)
SELECT p.id, t.code FROM tier t JOIN public.plans p ON p.sort_order >= t.min_order
ON CONFLICT DO NOTHING;

-- add-on prices: rupees per student per year, used when a school gets a module its plan does not include
UPDATE public.modules SET addon_price_paise = CASE code
    WHEN 'timetable' THEN 6000 WHEN 'exams' THEN 6000 WHEN 'hr_payroll' THEN 5000 WHEN 'payroll' THEN 8000
    WHEN 'transport' THEN 7000 WHEN 'sms_whatsapp' THEN 2000 WHEN 'online_classes' THEN 9000 WHEN 'hostel' THEN 6000
    WHEN 'inventory' THEN 4000 WHEN 'custom_reports_api' THEN 10000 ELSE addon_price_paise END;

-- a module that needs other modules to work
CREATE TABLE public.module_dependencies (
    module_code   VARCHAR(40) NOT NULL REFERENCES public.modules(code) ON DELETE CASCADE,
    requires_code VARCHAR(40) NOT NULL REFERENCES public.modules(code) ON DELETE CASCADE,
    PRIMARY KEY (module_code, requires_code),
    CHECK (module_code <> requires_code)
);
INSERT INTO public.module_dependencies (module_code, requires_code) VALUES
    ('attendance', 'student_information'), ('fees', 'student_information'), ('parent_app', 'student_information'),
    ('certificates', 'student_information'), ('timetable', 'student_information'), ('transport', 'student_information'),
    ('exams', 'timetable'), ('homework', 'timetable'), ('online_classes', 'timetable'),
    ('payroll', 'hr_payroll'), ('inventory', 'fees'), ('hostel', 'student_information'), ('hostel', 'fees')
ON CONFLICT DO NOTHING;

-- switch a feature on for a share of schools
CREATE TABLE public.feature_flags (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key             VARCHAR(60) UNIQUE NOT NULL CHECK (key ~ '^[a-z0-9_.-]{3,60}$'),
    name            VARCHAR(120) NOT NULL,
    description     TEXT,
    module_code     VARCHAR(40) REFERENCES public.modules(code) ON DELETE SET NULL,
    rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- modules sold together for less
CREATE TABLE public.module_bundles (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    VARCHAR(120) NOT NULL,
    description             TEXT,
    module_codes            TEXT[] NOT NULL CHECK (array_length(module_codes, 1) >= 2),
    price_per_student_paise INTEGER NOT NULL CHECK (price_per_student_paise >= 0),
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- what changed in each release, and how far it has rolled out (recorded by the team)
CREATE TABLE public.module_releases (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module_code     VARCHAR(40) NOT NULL REFERENCES public.modules(code) ON DELETE CASCADE,
    version         VARCHAR(20) NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    notes           TEXT NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'rolling_out', 'live', 'rolled_back')),
    rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
    released_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (module_code, version)
);
INSERT INTO public.module_releases (module_code, version, notes, status, rollout_percent, released_at)
VALUES ('student_information', '1.0.0', 'First release: student directory, enrolment, guardians, academic years, grades, sections and subjects.', 'live', 100, NOW());

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['feature_flags', 'module_bundles', 'module_releases']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['module_dependencies', 'feature_flags', 'module_bundles', 'module_releases']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

INSERT INTO public.platform_settings (key, value) VALUES
    ('modules.allow_addons', 'true'::jsonb),
    ('modules.show_locked', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
