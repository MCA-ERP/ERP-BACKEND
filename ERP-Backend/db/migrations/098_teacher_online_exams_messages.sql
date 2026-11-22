-- Teacher portal: online classes and tests, exam duties and papers, holistic cards, competitive prep, parent messages.

-- online classes: how long, on what, recorded or not, the recording
ALTER TABLE public.online_classes
    ADD COLUMN IF NOT EXISTS duration_min    INTEGER NOT NULL DEFAULT 45 CHECK (duration_min BETWEEN 5 AND 300),
    ADD COLUMN IF NOT EXISTS platform        VARCHAR(20) NOT NULL DEFAULT 'Google Meet',
    ADD COLUMN IF NOT EXISTS record          BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS notify          BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS recording_name  VARCHAR(160),
    ADD COLUMN IF NOT EXISTS recording_views INTEGER NOT NULL DEFAULT 0 CHECK (recording_views >= 0);

-- online tests: a code, the day it opens, who made it, its questions and the students' attempts
CREATE SEQUENCE IF NOT EXISTS public.online_test_seq START 311;
ALTER TABLE public.online_tests
    ADD COLUMN IF NOT EXISTS code       VARCHAR(12) NOT NULL DEFAULT ('T-' || nextval('public.online_test_seq')),
    ADD COLUMN IF NOT EXISTS opens_on   DATE,
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS public.online_test_questions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    test_id        UUID NOT NULL REFERENCES public.online_tests(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL CHECK (position >= 1),
    question       VARCHAR(1000) NOT NULL,
    option_a       VARCHAR(300) NOT NULL,
    option_b       VARCHAR(300) NOT NULL,
    option_c       VARCHAR(300) NOT NULL DEFAULT '',
    option_d       VARCHAR(300) NOT NULL DEFAULT '',
    correct        CHAR(1) NOT NULL CHECK (correct IN ('A', 'B', 'C', 'D')),
    UNIQUE (test_id, position)
);
CREATE TABLE IF NOT EXISTS public.online_test_attempts (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    test_id        UUID NOT NULL REFERENCES public.online_tests(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    score_pct      NUMERIC(5, 1) NOT NULL CHECK (score_pct BETWEEN 0 AND 100),
    submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (test_id, student_id)
);

-- exam papers: the question paper the setter uploaded; duty swaps
ALTER TABLE public.exam_papers
    ADD COLUMN IF NOT EXISTS paper_file        VARCHAR(160),
    ADD COLUMN IF NOT EXISTS paper_uploaded_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS public.exam_duty_swaps (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    paper_id       UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
    requested_by   UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    reason         VARCHAR(300) NOT NULL DEFAULT '',
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (paper_id, requested_by)
);

-- holistic progress card: a level in each domain and the teacher's comment, per student and term
CREATE TABLE IF NOT EXISTS public.holistic_cards (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    term           VARCHAR(10) NOT NULL CHECK (term IN ('Term 1', 'Term 2')),
    domains        JSONB NOT NULL DEFAULT '{}',
    comment        VARCHAR(1000) NOT NULL DEFAULT '',
    updated_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (student_id, term)
);

-- competitive prep: when a batch meets, what a mock covers, chapter accuracy per student
ALTER TABLE public.comp_programmes ADD COLUMN IF NOT EXISTS schedule VARCHAR(60) NOT NULL DEFAULT '';
ALTER TABLE public.comp_tests
    ADD COLUMN IF NOT EXISTS chapters   TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS easy       INTEGER NOT NULL DEFAULT 0 CHECK (easy >= 0),
    ADD COLUMN IF NOT EXISTS medium     INTEGER NOT NULL DEFAULT 0 CHECK (medium >= 0),
    ADD COLUMN IF NOT EXISTS hard       INTEGER NOT NULL DEFAULT 0 CHECK (hard >= 0),
    ADD COLUMN IF NOT EXISTS negative   VARCHAR(20) NOT NULL DEFAULT 'None',
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS public.comp_chapter_scores (
    test_id    UUID NOT NULL REFERENCES public.comp_tests(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    chapter    VARCHAR(120) NOT NULL,
    accuracy   INTEGER NOT NULL CHECK (accuracy BETWEEN 0 AND 100),
    PRIMARY KEY (test_id, student_id, chapter)
);

-- parent messages: which way a message went, who it was for, what it answers, how it was sent
ALTER TABLE public.parent_messages
    ADD COLUMN IF NOT EXISTS direction     VARCHAR(3) NOT NULL DEFAULT 'out' CHECK (direction IN ('in', 'out')),
    ADD COLUMN IF NOT EXISTS to_teacher_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reply_to      UUID REFERENCES public.parent_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS channel       VARCHAR(12) NOT NULL DEFAULT 'App',
    ADD COLUMN IF NOT EXISTS batch_id      UUID;
CREATE INDEX IF NOT EXISTS idx_parent_messages_teacher ON public.parent_messages (institution_id, to_teacher_id) WHERE direction = 'in';

ALTER TABLE public.online_test_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.online_test_attempts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_duty_swaps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holistic_cards        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_chapter_scores   ENABLE ROW LEVEL SECURITY;
