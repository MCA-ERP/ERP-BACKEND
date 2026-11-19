-- Staff attendance, geo check-ins, biometric devices, RFID / QR readers and scans, student leave.
CREATE SEQUENCE public.bio_device_seq START 142;
CREATE SEQUENCE public.rfid_device_seq START 1;
CREATE SEQUENCE public.qr_device_seq START 1;
CREATE SEQUENCE public.student_leave_seq START 2210;

CREATE TABLE public.att_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    late_after     TIME NOT NULL DEFAULT '08:15',
    last_push_at   TIMESTAMPTZ
);

CREATE TABLE public.staff_attendance (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    att_date       DATE NOT NULL,
    status         CHAR(1) NOT NULL CHECK (status IN ('P', 'A', 'L', 'H', 'V')),
    in_time        TIME,
    out_time       TIME,
    source         VARCHAR(12) NOT NULL DEFAULT 'Manual',
    marked_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    UNIQUE (staff_id, att_date)
);
CREATE INDEX idx_staff_att_day ON public.staff_attendance (institution_id, att_date);

CREATE TABLE public.geo_checkins (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    method         VARCHAR(24) NOT NULL CHECK (method IN ('Mobile app', 'Mobile app (field)', 'Biometric', 'Face scan')),
    place          VARCHAR(120) NOT NULL,
    distance_m     INTEGER,
    geo_status     VARCHAR(12) NOT NULL DEFAULT 'Inside' CHECK (geo_status IN ('Inside', 'Outside', 'Field duty')),
    selfie         VARCHAR(10) NOT NULL DEFAULT 'Matched' CHECK (selfie IN ('Matched', 'No match')),
    resolution     VARCHAR(10) CHECK (resolution IN ('Accepted', 'Absent'))
);
CREATE INDEX idx_geo_checkins_day ON public.geo_checkins (institution_id, at DESC);

CREATE TABLE public.bio_devices (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('BIO-' || lpad(nextval('public.bio_device_seq')::text, 4, '0')),
    location       VARCHAR(100) NOT NULL,
    model          VARCHAR(60) NOT NULL,
    status         VARCHAR(8) NOT NULL DEFAULT 'Online' CHECK (status IN ('Online', 'Offline')),
    last_sync      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.bio_mappings (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    device_id      UUID NOT NULL REFERENCES public.bio_devices(id) ON DELETE CASCADE,
    biometric_id   VARCHAR(20) NOT NULL,
    fingerprints   VARCHAR(10) NOT NULL DEFAULT 'Verified' CHECK (fingerprints IN ('Verified', 'Missing')),
    UNIQUE (institution_id, staff_id),
    UNIQUE (institution_id, biometric_id)
);

CREATE TABLE public.bio_syncs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    device_id      UUID NOT NULL REFERENCES public.bio_devices(id) ON DELETE CASCADE,
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    punches        INTEGER NOT NULL DEFAULT 0 CHECK (punches >= 0),
    new_marked     INTEGER NOT NULL DEFAULT 0 CHECK (new_marked >= 0),
    status         VARCHAR(8) NOT NULL DEFAULT 'Success' CHECK (status IN ('Success', 'Failed'))
);
CREATE INDEX idx_bio_syncs_school ON public.bio_syncs (institution_id, synced_at DESC);

CREATE TABLE public.rfid_devices (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL,
    kind           VARCHAR(4) NOT NULL CHECK (kind IN ('RFID', 'QR')),
    label          VARCHAR(40) NOT NULL,
    location       VARCHAR(100) NOT NULL,
    mode           VARCHAR(12) NOT NULL DEFAULT 'Entry' CHECK (mode IN ('Entry', 'Exit', 'Both', 'Board / drop')),
    status         VARCHAR(12) NOT NULL DEFAULT 'Online' CHECK (status IN ('Online', 'Offline', 'Low battery')),
    last_sync      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, code)
);

CREATE TABLE public.student_cards (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    rfid_code      VARCHAR(20) NOT NULL,
    qr_code        VARCHAR(40) NOT NULL,
    issued_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(8) NOT NULL DEFAULT 'Issued' CHECK (status IN ('Issued', 'Lost')),
    UNIQUE (student_id),
    UNIQUE (institution_id, rfid_code)
);

CREATE TABLE public.scans (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    device_id      UUID REFERENCES public.rfid_devices(id) ON DELETE SET NULL,
    scanned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    how            VARCHAR(4) NOT NULL CHECK (how IN ('RFID', 'QR')),
    direction      VARCHAR(3) NOT NULL DEFAULT 'In' CHECK (direction IN ('In', 'Out')),
    result         VARCHAR(10) NOT NULL DEFAULT 'OK' CHECK (result IN ('OK', 'Blocked', 'Duplicate')),
    note           VARCHAR(120)
);
CREATE INDEX idx_scans_day ON public.scans (institution_id, scanned_at DESC);

CREATE TABLE public.student_leaves (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('LV-' || nextval('public.student_leave_seq')),
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    leave_type     VARCHAR(40) NOT NULL,
    from_date      DATE NOT NULL,
    to_date        DATE NOT NULL,
    days           INTEGER NOT NULL CHECK (days > 0),
    applied_on     DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    CHECK (to_date >= from_date)
);
CREATE INDEX idx_student_leaves_school ON public.student_leaves (institution_id, status, from_date DESC);

ALTER TABLE public.att_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_checkins     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bio_devices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bio_mappings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bio_syncs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfid_devices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_cards    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_leaves   ENABLE ROW LEVEL SECURITY;
