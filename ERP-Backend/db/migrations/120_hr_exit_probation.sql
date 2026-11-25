-- HR staff exit and probation: the paid final settlement, exit interviews and probation reviews.
ALTER TABLE public.hr_exits
    ADD COLUMN IF NOT EXISTS settled_on    DATE,
    ADD COLUMN IF NOT EXISTS settled_lines JSONB,
    ADD COLUMN IF NOT EXISTS settled_net   INTEGER CHECK (settled_net >= 0),
    ADD COLUMN IF NOT EXISTS settled_ref   VARCHAR(80),
    ADD COLUMN IF NOT EXISTS settled_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.hr_exit_interviews (
    exit_id        UUID PRIMARY KEY REFERENCES public.hr_exits(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    reason         VARCHAR(80) NOT NULL,
    would_rejoin   BOOLEAN NOT NULL,
    said           VARCHAR(500) NOT NULL DEFAULT '',
    recorded_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    recorded_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.hr_probation_reviews (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    probation_id   UUID NOT NULL REFERENCES public.hr_probation(id) ON DELETE CASCADE,
    kind           VARCHAR(20) NOT NULL CHECK (kind IN ('Monthly', 'End of probation')),
    ratings        SMALLINT[] NOT NULL CHECK (array_length(ratings, 1) = 6 AND 1 <= ALL (ratings) AND 5 >= ALL (ratings)),
    recommendation VARCHAR(10) NOT NULL CHECK (recommendation IN ('Confirm', 'Extend', 'End')),
    comments       VARCHAR(500) NOT NULL DEFAULT '',
    reviewed_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    reviewed_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_hr_prob_reviews ON public.hr_probation_reviews (institution_id, probation_id);

-- Only the server reads these (row level security with no policy keeps them closed to signed-in browsers).
ALTER TABLE public.hr_exit_interviews   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_probation_reviews ENABLE ROW LEVEL SECURITY;
