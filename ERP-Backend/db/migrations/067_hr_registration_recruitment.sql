-- HR: departments, designations, employee profile details, recruitment (openings, candidates, interviews, background checks, offers).
CREATE TABLE public.hr_departments (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(60) NOT NULL,
    head_id        UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    campus_id      UUID REFERENCES public.campuses(id) ON DELETE SET NULL,
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.hr_designations (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(100) NOT NULL,
    level          VARCHAR(4) NOT NULL DEFAULT 'L1',
    pay_band       VARCHAR(40) NOT NULL DEFAULT '',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);

ALTER TABLE public.hr_staff
    ADD COLUMN gender            VARCHAR(10),
    ADD COLUMN date_of_birth     DATE,
    ADD COLUMN blood_group       VARCHAR(4),
    ADD COLUMN marital_status    VARCHAR(10),
    ADD COLUMN pan               VARCHAR(10),
    ADD COLUMN aadhaar_last4     VARCHAR(4),
    ADD COLUMN address           VARCHAR(300),
    ADD COLUMN emergency_contact VARCHAR(160),
    ADD COLUMN monthly_salary    INTEGER CHECK (monthly_salary >= 0),
    ADD COLUMN qualification     VARCHAR(120);

CREATE TABLE public.hr_qualifications (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    profile_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    title          VARCHAR(100) NOT NULL,
    place          VARCHAR(120) NOT NULL DEFAULT '',
    year           INTEGER CHECK (year BETWEEN 1950 AND 2100),
    result         VARCHAR(60) NOT NULL DEFAULT ''
);
CREATE TABLE public.hr_experience (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    profile_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    organisation   VARCHAR(120) NOT NULL,
    role           VARCHAR(100) NOT NULL,
    from_on        DATE NOT NULL,
    to_on          DATE
);

CREATE SEQUENCE public.hr_app_seq START 731;
CREATE SEQUENCE public.hr_cv_seq START 2220;
CREATE SEQUENCE public.hr_offer_seq START 119;
CREATE TABLE public.hr_openings (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    position       VARCHAR(100) NOT NULL,
    department     VARCHAR(60) NOT NULL DEFAULT '',
    posted_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    closes_on      DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Interviewing', 'Closed')),
    req_qualification VARCHAR(120) NOT NULL DEFAULT '',
    needs_bed      BOOLEAN NOT NULL DEFAULT FALSE,
    min_experience INTEGER NOT NULL DEFAULT 0 CHECK (min_experience >= 0),
    budget_annual  INTEGER NOT NULL DEFAULT 0 CHECK (budget_annual >= 0)
);
CREATE TABLE public.hr_candidates (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    app_code       VARCHAR(12) NOT NULL DEFAULT ('JA-' || lpad(nextval('public.hr_app_seq')::text, 4, '0')),
    cv_code        VARCHAR(12) NOT NULL DEFAULT ('CV-' || nextval('public.hr_cv_seq')),
    opening_id     UUID REFERENCES public.hr_openings(id) ON DELETE SET NULL,
    name           VARCHAR(120) NOT NULL,
    current_org    VARCHAR(120) NOT NULL DEFAULT '',
    city           VARCHAR(60) NOT NULL DEFAULT '',
    qualification  VARCHAR(120) NOT NULL DEFAULT '',
    experience     INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
    expected_annual INTEGER NOT NULL DEFAULT 0 CHECK (expected_annual >= 0),
    source         VARCHAR(20) NOT NULL DEFAULT 'Careers page',
    stage          VARCHAR(20) NOT NULL DEFAULT 'New' CHECK (stage IN ('New', 'Shortlisted', 'Interview scheduled', 'Interviewed', 'Selected', 'On hold', 'Rejected', 'Offered', 'Accepted')),
    demo_score     NUMERIC(3, 1) CHECK (demo_score BETWEEN 0 AND 10),
    applied_on     DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE INDEX idx_hr_candidates_school ON public.hr_candidates (institution_id, applied_on DESC);
CREATE TABLE public.hr_interviews (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    candidate_id   UUID NOT NULL REFERENCES public.hr_candidates(id) ON DELETE CASCADE,
    panel          VARCHAR(160) NOT NULL DEFAULT '',
    on_date        DATE NOT NULL,
    at_time        TIME NOT NULL,
    mode           VARCHAR(12) NOT NULL DEFAULT 'In person' CHECK (mode IN ('In person', 'Video call', 'Phone')),
    status         VARCHAR(10) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed', 'Cancelled')),
    score          NUMERIC(3, 1) CHECK (score BETWEEN 0 AND 10)
);
CREATE TABLE public.hr_checks (
    candidate_id   UUID PRIMARY KEY REFERENCES public.hr_candidates(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    employer       BOOLEAN NOT NULL DEFAULT FALSE,
    refs           BOOLEAN NOT NULL DEFAULT FALSE,
    police         BOOLEAN NOT NULL DEFAULT FALSE,
    certificates   BOOLEAN NOT NULL DEFAULT FALSE,
    id_address     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE public.hr_offers (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('OF-' || nextval('public.hr_offer_seq')),
    candidate_id   UUID NOT NULL REFERENCES public.hr_candidates(id) ON DELETE CASCADE,
    annual_cost    INTEGER NOT NULL CHECK (annual_cost > 0),
    joining_on     DATE NOT NULL,
    probation      INTEGER NOT NULL DEFAULT 6 CHECK (probation BETWEEN 0 AND 24),
    valid_days     INTEGER NOT NULL DEFAULT 7 CHECK (valid_days BETWEEN 1 AND 60),
    sent_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Sent' CHECK (status IN ('Sent', 'Accepted', 'Declined')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);

ALTER TABLE public.hr_departments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_designations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_qualifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_experience      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_openings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_candidates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_interviews      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_checks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_offers          ENABLE ROW LEVEL SECURITY;
