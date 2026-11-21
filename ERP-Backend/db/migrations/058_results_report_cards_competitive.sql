-- Marks verification state, report cards, and competitive exam programmes.
ALTER TABLE public.exam_marks DROP CONSTRAINT IF EXISTS exam_marks_status_check;
ALTER TABLE public.exam_marks ADD CONSTRAINT exam_marks_status_check CHECK (status IN ('Draft', 'Submitted', 'Verified', 'Returned'));
ALTER TABLE public.exam_marks ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

CREATE TABLE public.report_templates (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    about          VARCHAR(120) NOT NULL,
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Draft')),
    UNIQUE (institution_id, name)
);

CREATE TABLE public.report_card_runs (
    exam_id        UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Generated' CHECK (status IN ('Generated', 'Published')),
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at   TIMESTAMPTZ,
    PRIMARY KEY (exam_id, section_id)
);

CREATE TABLE public.comp_programmes (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name             VARCHAR(100) NOT NULL,
    exams            VARCHAR(200) NOT NULL DEFAULT '',
    who              VARCHAR(100) NOT NULL DEFAULT '',
    mentor_id        UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    sessions_per_week INTEGER NOT NULL DEFAULT 1 CHECK (sessions_per_week BETWEEN 0 AND 14),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.comp_members (
    programme_id UUID NOT NULL REFERENCES public.comp_programmes(id) ON DELETE CASCADE,
    student_id   UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    PRIMARY KEY (programme_id, student_id)
);
CREATE TABLE public.comp_tests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    programme_id   UUID NOT NULL REFERENCES public.comp_programmes(id) ON DELETE CASCADE,
    name           VARCHAR(120) NOT NULL,
    test_date      DATE NOT NULL,
    questions      INTEGER NOT NULL CHECK (questions BETWEEN 1 AND 500),
    minutes        INTEGER NOT NULL CHECK (minutes BETWEEN 5 AND 600)
);
CREATE TABLE public.comp_results (
    test_id    UUID NOT NULL REFERENCES public.comp_tests(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    score_pct  NUMERIC(5, 1) NOT NULL CHECK (score_pct BETWEEN 0 AND 100),
    PRIMARY KEY (test_id, student_id)
);
CREATE TABLE public.comp_bank (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    subject        VARCHAR(100) NOT NULL,
    easy           INTEGER NOT NULL DEFAULT 0 CHECK (easy >= 0),
    medium         INTEGER NOT NULL DEFAULT 0 CHECK (medium >= 0),
    hard           INTEGER NOT NULL DEFAULT 0 CHECK (hard >= 0),
    past_papers    VARCHAR(40) NOT NULL DEFAULT '',
    UNIQUE (institution_id, subject)
);
CREATE TABLE public.comp_registrations (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    exam           VARCHAR(100) NOT NULL,
    exam_date      DATE NOT NULL,
    fee            INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
    status         VARCHAR(16) NOT NULL DEFAULT 'Fee pending' CHECK (status IN ('Fee pending', 'Registered', 'Admit card issued'))
);

ALTER TABLE public.report_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_card_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_programmes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_tests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_bank          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_registrations ENABLE ROW LEVEL SECURITY;
