ALTER TABLE public.lib_copies DROP CONSTRAINT IF EXISTS lib_copies_status_check;
ALTER TABLE public.lib_copies ADD CONSTRAINT lib_copies_status_check CHECK (status IN ('Available', 'Issued', 'Lost'));
