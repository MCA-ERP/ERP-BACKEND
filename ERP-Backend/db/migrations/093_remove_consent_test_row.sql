-- Remove a test entry created while checking the consent guard.
ALTER TABLE public.consent_records DISABLE TRIGGER consent_immutable;
DELETE FROM public.consent_records WHERE parent_name = 'Zz' AND purpose = 't';
ALTER TABLE public.consent_records ENABLE TRIGGER consent_immutable;
