-- Teacher portal: which teacher a student's feedback is about, who answered a staff survey, and which written comments may be shown.
ALTER TABLE public.survey_responses
    ADD COLUMN IF NOT EXISTS teacher_id    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS respondent_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.survey_answers ADD COLUMN IF NOT EXISTS moderated BOOLEAN NOT NULL DEFAULT FALSE;

-- who has answered a survey, kept apart from the answers so an anonymous survey stays anonymous
CREATE TABLE IF NOT EXISTS public.survey_participation (
    survey_id  UUID NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (survey_id, profile_id)
);
ALTER TABLE public.survey_participation ENABLE ROW LEVEL SECURITY;
