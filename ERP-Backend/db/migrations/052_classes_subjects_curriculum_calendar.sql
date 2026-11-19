-- Class and section details, subject categories, teacher subjects, curriculum, lesson plans and the academic calendar.
ALTER TABLE public.grades   ADD COLUMN IF NOT EXISTS stage VARCHAR(20), ADD COLUMN IF NOT EXISTS campus_id UUID REFERENCES public.campuses(id) ON DELETE SET NULL;
ALTER TABLE public.sections ADD COLUMN IF NOT EXISTS room VARCHAR(30), ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.subjects ADD COLUMN IF NOT EXISTS category VARCHAR(30), ADD COLUMN IF NOT EXISTS subject_type VARCHAR(20) NOT NULL DEFAULT 'Theory';

CREATE TABLE public.teacher_subjects (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    teacher_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    section_id     UUID REFERENCES public.sections(id) ON DELETE CASCADE,
    periods        INTEGER NOT NULL DEFAULT 1 CHECK (periods BETWEEN 1 AND 60),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_teacher_subject ON public.teacher_subjects (teacher_id, subject_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'));
CREATE INDEX idx_teacher_subjects_school ON public.teacher_subjects (institution_id);

CREATE TABLE public.curriculum_chapters (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    grade_id       UUID NOT NULL REFERENCES public.grades(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    chapter        VARCHAR(200) NOT NULL,
    periods        INTEGER NOT NULL DEFAULT 1 CHECK (periods BETWEEN 1 AND 200),
    objective      VARCHAR(300),
    planned_month  VARCHAR(3),
    status         VARCHAR(12) NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'In progress', 'Completed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_curriculum_school ON public.curriculum_chapters (institution_id, grade_id);

CREATE TABLE public.lesson_plans (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    teacher_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    topic          VARCHAR(200) NOT NULL,
    week_of        DATE NOT NULL,
    periods        INTEGER NOT NULL DEFAULT 1 CHECK (periods BETWEEN 1 AND 60),
    progress       INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    status         VARCHAR(12) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted', 'Approved', 'Returned')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lesson_plans_school ON public.lesson_plans (institution_id, week_of DESC);

CREATE TABLE public.calendar_events (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    title          VARCHAR(200) NOT NULL,
    event_date     DATE NOT NULL,
    end_date       DATE,
    kind           VARCHAR(8) NOT NULL CHECK (kind IN ('Holiday', 'Exam', 'Event')),
    audience       VARCHAR(60) NOT NULL DEFAULT 'Everyone',
    published      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date IS NULL OR end_date >= event_date)
);
CREATE INDEX idx_calendar_school ON public.calendar_events (institution_id, event_date);

CREATE TABLE public.calendar_settings (
    institution_id        UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    school_week           VARCHAR(20) NOT NULL DEFAULT 'Monday – Saturday' CHECK (school_week IN ('Monday – Saturday', 'Monday – Friday')),
    saturday_hours        VARCHAR(24) NOT NULL DEFAULT 'Full day' CHECK (saturday_hours IN ('Full day', 'Half day (till 12:30)', 'Off')),
    show_holidays_in_app  BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE public.teacher_subjects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.curriculum_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_settings   ENABLE ROW LEVEL SECURITY;
