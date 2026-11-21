-- Onboarding checklist, probation, payroll heads, salary assignments and payroll runs.
ALTER TABLE public.hr_vacancies ADD COLUMN need_from DATE;
CREATE TABLE public.hr_onboard (
    candidate_id UUID NOT NULL REFERENCES public.hr_candidates(id) ON DELETE CASCADE,
    item_key     VARCHAR(30) NOT NULL,
    PRIMARY KEY (candidate_id, item_key)
);
CREATE TABLE public.hr_probation (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    started_on     DATE NOT NULL,
    ends_on        DATE NOT NULL,
    reviewer       VARCHAR(100) NOT NULL DEFAULT '',
    status         VARCHAR(10) NOT NULL DEFAULT 'On probation' CHECK (status IN ('On probation', 'Extended', 'Confirmed', 'Ended')),
    decided_on     DATE,
    CHECK (ends_on >= started_on)
);
CREATE TABLE public.pay_heads (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    htype          VARCHAR(10) NOT NULL CHECK (htype IN ('Earning', 'Allowance', 'Deduction')),
    calc           VARCHAR(120) NOT NULL DEFAULT '',
    taxable        VARCHAR(10) NOT NULL DEFAULT 'Yes',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    pos            INTEGER GENERATED ALWAYS AS IDENTITY,
    UNIQUE (institution_id, name)
);
CREATE TABLE public.pay_assign (
    staff_id       UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    structure      VARCHAR(40) NOT NULL DEFAULT '',
    basic          INTEGER NOT NULL CHECK (basic >= 0),
    allow_pct      INTEGER NOT NULL DEFAULT 100 CHECK (allow_pct BETWEEN 0 AND 500),
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    other_ded      INTEGER NOT NULL DEFAULT 0 CHECK (other_ded >= 0)
);
CREATE TABLE public.pay_runs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    month          CHAR(7) NOT NULL,
    status         VARCHAR(12) NOT NULL DEFAULT 'Calculated' CHECK (status IN ('Draft', 'Calculated', 'Verified', 'Approved', 'Paid')),
    staff          INTEGER NOT NULL DEFAULT 0,
    gross          BIGINT NOT NULL DEFAULT 0,
    deductions     BIGINT NOT NULL DEFAULT 0,
    net            BIGINT NOT NULL DEFAULT 0,
    calculated_on  DATE,
    UNIQUE (institution_id, month)
);
CREATE TABLE public.pay_run_lines (
    run_id       UUID NOT NULL REFERENCES public.pay_runs(id) ON DELETE CASCADE,
    staff_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    working_days INTEGER NOT NULL, present NUMERIC(4,1) NOT NULL, paid_leave NUMERIC(4,1) NOT NULL, lop NUMERIC(4,1) NOT NULL,
    gross INTEGER NOT NULL, deductions INTEGER NOT NULL, net INTEGER NOT NULL,
    PRIMARY KEY (run_id, staff_id)
);
ALTER TABLE public.hr_onboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_probation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_assign ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_run_lines ENABLE ROW LEVEL SECURITY;
