-- Student attendance, attendance corrections, grading / passing / promotion rules, and more calendar entry types.
CREATE SEQUENCE public.att_correction_seq START 451;

ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_kind_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_kind_check CHECK (kind IN ('Holiday', 'Exam', 'PTM', 'Event', 'Sports', 'Fee due', 'Staff'));
ALTER TABLE public.calendar_events ALTER COLUMN kind TYPE VARCHAR(10);
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS note VARCHAR(300);

CREATE TABLE public.academic_rules (
    institution_id      UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    grading_scale       VARCHAR(30) NOT NULL DEFAULT 'CBSE 8-point (A1 – E)' CHECK (grading_scale IN ('CBSE 8-point (A1 – E)', '5-point (A – E)', 'Percentage only')),
    primary_grading     VARCHAR(40) NOT NULL DEFAULT 'Descriptive indicators + grades' CHECK (primary_grading IN ('Descriptive indicators + grades', 'Descriptive indicators only', 'Same as above')),
    pass_mark           INTEGER NOT NULL DEFAULT 33 CHECK (pass_mark BETWEEN 0 AND 100),
    pass_mark_theory    INTEGER NOT NULL DEFAULT 33 CHECK (pass_mark_theory BETWEEN 0 AND 100),
    grace_marks         INTEGER NOT NULL DEFAULT 5 CHECK (grace_marks BETWEEN 0 AND 20),
    retest_subjects     INTEGER NOT NULL DEFAULT 1 CHECK (retest_subjects BETWEEN 0 AND 5),
    auto_promote        BOOLEAN NOT NULL DEFAULT TRUE,
    min_attendance      INTEGER NOT NULL DEFAULT 75 CHECK (min_attendance BETWEEN 0 AND 100),
    fail_one_action     VARCHAR(30) NOT NULL DEFAULT 'Re-test, then promote' CHECK (fail_one_action IN ('Re-test, then promote', 'Detain', 'Promote with support')),
    no_detention_upto   VARCHAR(20) NOT NULL DEFAULT 'Always promote' CHECK (no_detention_upto IN ('Always promote', 'Follow the rules')),
    detention_approver  VARCHAR(20) NOT NULL DEFAULT 'Principal' CHECK (detention_approver IN ('Principal', 'Vice Principal', 'Class teacher')),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.attendance_records (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    section_id     UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    att_date       DATE NOT NULL,
    status         CHAR(1) NOT NULL CHECK (status IN ('P', 'A', 'L', 'H', 'V')),
    marked_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (student_id, att_date)
);
CREATE INDEX idx_attendance_day ON public.attendance_records (institution_id, att_date);
CREATE INDEX idx_attendance_section ON public.attendance_records (section_id, att_date);

CREATE TABLE public.attendance_corrections (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('AC-' || lpad(nextval('public.att_correction_seq')::text, 4, '0')),
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    att_date       DATE NOT NULL,
    marked         VARCHAR(12) NOT NULL,
    should_be      CHAR(1) NOT NULL CHECK (should_be IN ('P', 'A', 'L', 'H', 'V')),
    reason         VARCHAR(300) NOT NULL,
    requested_by   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_att_corrections_school ON public.attendance_corrections (institution_id, created_at DESC);

ALTER TABLE public.academic_rules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_corrections  ENABLE ROW LEVEL SECURITY;
