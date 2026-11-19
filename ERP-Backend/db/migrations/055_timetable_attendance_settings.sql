-- Attendance settings, the bell schedule, class timetables, and the rules the generator follows.
ALTER TABLE public.att_settings ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';

CREATE TABLE public.tt_periods (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    label          VARCHAR(30) NOT NULL,
    starts         TIME NOT NULL,
    ends           TIME NOT NULL,
    kind           VARCHAR(8) NOT NULL DEFAULT 'Teaching' CHECK (kind IN ('Teaching', 'Break')),
    CHECK (ends > starts),
    UNIQUE (institution_id, label)
);

CREATE TABLE public.tt_slots (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    day            SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 6),
    period_id      UUID NOT NULL REFERENCES public.tt_periods(id) ON DELETE CASCADE,
    subject_id     UUID REFERENCES public.subjects(id) ON DELETE SET NULL,
    teacher_id     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    locked         BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (section_id, day, period_id)
);
CREATE INDEX idx_tt_slots_teacher ON public.tt_slots (institution_id, teacher_id, day, period_id);

CREATE TABLE public.tt_sections (
    section_id     UUID PRIMARY KEY REFERENCES public.sections(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published'))
);

CREATE TABLE public.tt_subject_rules (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    subject_id     UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    per_week       INTEGER NOT NULL DEFAULT 5 CHECK (per_week BETWEEN 0 AND 12),
    prefers        VARCHAR(10) NOT NULL DEFAULT 'Any' CHECK (prefers IN ('Any', 'Morning', 'Afternoon')),
    room           VARCHAR(60) NOT NULL DEFAULT 'Classroom',
    PRIMARY KEY (institution_id, subject_id)
);

CREATE TABLE public.tt_teacher_limits (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    teacher_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    day            SMALLINT CHECK (day BETWEEN 1 AND 6),
    period_labels  VARCHAR(100) NOT NULL DEFAULT '',
    reason         VARCHAR(200) NOT NULL DEFAULT '',
    source         VARCHAR(10) NOT NULL DEFAULT 'Manual' CHECK (source IN ('Manual', 'Words'))
);

CREATE TABLE public.tt_words (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    asked          VARCHAR(300) NOT NULL,
    understood     VARCHAR(300) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.tt_periods        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tt_slots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tt_sections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tt_subject_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tt_teacher_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tt_words          ENABLE ROW LEVEL SECURITY;
