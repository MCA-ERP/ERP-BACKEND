-- Student transfers, behaviour, health, achievements, withdrawals and issued certificates.
CREATE SEQUENCE public.stu_withdrawal_seq START 1001;

CREATE TABLE public.stu_records (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    kind           VARCHAR(24) NOT NULL CHECK (kind IN ('transfer_within', 'transfer_campus', 'behaviour', 'disciplinary', 'remark', 'medical', 'incident', 'ach_academic', 'ach_sports', 'ach_cultural')),
    title          VARCHAR(300) NOT NULL,
    extra          VARCHAR(150),
    from_label     VARCHAR(80),
    to_label       VARCHAR(80),
    to_ref         UUID,
    record_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(20) NOT NULL,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stu_records_school ON public.stu_records (institution_id, kind, record_date DESC);

CREATE TABLE public.stu_withdrawals (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('WD-' || nextval('public.stu_withdrawal_seq')),
    reason         VARCHAR(200) NOT NULL,
    last_day       DATE NOT NULL,
    dues           INTEGER NOT NULL DEFAULT 0 CHECK (dues >= 0),
    requested_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Completed')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_stu_withdrawals_school ON public.stu_withdrawals (institution_id, requested_on DESC);

CREATE TABLE public.stu_certificates (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    kind           VARCHAR(12) NOT NULL CHECK (kind IN ('Bonafide', 'Study', 'Character', 'Transfer')),
    cert_no        VARCHAR(40) NOT NULL,
    purpose        VARCHAR(150),
    issued_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    issued_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stu_certificates_school ON public.stu_certificates (institution_id, issued_on DESC);
ALTER TABLE public.stu_records      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stu_withdrawals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stu_certificates ENABLE ROW LEVEL SECURITY;
