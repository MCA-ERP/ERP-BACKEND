-- ====================================================================
-- MIGRATION 005: ROW LEVEL SECURITY (deny by default)
-- All data access goes through the backend API using the service role,
-- which bypasses RLS. Enabling RLS with no policies means the public
-- anon/authenticated keys (shipped to browsers) can read nothing directly.
-- Every new table in later migrations must also enable RLS.
-- ====================================================================

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    END LOOP;
END;
$$;

-- Helper functions must not be callable through the public REST/RPC endpoint.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION public.next_sequence(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.next_sequence(UUID, TEXT, TEXT) TO service_role;
    END IF;
END;
$$;
