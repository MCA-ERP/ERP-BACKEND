-- ====================================================================
-- MIGRATION 031: SCHOOL MANAGEMENT PAGES
-- Campus details, application codes and the "documents pending" step, school branding
-- names, and what each school administrator may open.
-- ====================================================================

-- campuses: what the Campus pages show
ALTER TABLE public.campuses
    ADD COLUMN IF NOT EXISTS classes_offered VARCHAR(100),
    ADD COLUMN IF NOT EXISTS facilities      TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS classrooms      INTEGER CHECK (classrooms IS NULL OR classrooms >= 0),
    ADD COLUMN IF NOT EXISTS opened_year     INTEGER CHECK (opened_year IS NULL OR opened_year BETWEEN 1800 AND 2100);

-- schools: how the school appears in its apps and on receipts
ALTER TABLE public.institutions
    ADD COLUMN IF NOT EXISTS app_name        VARCHAR(100),
    ADD COLUMN IF NOT EXISTS receipt_header  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS own_branding    BOOLEAN NOT NULL DEFAULT FALSE;

-- applications: a short number (APP-0012) and a step for "we asked the school for documents"
ALTER TABLE public.school_applications ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.school_applications ALTER COLUMN status TYPE VARCHAR(20);
ALTER TABLE public.school_applications DROP CONSTRAINT IF EXISTS school_applications_status_check;
ALTER TABLE public.school_applications
    ADD CONSTRAINT school_applications_status_check CHECK (status IN ('new', 'in_review', 'documents_pending', 'converted', 'rejected'));

-- people: a job title, and which areas a school administrator may open (empty means everything)
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS designation  VARCHAR(100),
    ADD COLUMN IF NOT EXISTS admin_access JSONB NOT NULL DEFAULT '{}';
