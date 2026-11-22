-- Teacher portal: only what the existing HR, attendance, help desk and calendar tables did not already hold.

-- campus location, so a check-in can be judged inside or outside the school
ALTER TABLE public.campuses
    ADD COLUMN IF NOT EXISTS latitude   NUMERIC(9, 6) CHECK (latitude BETWEEN -90 AND 90),
    ADD COLUMN IF NOT EXISTS longitude  NUMERIC(9, 6) CHECK (longitude BETWEEN -180 AND 180),
    ADD COLUMN IF NOT EXISTS geofence_m INTEGER NOT NULL DEFAULT 150 CHECK (geofence_m BETWEEN 20 AND 5000);

-- qualifications: the subject and the certificate file name
ALTER TABLE public.staff_qualifications
    ADD COLUMN IF NOT EXISTS subject          VARCHAR(150),
    ADD COLUMN IF NOT EXISTS certificate_name VARCHAR(160);

-- staff documents: a name for each document and more types than three
ALTER TABLE public.hr_documents DROP CONSTRAINT IF EXISTS hr_documents_doc_type_check;
ALTER TABLE public.hr_documents ALTER COLUMN doc_type TYPE VARCHAR(30);
ALTER TABLE public.hr_documents ADD COLUMN IF NOT EXISTS title VARCHAR(120);

-- the documents a school asks each staff member for
CREATE TABLE IF NOT EXISTS public.hr_doc_requirements (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    title          VARCHAR(120) NOT NULL,
    doc_type       VARCHAR(30) NOT NULL,
    due_on         DATE,
    PRIMARY KEY (institution_id, title)
);

-- event duties belong to a person, and the person can say they cannot make it
ALTER TABLE public.event_duties
    ADD COLUMN IF NOT EXISTS staff_id     UUID REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS response     VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (response IN ('Pending', 'Accepted', 'Declined')),
    ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_event_duties_staff ON public.event_duties (staff_id);

-- help desk: what happened, and an attached file name
ALTER TABLE public.hd_tickets
    ADD COLUMN IF NOT EXISTS details         TEXT,
    ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(160);

-- 360° peer feedback: each teacher rates the colleagues the school picked; answers are anonymous to the person rated
CREATE TABLE IF NOT EXISTS public.hr_peer_feedback (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    cycle          VARCHAR(10) NOT NULL,
    rater_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    ratee_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    scores         JSONB NOT NULL DEFAULT '{}',
    submitted_at   TIMESTAMPTZ,
    PRIMARY KEY (institution_id, cycle, rater_id, ratee_id),
    CHECK (rater_id <> ratee_id)
);

-- self-appraisal: the teacher's own score and evidence for each KRA, and goals for next year
CREATE TABLE IF NOT EXISTS public.hr_self_appraisal (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    cycle          VARCHAR(10) NOT NULL,
    kra_id         UUID NOT NULL REFERENCES public.hr_kras(id) ON DELETE CASCADE,
    score          INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    evidence       VARCHAR(1000) NOT NULL DEFAULT '',
    PRIMARY KEY (institution_id, staff_id, cycle, kra_id)
);
ALTER TABLE public.hr_cycle
    ADD COLUMN IF NOT EXISTS goals             VARCHAR(1500) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS self_submitted_on DATE;

-- which of a teacher's derived notifications they have read
CREATE TABLE IF NOT EXISTS public.staff_notification_reads (
    profile_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    key        VARCHAR(120) NOT NULL,
    read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, key)
);

ALTER TABLE public.hr_doc_requirements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_peer_feedback         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_self_appraisal        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_notification_reads ENABLE ROW LEVEL SECURITY;

-- contact: whether parents may see the mobile number
ALTER TABLE public.staff_contact_details ADD COLUMN IF NOT EXISTS show_mobile_to_parents BOOLEAN NOT NULL DEFAULT FALSE;

-- competencies: the level the role expects, and the training suggested for a gap
ALTER TABLE public.hr_competency
    ADD COLUMN IF NOT EXISTS expected INTEGER NOT NULL DEFAULT 3 CHECK (expected BETWEEN 1 AND 5),
    ADD COLUMN IF NOT EXISTS training VARCHAR(160) NOT NULL DEFAULT '';
