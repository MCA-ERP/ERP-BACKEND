-- ====================================================================
-- MIGRATION 042: STAFF PROFILE DETAILS
-- What a school staff member keeps about themselves under My Profile: contact details and qualifications.
-- Name, official email and role stay on user_profiles. Pay, bank and statutory details belong to Payroll later.
-- ====================================================================

CREATE TABLE public.staff_contact_details (
    profile_id         UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    alt_phone          VARCHAR(30),
    personal_email     VARCHAR(255),
    date_of_birth      DATE,
    blood_group        VARCHAR(5),
    home_address       TEXT,
    emergency_name     VARCHAR(150),
    emergency_relation VARCHAR(40),
    emergency_phone    VARCHAR(30),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.staff_qualifications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id  UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    title       VARCHAR(200) NOT NULL,
    institution VARCHAR(200) NOT NULL,
    year        INTEGER NOT NULL CHECK (year BETWEEN 1950 AND 2100),
    result      VARCHAR(100),
    status      VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Verified')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_qualifications_profile ON public.staff_qualifications (profile_id);

ALTER TABLE public.staff_contact_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_qualifications  ENABLE ROW LEVEL SECURITY;
