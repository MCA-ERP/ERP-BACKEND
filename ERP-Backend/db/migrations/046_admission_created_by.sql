-- Who created each admission-processing record.
ALTER TABLE public.adm_documents  ADD COLUMN created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.adm_tests      ADD COLUMN created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.adm_panels     ADD COLUMN created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.adm_interviews ADD COLUMN created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
