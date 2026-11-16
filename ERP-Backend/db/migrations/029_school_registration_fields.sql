-- Extra details collected when a school is registered (Add School wizard).
-- All optional, so existing schools are unaffected.
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS medium_of_instruction text,
  ADD COLUMN IF NOT EXISTS classes_offered text,
  ADD COLUMN IF NOT EXISTS student_estimate integer CHECK (student_estimate IS NULL OR student_estimate >= 0),
  ADD COLUMN IF NOT EXISTS udise_code text;
