-- Exams, papers, marks, the question bank and co-scholastic grades.
CREATE SEQUENCE public.question_seq START 4001;

CREATE TABLE public.exams (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(100) NOT NULL,
    exam_type_id   UUID REFERENCES public.exam_types(id) ON DELETE SET NULL,
    classes        VARCHAR(40) NOT NULL DEFAULT '',
    starts_on      DATE NOT NULL,
    ends_on        DATE NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Marks entry', 'Results published')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_on >= starts_on),
    UNIQUE (institution_id, name)
);

CREATE TABLE public.exam_papers (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    exam_id        UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
    grade_id       UUID NOT NULL REFERENCES public.grades(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    paper_date     DATE NOT NULL,
    starts         TIME NOT NULL,
    ends           TIME NOT NULL,
    hall           VARCHAR(100),
    invigilator_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    status         VARCHAR(12) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed')),
    CHECK (ends > starts),
    UNIQUE (exam_id, grade_id, subject_id)
);
CREATE INDEX idx_exam_papers_exam ON public.exam_papers (institution_id, exam_id, paper_date);

CREATE TABLE public.exam_marks (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    exam_id        UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    component      VARCHAR(10) NOT NULL DEFAULT 'Theory' CHECK (component IN ('Theory', 'Practical', 'Internal')),
    marks          NUMERIC(5, 1) CHECK (marks >= 0),
    absent         BOOLEAN NOT NULL DEFAULT FALSE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted', 'Verified')),
    entered_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (exam_id, student_id, subject_id, component)
);
CREATE INDEX idx_exam_marks_exam ON public.exam_marks (institution_id, exam_id, subject_id);

CREATE TABLE public.question_bank (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('Q-' || nextval('public.question_seq')),
    grade_id       UUID NOT NULL REFERENCES public.grades(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    chapter        VARCHAR(200) NOT NULL DEFAULT '',
    qtype          VARCHAR(20) NOT NULL CHECK (qtype IN ('MCQ', 'Short answer', 'Long answer', 'Case-based')),
    marks          INTEGER NOT NULL CHECK (marks BETWEEN 1 AND 20),
    difficulty     VARCHAR(8) NOT NULL CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
    added_by       UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    source         VARCHAR(10) NOT NULL DEFAULT 'Created' CHECK (source IN ('Created', 'Uploaded')),
    status         VARCHAR(12) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Under review', 'Approved')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_question_bank_school ON public.question_bank (institution_id, created_at DESC);

CREATE TABLE public.coscholastic_grades (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    term           VARCHAR(10) NOT NULL CHECK (term IN ('Term 1', 'Term 2')),
    area           VARCHAR(40) NOT NULL,
    grade          CHAR(1) NOT NULL CHECK (grade IN ('A', 'B', 'C')),
    UNIQUE (student_id, term, area)
);

ALTER TABLE public.exams               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_papers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_marks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_bank       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coscholastic_grades ENABLE ROW LEVEL SECURITY;
