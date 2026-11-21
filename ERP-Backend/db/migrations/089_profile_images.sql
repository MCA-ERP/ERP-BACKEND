-- Principal signature and school seal images.
ALTER TABLE public.school_profile ADD COLUMN IF NOT EXISTS signature TEXT, ADD COLUMN IF NOT EXISTS seal TEXT;
