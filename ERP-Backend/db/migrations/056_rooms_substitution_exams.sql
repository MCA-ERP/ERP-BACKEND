-- Rooms, substitutions, exam types and marks settings.
CREATE TABLE public.rooms (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(40) NOT NULL,
    block          VARCHAR(40),
    capacity       INTEGER NOT NULL DEFAULT 40 CHECK (capacity BETWEEN 1 AND 1000),
    section_id     UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    projector      BOOLEAN NOT NULL DEFAULT FALSE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available', 'Occupied', 'Maintenance')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, name)
);

CREATE TABLE public.substitutions (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id     UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    sub_date           DATE NOT NULL,
    period_id          UUID NOT NULL REFERENCES public.tt_periods(id) ON DELETE CASCADE,
    section_id         UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id         UUID REFERENCES public.subjects(id) ON DELETE SET NULL,
    absent_teacher_id  UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    substitute_id      UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    status             VARCHAR(10) NOT NULL DEFAULT 'Assigned' CHECK (status IN ('Pending', 'Assigned', 'Completed')),
    created_by         UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sub_date, period_id, section_id)
);
CREATE INDEX idx_substitutions_school ON public.substitutions (institution_id, sub_date DESC);

CREATE TABLE public.exam_types (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(60) NOT NULL,
    weightage      INTEGER CHECK (weightage BETWEEN 0 AND 100),
    included       BOOLEAN NOT NULL DEFAULT FALSE,
    max_marks      INTEGER NOT NULL CHECK (max_marks BETWEEN 1 AND 1000),
    max_marks_alt  INTEGER CHECK (max_marks_alt BETWEEN 1 AND 1000),
    classes        VARCHAR(40) NOT NULL DEFAULT '',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, name)
);

CREATE TABLE public.exam_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    config         JSONB NOT NULL DEFAULT '{}'
);

ALTER TABLE public.rooms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.substitutions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_types     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_settings  ENABLE ROW LEVEL SECURITY;
