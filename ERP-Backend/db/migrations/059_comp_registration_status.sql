-- Status text was one character too short.
ALTER TABLE public.comp_registrations DROP CONSTRAINT IF EXISTS comp_registrations_status_check;
ALTER TABLE public.comp_registrations ALTER COLUMN status TYPE VARCHAR(24);
ALTER TABLE public.comp_registrations ADD CONSTRAINT comp_registrations_status_check CHECK (status IN ('Fee pending', 'Registered', 'Admit card issued'));
