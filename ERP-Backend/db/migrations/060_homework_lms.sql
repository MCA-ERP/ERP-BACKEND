-- Homework, assignments, study materials, online classes, online tests and student submissions.
CREATE SEQUENCE public.homework_seq START 8121;
CREATE SEQUENCE public.assignment_seq START 3301;

CREATE TABLE public.homework (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('HW-' || nextval('public.homework_seq')),
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    title          VARCHAR(200) NOT NULL,
    given_by       UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    given_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    due_on         DATE NOT NULL,
    submitted_pct  INTEGER CHECK (submitted_pct BETWEEN 0 AND 100),
    attachments    TEXT[] NOT NULL DEFAULT '{}',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Closed', 'Draft')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (due_on >= given_on)
);
CREATE INDEX idx_homework_school ON public.homework (institution_id, given_on DESC);

CREATE TABLE public.assignments (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('AS-' || nextval('public.assignment_seq')),
    title          VARCHAR(200) NOT NULL,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    assigned_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    due_on         DATE NOT NULL,
    max_marks      INTEGER NOT NULL CHECK (max_marks BETWEEN 1 AND 200),
    status         VARCHAR(10) NOT NULL DEFAULT 'Assigned' CHECK (status IN ('Assigned', 'Draft', 'Closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.study_materials (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    title          VARCHAR(200) NOT NULL,
    kind           VARCHAR(8) NOT NULL CHECK (kind IN ('Notes', 'PDFs', 'Videos', 'Links')),
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    files          TEXT[] NOT NULL DEFAULT '{}',
    uploaded_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    uploaded_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    views          INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
    status         VARCHAR(10) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.online_classes (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(200) NOT NULL,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    teacher_id     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    session_date   DATE NOT NULL,
    session_time   TIME NOT NULL,
    link           VARCHAR(300) NOT NULL DEFAULT '',
    attended_pct   INTEGER CHECK (attended_pct BETWEEN 0 AND 100),
    status         VARCHAR(10) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed', 'Cancelled')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.online_tests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(200) NOT NULL,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    questions      INTEGER NOT NULL CHECK (questions BETWEEN 1 AND 300),
    minutes        INTEGER NOT NULL CHECK (minutes BETWEEN 5 AND 300),
    attempted_pct  INTEGER CHECK (attempted_pct BETWEEN 0 AND 100),
    average_pct    INTEGER CHECK (average_pct BETWEEN 0 AND 100),
    status         VARCHAR(8) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Open', 'Closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.hw_submissions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    homework_id    UUID NOT NULL REFERENCES public.homework(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    submitted_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    marks          NUMERIC(5, 1) CHECK (marks >= 0),
    feedback       VARCHAR(500),
    status         VARCHAR(12) NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Pending', 'Late', 'Reassessment')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (homework_id, student_id)
);
CREATE INDEX idx_hw_submissions_school ON public.hw_submissions (institution_id, submitted_on DESC);

ALTER TABLE public.homework        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.online_classes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.online_tests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hw_submissions  ENABLE ROW LEVEL SECURITY;
