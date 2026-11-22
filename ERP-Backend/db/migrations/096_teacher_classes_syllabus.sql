-- Teacher portal, classes and subjects: how far each section has got through each chapter of the syllabus.
CREATE TABLE IF NOT EXISTS public.syllabus_progress (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    section_id     UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    chapter_id     UUID NOT NULL REFERENCES public.curriculum_chapters(id) ON DELETE CASCADE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'In progress', 'Done')),
    updated_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (section_id, chapter_id)
);
CREATE INDEX IF NOT EXISTS idx_syllabus_progress_school ON public.syllabus_progress (institution_id);
ALTER TABLE public.syllabus_progress ENABLE ROW LEVEL SECURITY;
