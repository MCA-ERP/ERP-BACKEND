-- ====================================================================
-- MIGRATION 111: APPLICANT PORTAL (families)
-- A new "Applicant" role, the link from an enquiry or application to the family account that owns it, document files,
-- campus-visit and assessment slots, messages between the family and the admissions office, and online payment orders.
-- The Applicant portal reads and writes the same adm_* rows as the Admissions portal and the School Admin Admission module.
-- ====================================================================

INSERT INTO public.roles (name, display_name, description, is_system_default, scope, data_scope) VALUES
    ('Applicant', 'Applicant family', 'A family applying for admission: their own enquiries, applications, documents, slots, fees and messages (Applicant portal)', TRUE, 'school', 'school')
ON CONFLICT (name) DO NOTHING;

-- the role may only use the admission modules of the school's plan
INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, m.code FROM public.roles r CROSS JOIN (VALUES ('admissions'), ('online_admissions')) AS m(code)
WHERE r.name = 'Applicant'
ON CONFLICT DO NOTHING;

-- which family account owns the record (set when the family creates it, or links an application the office made)
ALTER TABLE public.adm_enquiries    ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.adm_applications ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_adm_enquiries_family    ON public.adm_enquiries (institution_id, family_id);
CREATE INDEX IF NOT EXISTS idx_adm_applications_family ON public.adm_applications (institution_id, family_id);

-- the uploaded file behind a document row (kept in a private storage bucket) and the reason it was sent back
ALTER TABLE public.adm_documents
    ADD COLUMN IF NOT EXISTS storage_path VARCHAR(300),
    ADD COLUMN IF NOT EXISTS mime         VARCHAR(60),
    ADD COLUMN IF NOT EXISTS size_bytes   INTEGER CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 5242880),
    ADD COLUMN IF NOT EXISTS review_note  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- slots the office opens: campus visits and assessments (a child books one)
CREATE TABLE IF NOT EXISTS public.adm_slots (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('Visit', 'Assessment')),
    slot_date      DATE NOT NULL,
    slot_time      TIME NOT NULL,
    capacity       INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 200),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, kind, slot_date, slot_time)
);
CREATE INDEX IF NOT EXISTS idx_adm_slots_school ON public.adm_slots (institution_id, kind, slot_date);

CREATE TABLE IF NOT EXISTS public.adm_slot_bookings (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    slot_id        UUID NOT NULL REFERENCES public.adm_slots(id) ON DELETE CASCADE,
    family_id      UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    application_id UUID REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Booked' CHECK (status IN ('Booked', 'Cancelled')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adm_bookings_slot   ON public.adm_slot_bookings (slot_id, status);
CREATE INDEX IF NOT EXISTS idx_adm_bookings_family ON public.adm_slot_bookings (institution_id, family_id);
-- the interaction/test row the Admissions portal works with remembers the slot it came from
ALTER TABLE public.adm_interviews ADD COLUMN IF NOT EXISTS slot_id UUID REFERENCES public.adm_slots(id) ON DELETE SET NULL;

-- messages between a family and the admissions office
CREATE TABLE IF NOT EXISTS public.adm_messages (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    family_id      UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    application_id UUID REFERENCES public.adm_applications(id) ON DELETE SET NULL,
    enquiry_id     UUID REFERENCES public.adm_enquiries(id) ON DELETE SET NULL,
    from_family    BOOLEAN NOT NULL,
    sender_id      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    body           VARCHAR(1000) NOT NULL,
    read_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adm_messages_family ON public.adm_messages (institution_id, family_id, created_at DESC);

-- online payments: the amount is fixed on the server when the order is made; the gateway signature settles it
CREATE TABLE IF NOT EXISTS public.adm_payment_orders (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    family_id        UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    application_id   UUID NOT NULL REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    purpose          VARCHAR(16) NOT NULL CHECK (purpose IN ('application_fee', 'admission_fee')),
    amount           INTEGER NOT NULL CHECK (amount > 0),
    gateway_order_id VARCHAR(60) NOT NULL UNIQUE,
    status           VARCHAR(8) NOT NULL DEFAULT 'Created' CHECK (status IN ('Created', 'Paid')),
    gateway_payment_id VARCHAR(60) UNIQUE,
    paid_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adm_orders_family ON public.adm_payment_orders (institution_id, family_id, created_at DESC);

-- which notifications a family has read
CREATE TABLE IF NOT EXISTS public.applicant_notification_reads (
    profile_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    key        VARCHAR(80) NOT NULL,
    read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, key)
);

ALTER TABLE public.adm_slots                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_slot_bookings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_messages                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_payment_orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.applicant_notification_reads  ENABLE ROW LEVEL SECURITY;
