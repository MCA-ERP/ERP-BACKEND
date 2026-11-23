-- The Accountant role is limited to a list of modules (role_modules). Add the AI assistant so the accountant gets Ask AI
-- when the school's plan includes it. Roles with no list are unlimited and need nothing.
INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, 'school_assistant' FROM public.roles r
WHERE r.name = 'Accountant'
  AND EXISTS (SELECT 1 FROM public.role_modules rm WHERE rm.role_id = r.id)
ON CONFLICT DO NOTHING;
