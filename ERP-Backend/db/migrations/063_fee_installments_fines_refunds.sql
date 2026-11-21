-- Fees, part 2: instalment and late-fee settings, fines, refunds, reminders, receipt cancellation, more concession types.
ALTER TABLE public.fee_settings
    ADD COLUMN due_dates      JSONB        NOT NULL DEFAULT '["10 Apr","10 Oct","10 Jan"]',
    ADD COLUMN year_discount  INTEGER      NOT NULL DEFAULT 0 CHECK (year_discount BETWEEN 0 AND 100),
    ADD COLUMN reminders      VARCHAR(60)  NOT NULL DEFAULT '7 and 1 days before, 3 days after',
    ADD COLUMN late_enabled   BOOLEAN      NOT NULL DEFAULT FALSE,
    ADD COLUMN late_grace     INTEGER      NOT NULL DEFAULT 3 CHECK (late_grace BETWEEN 0 AND 60),
    ADD COLUMN late_per_day   INTEGER      NOT NULL DEFAULT 50 CHECK (late_per_day BETWEEN 0 AND 100000),
    ADD COLUMN late_max       INTEGER      NOT NULL DEFAULT 1500 CHECK (late_max BETWEEN 0 AND 10000000),
    ADD COLUMN late_waive     BOOLEAN      NOT NULL DEFAULT TRUE,
    ADD COLUMN fine_lost_id   INTEGER      NOT NULL DEFAULT 150 CHECK (fine_lost_id >= 0),
    ADD COLUMN fine_lost_book INTEGER      NOT NULL DEFAULT 100 CHECK (fine_lost_book >= 0),
    ADD COLUMN fine_damage    VARCHAR(40)  NOT NULL DEFAULT 'Assessed case by case',
    ADD COLUMN fine_waiver    VARCHAR(20)  NOT NULL DEFAULT 'Principal';

-- Receipts can be cancelled (they stay on record), and a cancelled payment no longer reduces dues.
ALTER TABLE public.fee_payments DROP CONSTRAINT IF EXISTS fee_payments_status_check;
ALTER TABLE public.fee_payments ADD CONSTRAINT fee_payments_status_check CHECK (status IN ('Paid', 'Pending', 'Failed', 'Cancelled'));
ALTER TABLE public.fee_payments
    ADD COLUMN cancel_reason VARCHAR(200),
    ADD COLUMN cancelled_on  DATE;

-- More concession kinds, and requests that come from parents.
ALTER TABLE public.fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_ctype_check;
ALTER TABLE public.fee_concessions ADD CONSTRAINT fee_concessions_ctype_check CHECK (ctype IN ('Scholarship', 'Sibling', 'Staff ward', 'Financial aid', 'Discount', 'Fee waiver', 'Other'));
ALTER TABLE public.fee_concessions ALTER COLUMN ctype TYPE VARCHAR(16);
ALTER TABLE public.fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_status_check;
ALTER TABLE public.fee_concessions ADD CONSTRAINT fee_concessions_status_check CHECK (status IN ('Pending', 'Under review', 'Info asked', 'Approved', 'Rejected'));
ALTER TABLE public.fee_concessions ALTER COLUMN status TYPE VARCHAR(14);
ALTER TABLE public.fee_concessions ADD COLUMN source VARCHAR(8) NOT NULL DEFAULT 'Office' CHECK (source IN ('Office', 'Parent'));

CREATE SEQUENCE public.fee_fine_seq START 1121;
CREATE TABLE public.fee_fines (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('FN-' || nextval('public.fee_fine_seq')),
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    reason         VARCHAR(80) NOT NULL,
    days_late      INTEGER NOT NULL DEFAULT 0 CHECK (days_late >= 0),
    amount         INTEGER NOT NULL CHECK (amount > 0),
    fined_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(8) NOT NULL DEFAULT 'Unpaid' CHECK (status IN ('Unpaid', 'Paid', 'Waived')),
    mode           VARCHAR(10) CHECK (mode IN ('Cash', 'UPI', 'Card', 'Cheque', 'Bank')),
    settled_on     DATE,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_fee_fines_school ON public.fee_fines (institution_id, fined_on DESC);

CREATE SEQUENCE public.fee_refund_seq START 213;
CREATE TABLE public.fee_refunds (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('RF-' || lpad(nextval('public.fee_refund_seq')::text, 4, '0')),
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    reason         VARCHAR(200) NOT NULL,
    amount         INTEGER NOT NULL CHECK (amount > 0),
    requested_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Paid')),
    decided_on     DATE,
    paid_on        DATE,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_fee_refunds_school ON public.fee_refunds (institution_id, requested_on DESC);

CREATE TABLE public.fee_reminders (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    sent_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    amount         INTEGER NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_fee_reminders_student ON public.fee_reminders (student_id, sent_on DESC);

ALTER TABLE public.fee_fines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_refunds    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_reminders  ENABLE ROW LEVEL SECURITY;
