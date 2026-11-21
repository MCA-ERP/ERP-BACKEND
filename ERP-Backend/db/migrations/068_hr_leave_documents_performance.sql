-- HR: leave types and policy, the approval chain, staff documents, and staff performance.
CREATE TABLE public.hr_leave_types (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(60) NOT NULL,
    days_per_year  INTEGER NOT NULL DEFAULT 0 CHECK (days_per_year BETWEEN 0 AND 366),
    carry_forward  VARCHAR(40) NOT NULL DEFAULT 'No',
    needs_proof    VARCHAR(40) NOT NULL DEFAULT 'No',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.hr_leave_policy (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    sandwich       VARCHAR(30) NOT NULL DEFAULT 'For casual leave only',
    half_day       VARCHAR(30) NOT NULL DEFAULT 'Casual and sick leave',
    medical_days   INTEGER NOT NULL DEFAULT 2 CHECK (medical_days BETWEEN 0 AND 60),
    earned_notice  INTEGER NOT NULL DEFAULT 7 CHECK (earned_notice BETWEEN 0 AND 90),
    carry_forward  INTEGER NOT NULL DEFAULT 45 CHECK (carry_forward BETWEEN 0 AND 365),
    encash_year    INTEGER NOT NULL DEFAULT 10 CHECK (encash_year BETWEEN 0 AND 365),
    encash_exit    INTEGER NOT NULL DEFAULT 45 CHECK (encash_exit BETWEEN 0 AND 365),
    compoff_days   INTEGER NOT NULL DEFAULT 60 CHECK (compoff_days BETWEEN 1 AND 365),
    probation      VARCHAR(40) NOT NULL DEFAULT 'Casual leave after 3 months',
    runout         VARCHAR(20) NOT NULL DEFAULT 'Loss of pay'
);
CREATE SEQUENCE public.leave_code_seq START 1183;
ALTER TABLE public.leave_requests
    ADD COLUMN code        VARCHAR(12) NOT NULL DEFAULT ('LV-' || nextval('public.leave_code_seq')),
    ADD COLUMN level       INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
    ADD COLUMN level_since TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE public.hr_documents (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    doc_type       VARCHAR(12) NOT NULL CHECK (doc_type IN ('Certificates', 'ID proof', 'Contracts')),
    file_name      VARCHAR(160) NOT NULL,
    uploaded_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until    DATE,
    status         VARCHAR(14) NOT NULL DEFAULT 'Pending review' CHECK (status IN ('Pending review', 'Verified'))
);
CREATE INDEX idx_hr_documents_school ON public.hr_documents (institution_id, doc_type);

CREATE TABLE public.hr_appraisals (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('Appraisals', 'Reviews', 'Ratings')),
    reviewer       VARCHAR(100) NOT NULL DEFAULT '',
    period         VARCHAR(30) NOT NULL DEFAULT '',
    rating         INTEGER CHECK (rating BETWEEN 1 AND 5),
    remarks        VARCHAR(200) NOT NULL DEFAULT '',
    status         VARCHAR(12) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'In progress', 'Completed'))
);
CREATE TABLE public.hr_feedback360 (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    cycle          VARCHAR(10) NOT NULL,
    self_score     NUMERIC(2, 1) CHECK (self_score BETWEEN 0 AND 5),
    peers          NUMERIC(2, 1) CHECK (peers BETWEEN 0 AND 5),
    hod            NUMERIC(2, 1) CHECK (hod BETWEEN 0 AND 5),
    students       NUMERIC(2, 1) CHECK (students BETWEEN 0 AND 5),
    parents        NUMERIC(2, 1) CHECK (parents BETWEEN 0 AND 5),
    students_n     INTEGER NOT NULL DEFAULT 0 CHECK (students_n >= 0),
    parents_n      INTEGER NOT NULL DEFAULT 0 CHECK (parents_n >= 0),
    PRIMARY KEY (institution_id, staff_id, cycle)
);
CREATE TABLE public.hr_competency (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    competency     VARCHAR(40) NOT NULL,
    level          INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
    PRIMARY KEY (institution_id, staff_id, competency)
);
CREATE TABLE public.hr_cycle (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    cycle          VARCHAR(10) NOT NULL,
    reviewer       VARCHAR(100) NOT NULL DEFAULT '',
    self_score     NUMERIC(2, 1) CHECK (self_score BETWEEN 0 AND 5),
    reviewer_score NUMERIC(2, 1) CHECK (reviewer_score BETWEEN 0 AND 5),
    closed         BOOLEAN NOT NULL DEFAULT FALSE,
    inc_pct        INTEGER CHECK (inc_pct BETWEEN 0 AND 50),
    inc_sent       BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (institution_id, staff_id, cycle)
);
CREATE TABLE public.hr_kras (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    grp            VARCHAR(20) NOT NULL CHECK (grp IN ('Teacher', 'Non-teaching', 'Driver')),
    area           VARCHAR(100) NOT NULL,
    weight         INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 100),
    measure        VARCHAR(240) NOT NULL DEFAULT '',
    UNIQUE (institution_id, grp, area)
);
CREATE TABLE public.hr_perf_settings (
    institution_id   UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    increment_budget NUMERIC(4, 1) NOT NULL DEFAULT 7.2 CHECK (increment_budget BETWEEN 0 AND 50)
);

ALTER TABLE public.hr_leave_types   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_policy  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_appraisals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_feedback360   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_competency    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_cycle         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_kras          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_perf_settings ENABLE ROW LEVEL SECURITY;
