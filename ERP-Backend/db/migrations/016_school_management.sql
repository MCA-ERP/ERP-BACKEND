-- ====================================================================
-- MIGRATION 016: SCHOOL MANAGEMENT
-- Profile & branding fields, per-school configuration, contacts, documents,
-- applications, an event history, a primary admin, and an "Inactive" status
-- (a school switched off on purpose; data is kept and nobody can sign in).
-- ====================================================================

ALTER TABLE public.institutions DROP CONSTRAINT IF EXISTS chk_institution_status;
ALTER TABLE public.institutions
    ADD CONSTRAINT chk_institution_status
    CHECK (status IN ('Pending', 'Trial', 'Active', 'Overdue', 'Suspended', 'Expired', 'Inactive'));

ALTER TABLE public.institutions
    ADD COLUMN IF NOT EXISTS postal_code         VARCHAR(20),
    ADD COLUMN IF NOT EXISTS country             VARCHAR(100) DEFAULT 'India',
    ADD COLUMN IF NOT EXISTS established_year    INTEGER CHECK (established_year BETWEEN 1800 AND 2100),
    ADD COLUMN IF NOT EXISTS affiliation_number  VARCHAR(80),
    ADD COLUMN IF NOT EXISTS registration_number VARCHAR(80),
    ADD COLUMN IF NOT EXISTS tagline             VARCHAR(200),
    ADD COLUMN IF NOT EXISTS primary_color       VARCHAR(9),
    ADD COLUMN IF NOT EXISTS secondary_color     VARCHAR(9),
    ADD COLUMN IF NOT EXISTS config              JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS status_reason       TEXT,
    ADD COLUMN IF NOT EXISTS primary_admin_id    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.campuses
    ADD COLUMN IF NOT EXISTS phone          VARCHAR(30),
    ADD COLUMN IF NOT EXISTS email          VARCHAR(255),
    ADD COLUMN IF NOT EXISTS principal_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS is_main        BOOLEAN NOT NULL DEFAULT FALSE;

-- people to contact at the school
CREATE TABLE public.school_contacts (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    role           VARCHAR(40) NOT NULL,          -- Principal, Administrator, Accounts, IT, Other
    name           VARCHAR(150) NOT NULL,
    email          VARCHAR(255),
    phone          VARCHAR(30),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_school_contacts_inst ON public.school_contacts (institution_id);

-- registration and affiliation certificates (the number and where the file is kept; files are not stored here)
CREATE TABLE public.school_documents (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    category       VARCHAR(20) NOT NULL CHECK (category IN ('registration', 'affiliation')),
    doc_type       VARCHAR(100) NOT NULL,
    number         VARCHAR(100),
    issued_by      VARCHAR(150),
    issue_date     DATE,
    expiry_date    DATE,
    file_url       TEXT,
    status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
    notes          TEXT,
    verified_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    verified_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_school_documents_inst ON public.school_documents (institution_id);

-- everything that happened to a school, with old and new values where something changed
CREATE TABLE public.school_events (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    type           VARCHAR(40) NOT NULL,
    summary        TEXT NOT NULL,
    actor_id       UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    actor_name     VARCHAR(200),
    old_data       JSONB,
    new_data       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_school_events_inst ON public.school_events (institution_id, created_at DESC);

-- schools that asked to join
CREATE TABLE public.school_applications (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source             VARCHAR(10) NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'demo', 'referral')),
    school_name        VARCHAR(255) NOT NULL,
    contact_name       VARCHAR(150) NOT NULL,
    contact_email      VARCHAR(255) NOT NULL,
    contact_phone      VARCHAR(50),
    city               VARCHAR(100),
    state              VARCHAR(100),
    board              VARCHAR(50),
    student_estimate   INTEGER CHECK (student_estimate >= 0),
    plan_interest      VARCHAR(50),
    message            TEXT,
    status             VARCHAR(10) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'converted', 'rejected')),
    institution_id     UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
    notes              TEXT,
    decided_by         UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decided_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_school_applications_status ON public.school_applications (status, created_at DESC);

ALTER TABLE public.school_contacts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_applications ENABLE ROW LEVEL SECURITY;

-- existing schools: the oldest campus is the main one
UPDATE public.campuses c SET is_main = TRUE
WHERE c.id = (SELECT id FROM public.campuses c2 WHERE c2.institution_id = c.institution_id ORDER BY created_at LIMIT 1);
