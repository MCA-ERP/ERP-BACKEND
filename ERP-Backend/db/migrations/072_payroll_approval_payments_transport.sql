-- Payroll approval trail, payslips, salary payments, settings, bank/statutory ids; transport vehicles.
ALTER TABLE public.pay_runs ADD COLUMN payslips_on DATE, ADD COLUMN paid_on DATE;
ALTER TABLE public.hr_staff
    ADD COLUMN bank_name VARCHAR(40), ADD COLUMN bank_account VARCHAR(30), ADD COLUMN ifsc VARCHAR(11),
    ADD COLUMN uan VARCHAR(14), ADD COLUMN esi_no VARCHAR(14);
CREATE TABLE public.pay_events (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    month          CHAR(7) NOT NULL,
    step           VARCHAR(20) NOT NULL,
    by_name        VARCHAR(120) NOT NULL,
    note           VARCHAR(200),
    at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pay_events_school ON public.pay_events (institution_id, at DESC);
CREATE TABLE public.pay_payments (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    month          CHAR(7) NOT NULL,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    net            INTEGER NOT NULL CHECK (net >= 0),
    bank           VARCHAR(60) NOT NULL DEFAULT '',
    utr            VARCHAR(30) NOT NULL DEFAULT '',
    paid_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(8) NOT NULL DEFAULT 'Paid' CHECK (status IN ('Paid', 'Failed', 'Pending')),
    UNIQUE (institution_id, month, staff_id)
);
CREATE TABLE public.pay_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    pay_period     VARCHAR(40) NOT NULL DEFAULT '1st - last day of the month',
    paid_on        VARCHAR(40) NOT NULL DEFAULT 'Last working day',
    lock_day       INTEGER NOT NULL DEFAULT 25 CHECK (lock_day BETWEEN 1 AND 31),
    pay_by         VARCHAR(30) NOT NULL DEFAULT 'Bank transfer (NEFT)',
    tax_regime     VARCHAR(20) NOT NULL DEFAULT 'New regime',
    proofs_month   VARCHAR(12) NOT NULL DEFAULT 'January',
    form16         BOOLEAN NOT NULL DEFAULT TRUE,
    adv_limit      VARCHAR(40) NOT NULL DEFAULT '1 month''s net pay',
    recover_months VARCHAR(12) NOT NULL DEFAULT '3 months',
    arrears_with   VARCHAR(30) NOT NULL DEFAULT 'Next month''s salary',
    encash         BOOLEAN NOT NULL DEFAULT TRUE,
    debit_account  VARCHAR(30) NOT NULL DEFAULT ''
);
CREATE TABLE public.tr_vehicles (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    reg_no         VARCHAR(30) NOT NULL,
    vtype          VARCHAR(12) NOT NULL DEFAULT 'Bus' CHECK (vtype IN ('Bus', 'Mini bus', 'Van', 'Car')),
    seats          INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 80),
    route          VARCHAR(60) NOT NULL DEFAULT '',
    fitness_until  DATE,
    gps            VARCHAR(10) NOT NULL DEFAULT 'Online' CHECK (gps IN ('Online', 'Offline', 'None')),
    status         VARCHAR(10) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, reg_no)
);
CREATE TABLE public.tr_vehicle_docs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    vehicle_id     UUID NOT NULL REFERENCES public.tr_vehicles(id) ON DELETE CASCADE,
    doc_type       VARCHAR(30) NOT NULL,
    file_name      VARCHAR(160) NOT NULL,
    valid_until    DATE
);
ALTER TABLE public.pay_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_vehicle_docs ENABLE ROW LEVEL SECURITY;
