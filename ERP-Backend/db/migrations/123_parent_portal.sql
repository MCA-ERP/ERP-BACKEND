-- ====================================================================
-- MIGRATION 123: PARENT PORTAL
-- Which guardian gave or withdrew a consent or asked for their data (names alone can repeat), and the modules the
-- Parent portal's pages need on the Parent role. A school still only gets what its own plan includes.
-- ====================================================================
ALTER TABLE public.consent_records
    ADD COLUMN IF NOT EXISTS guardian_id UUID REFERENCES public.guardians(id);
CREATE INDEX IF NOT EXISTS idx_consent_records_guardian ON public.consent_records (guardian_id, recorded_at DESC);

ALTER TABLE public.data_requests
    ADD COLUMN IF NOT EXISTS guardian_id UUID REFERENCES public.guardians(id) ON DELETE SET NULL;

-- only where the role is already limited to a list: an unlimited role must stay unlimited
INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, m.code
FROM public.roles r
JOIN public.modules m ON m.code IN ('competitive_prep', 'house_points', 'photo_gallery', 'online_classes', 'helpdesk', 'school_assistant', 'chat', 'whatsapp')
WHERE r.name = 'Parent'
  AND EXISTS (SELECT 1 FROM public.role_modules x WHERE x.role_id = r.id)
ON CONFLICT DO NOTHING;
