-- HR: staff exits and clearance, salary history, compliance calendar, scheduled reports, vacancies and sanctioned posts.
CREATE TABLE public.hr_exits (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    resigned_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    last_day       DATE NOT NULL,
    reason         VARCHAR(80) NOT NULL DEFAULT '',
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Relieved')),
    CHECK (last_day >= resigned_on)
);
CREATE INDEX idx_hr_exits_school ON public.hr_exits (institution_id, resigned_on DESC);
CREATE TABLE public.hr_clearance (
    exit_id UUID NOT NULL REFERENCES public.hr_exits(id) ON DELETE CASCADE,
    dept    VARCHAR(12) NOT NULL CHECK (dept IN ('Library', 'Store', 'Accounts', 'IT', 'Transport', 'Department')),
    state   VARCHAR(8) NOT NULL DEFAULT 'Pending' CHECK (state IN ('Pending', 'Cleared', 'n/a')),
    PRIMARY KEY (exit_id, dept)
);
CREATE TABLE public.hr_salary_history (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    from_on        DATE NOT NULL,
    before_amt     INTEGER,
    after_amt      INTEGER NOT NULL CHECK (after_amt >= 0),
    reason         VARCHAR(120) NOT NULL DEFAULT ''
);
CREATE TABLE public.hr_compliance (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    due_on         DATE NOT NULL,
    what           VARCHAR(80) NOT NULL,
    where_to       VARCHAR(80) NOT NULL DEFAULT '',
    period         VARCHAR(30) NOT NULL DEFAULT '',
    status         VARCHAR(6) NOT NULL DEFAULT 'Due' CHECK (status IN ('Due', 'Filed')),
    proof          VARCHAR(80),
    filed_on       DATE
);
CREATE TABLE public.hr_scheduled (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    report         VARCHAR(60) NOT NULL,
    how_often      VARCHAR(40) NOT NULL,
    send_to        VARCHAR(120) NOT NULL DEFAULT '',
    format         VARCHAR(6) NOT NULL DEFAULT 'PDF' CHECK (format IN ('PDF', 'Excel', 'CSV')),
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Paused')),
    last_run       DATE
);
CREATE SEQUENCE public.hr_vac_seq START 43;
CREATE TABLE public.hr_vacancies (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('VR-' || nextval('public.hr_vac_seq')),
    post           VARCHAR(100) NOT NULL,
    department     VARCHAR(60) NOT NULL DEFAULT '',
    vtype          VARCHAR(12) NOT NULL DEFAULT 'New post' CHECK (vtype IN ('New post', 'Replacement')),
    note           VARCHAR(200) NOT NULL DEFAULT '',
    posts          INTEGER NOT NULL DEFAULT 1 CHECK (posts BETWEEN 1 AND 50),
    cost_year      INTEGER NOT NULL DEFAULT 0 CHECK (cost_year >= 0),
    requested_by   VARCHAR(100) NOT NULL DEFAULT '',
    requested_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    stage          VARCHAR(12) NOT NULL DEFAULT 'Requested' CHECK (stage IN ('Requested', 'Principal OK', 'Approved', 'Posted', 'Filled', 'Rejected'))
);
CREATE TABLE public.hr_sanctioned (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    department     VARCHAR(60) NOT NULL,
    designation    VARCHAR(100) NOT NULL,
    sanctioned     INTEGER NOT NULL CHECK (sanctioned >= 0),
    UNIQUE (institution_id, department, designation)
);
ALTER TABLE public.hr_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_clearance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_salary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_compliance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_scheduled ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_vacancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_sanctioned ENABLE ROW LEVEL SECURITY;
