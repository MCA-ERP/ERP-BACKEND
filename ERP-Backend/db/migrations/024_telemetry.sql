-- ====================================================================
-- MIGRATION 024: PLATFORM TELEMETRY FOR THE REPORTS
-- Hourly request counts and speed, server errors, refused (403) requests,
-- and a function that reports how big the database is. These start filling from now.
-- ====================================================================

CREATE TABLE public.request_metrics (
    hour        TIMESTAMPTZ NOT NULL,
    route_group VARCHAR(60) NOT NULL,
    module_code VARCHAR(40),
    requests    INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,          -- 5xx answers
    sum_ms      BIGINT  NOT NULL DEFAULT 0,
    max_ms      INTEGER NOT NULL DEFAULT 0,
    -- how many requests took up to 50, 100, 250, 500, 1000, 2500 ms, and longer
    buckets     INTEGER[] NOT NULL DEFAULT ARRAY[0, 0, 0, 0, 0, 0, 0],
    PRIMARY KEY (hour, route_group)
);

-- adds a batch of counts into the hour rows (rows arrive as JSON from the server)
CREATE OR REPLACE FUNCTION public.add_request_metrics(p_rows JSONB)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    r JSONB;
BEGIN
    FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
    LOOP
        INSERT INTO public.request_metrics AS m (hour, route_group, module_code, requests, errors, sum_ms, max_ms, buckets)
        VALUES (
            (r ->> 'hour')::TIMESTAMPTZ, r ->> 'route_group', NULLIF(r ->> 'module_code', ''),
            (r ->> 'requests')::INT, (r ->> 'errors')::INT, (r ->> 'sum_ms')::BIGINT, (r ->> 'max_ms')::INT,
            ARRAY(SELECT jsonb_array_elements_text(r -> 'buckets')::INT)
        )
        ON CONFLICT (hour, route_group) DO UPDATE SET
            requests = m.requests + EXCLUDED.requests,
            errors   = m.errors + EXCLUDED.errors,
            sum_ms   = m.sum_ms + EXCLUDED.sum_ms,
            max_ms   = GREATEST(m.max_ms, EXCLUDED.max_ms),
            buckets  = ARRAY(SELECT m.buckets[i] + EXCLUDED.buckets[i] FROM generate_series(1, 7) AS i);
    END LOOP;
END;
$$;

CREATE TABLE public.error_events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    route_group VARCHAR(60) NOT NULL,
    module_code VARCHAR(40),
    method      VARCHAR(10) NOT NULL,
    path        VARCHAR(300) NOT NULL,
    status      INTEGER NOT NULL,
    message     VARCHAR(400)
);
CREATE INDEX idx_error_events_at ON public.error_events (at DESC);

-- requests that were refused with 403: who tried to open what
CREATE TABLE public.access_denied_events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    email       VARCHAR(320),
    profile_id  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    method      VARCHAR(10) NOT NULL,
    path        VARCHAR(300) NOT NULL,
    needed      VARCHAR(200),
    ip_address  VARCHAR(60)
);
CREATE INDEX idx_access_denied_at ON public.access_denied_events (at DESC);

ALTER TABLE public.request_metrics       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_denied_events  ENABLE ROW LEVEL SECURITY;

-- how big the database is and what takes the space
CREATE OR REPLACE FUNCTION public.platform_db_stats()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'database_bytes', pg_database_size(current_database()),
        'tables', COALESCE((
            SELECT jsonb_agg(t ORDER BY t.bytes DESC) FROM (
                SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes, c.reltuples::BIGINT AS rows
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r'
                ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 25
            ) t
        ), '[]'::JSONB)
    );
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION public.platform_db_stats() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION public.add_request_metrics(JSONB) FROM PUBLIC, anon, authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.platform_db_stats() TO service_role;
        GRANT EXECUTE ON FUNCTION public.add_request_metrics(JSONB) TO service_role;
    END IF;
END;
$$;
