-- ====================================================================
-- MIGRATION 112: APPLICANT PORTAL ASSISTANT
-- The Applicant role may use the AI assistant module when the school's plan has it (the plan still decides).
-- ====================================================================
INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, 'school_assistant' FROM public.roles r WHERE r.name = 'Applicant'
ON CONFLICT DO NOTHING;
