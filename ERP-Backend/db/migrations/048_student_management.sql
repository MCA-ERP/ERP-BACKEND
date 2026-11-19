-- Student management: documents, ID cards, and the extra profile fields the screens keep.
ALTER TABLE public.student_profiles
    ADD COLUMN IF NOT EXISTS house            VARCHAR(30),
    ADD COLUMN IF NOT EXISTS aadhaar_last4    VARCHAR(4),
    ADD COLUMN IF NOT EXISTS previous_school  VARCHAR(150),
    ADD COLUMN IF NOT EXISTS medium           VARCHAR(40),
    ADD COLUMN IF NOT EXISTS second_language  VARCHAR(40),
    ADD COLUMN IF NOT EXISTS email            VARCHAR(255);
ALTER TABLE public.guardians ADD COLUMN IF NOT EXISTS qualification VARCHAR(100);
ALTER TABLE public.student_guardians ADD COLUMN IF NOT EXISTS can_pick_up BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE public.stu_documents (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    doc_type       VARCHAR(60) NOT NULL,
    file_name      VARCHAR(150),
    status         VARCHAR(14) NOT NULL DEFAULT 'Pending review' CHECK (status IN ('Pending review', 'Verified', 'Expired', 'Missing')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stu_documents_school ON public.stu_documents (institution_id, created_at DESC);

CREATE TABLE public.stu_id_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    template       VARCHAR(40) NOT NULL DEFAULT 'Portrait, blue band',
    valid_until    DATE,
    signature      VARCHAR(40) NOT NULL DEFAULT 'Principal',
    show_fields    JSONB NOT NULL DEFAULT '{"Photo":true,"Admission no.":true,"Class":true,"Blood group":true,"Parent mobile":true,"Address":false,"Bus route":true,"QR code":true}'::JSONB
);
CREATE TABLE public.stu_id_cards (
    student_id     UUID PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.stu_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stu_id_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stu_id_cards     ENABLE ROW LEVEL SECURITY;
