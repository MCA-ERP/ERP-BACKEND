-- SECURITY: these rules let any signed-in user, of any school (or a self-registered outsider), read every row of these
-- tables straight from the database, past the application's school and role checks. The application does not need them:
-- the API reads with the service key, which is not subject to row-level security, and the web app uses the public key
-- for sign-in only. Row-level security stays on, so with no rule the public and signed-in keys read nothing.
DROP POLICY IF EXISTS "Allow authenticated read on academic_years" ON public.academic_years;
DROP POLICY IF EXISTS "Allow authenticated read on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Allow authenticated read on campuses" ON public.campuses;
DROP POLICY IF EXISTS "Allow authenticated read on institutions" ON public.institutions;
DROP POLICY IF EXISTS "Allow authenticated read on permissions" ON public.permissions;
DROP POLICY IF EXISTS "Allow authenticated read on role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "Allow authenticated read on roles" ON public.roles;
DROP POLICY IF EXISTS "Allow auth read on student_documents" ON public.student_documents;
DROP POLICY IF EXISTS "Allow auth read on student_profiles" ON public.student_profiles;
DROP POLICY IF EXISTS "Allow authenticated read on students" ON public.students;
DROP POLICY IF EXISTS "Allow authenticated read on user_profiles" ON public.user_profiles;

-- Fail the migration if any rule for visitors or signed-in users is left anywhere in the application's tables.
DO $$
DECLARE left_over TEXT;
BEGIN
    SELECT string_agg(tablename || ': ' || policyname, '; ') INTO left_over
    FROM pg_policies
    WHERE schemaname = 'public' AND roles && ARRAY['anon', 'authenticated', 'public']::name[];
    IF left_over IS NOT NULL THEN RAISE EXCEPTION 'Open policies remain: %', left_over; END IF;
END $$;
