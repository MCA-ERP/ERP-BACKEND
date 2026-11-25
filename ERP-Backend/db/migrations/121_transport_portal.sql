-- ====================================================================
-- MIGRATION 121: TRANSPORT PORTAL
-- Vehicle details and document scans, the link between a driver or attendant and their HR record, attendant police
-- verification, and the Transport Manager's self-service and assistant modules.
-- ====================================================================
ALTER TABLE public.tr_vehicles
    ADD COLUMN IF NOT EXISTS fleet_name VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS make_model VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS model_year INTEGER CHECK (model_year BETWEEN 1980 AND 2100);

-- the scan behind a vehicle document (kept in a private storage bucket)
ALTER TABLE public.tr_vehicle_docs
    ADD COLUMN IF NOT EXISTS storage_path VARCHAR(300),
    ADD COLUMN IF NOT EXISTS mime         VARCHAR(60);

ALTER TABLE public.tr_drivers
    ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.tr_attendants
    ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS police   VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (police IN ('Verified', 'Pending'));

-- crew experience and first-aid training, as taken on the Register form
ALTER TABLE public.tr_drivers
    ADD COLUMN IF NOT EXISTS experience_years INTEGER CHECK (experience_years BETWEEN 0 AND 60),
    ADD COLUMN IF NOT EXISTS first_aid        BOOLEAN;
ALTER TABLE public.tr_attendants
    ADD COLUMN IF NOT EXISTS experience_years INTEGER CHECK (experience_years BETWEEN 0 AND 60),
    ADD COLUMN IF NOT EXISTS first_aid        BOOLEAN;

-- ID, licence and verification papers of a driver or attendant (private storage bucket)
CREATE TABLE IF NOT EXISTS public.tr_crew_docs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    driver_id      UUID REFERENCES public.tr_drivers(id) ON DELETE CASCADE,
    attendant_id   UUID REFERENCES public.tr_attendants(id) ON DELETE CASCADE,
    file_name      VARCHAR(160) NOT NULL,
    storage_path   VARCHAR(300) NOT NULL,
    mime           VARCHAR(60) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((driver_id IS NULL) <> (attendant_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_tr_crew_docs_school ON public.tr_crew_docs (institution_id);
ALTER TABLE public.tr_crew_docs ENABLE ROW LEVEL SECURITY;

-- route timetable: when the bus leaves school, and each stop's minutes from the first stop
ALTER TABLE public.tr_routes ADD COLUMN IF NOT EXISTS departure TIME;
ALTER TABLE public.tr_stops  ADD COLUMN IF NOT EXISTS offset_min INTEGER CHECK (offset_min BETWEEN 0 AND 300);
-- a delay reported for a running trip, in minutes
ALTER TABLE public.tr_trips  ADD COLUMN IF NOT EXISTS delay_min INTEGER CHECK (delay_min BETWEEN 0 AND 300);

-- where bus riders live, for the route planner
CREATE TABLE IF NOT EXISTS public.tr_homes (
    student_id     UUID PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    latitude       NUMERIC(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude      NUMERIC(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    area           VARCHAR(60) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tr_homes_school ON public.tr_homes (institution_id);
ALTER TABLE public.tr_homes ENABLE ROW LEVEL SECURITY;

-- what parents are shown, chosen by the transport desk
ALTER TABLE public.tr_settings
    ADD COLUMN IF NOT EXISTS share_numbers  BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS share_location BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS alert_5min     BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS alert_late     BOOLEAN NOT NULL DEFAULT TRUE;

-- each update the transport desk sends to parents, and how it went out
CREATE TABLE IF NOT EXISTS public.tr_updates (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    route_id       UUID REFERENCES public.tr_routes(id) ON DELETE SET NULL,
    audience       VARCHAR(80) NOT NULL,
    utype          VARCHAR(20) NOT NULL,
    message        VARCHAR(500) NOT NULL,
    channels       VARCHAR(40) NOT NULL,
    families       INTEGER NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tr_updates_school ON public.tr_updates (institution_id, created_at DESC);
ALTER TABLE public.tr_updates ENABLE ROW LEVEL SECURITY;

-- SMS and WhatsApp templates for transport updates. They send only once the platform team adds the provider's template
-- id (Super Admin > Communication) and the provider keys are set.
INSERT INTO public.message_templates (name, key, channel, body, is_active)
SELECT t.name, 'transport_update', t.channel, '{{school_name}}: {{message}}', TRUE
FROM (VALUES ('Transport update (SMS)', 'sms'), ('Transport update (WhatsApp)', 'whatsapp')) AS t(name, channel)
WHERE NOT EXISTS (SELECT 1 FROM public.message_templates m WHERE m.key = 'transport_update' AND m.channel = t.channel);

-- The Transport Manager role is limited to a list of modules (role_modules). Add staff self-service (payslips, claims)
-- and the AI assistant, which show when the school's plan includes them. Roles with no list need nothing.
INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, m.code FROM public.roles r
CROSS JOIN public.modules m
WHERE r.name = 'TransportManager' AND m.code IN ('employee_self_service', 'school_assistant', 'whatsapp')
  AND EXISTS (SELECT 1 FROM public.role_modules rm WHERE rm.role_id = r.id)
ON CONFLICT DO NOTHING;
