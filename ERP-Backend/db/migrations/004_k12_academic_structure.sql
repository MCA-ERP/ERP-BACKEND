-- ====================================================================
-- MIGRATION 004: K-12 ACADEMIC STRUCTURE
-- Replaces the college model (departments / programs / batches / semesters)
-- with grades, sections, subjects and per-year student enrollments.
-- ====================================================================

-- 0. Safety: this migration re-models tables. Refuse to run if they hold data.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.students)
       OR EXISTS (SELECT 1 FROM public.batches)
       OR EXISTS (SELECT 1 FROM public.programs)
       OR EXISTS (SELECT 1 FROM public.departments)
       OR EXISTS (SELECT 1 FROM public.sections)
       OR EXISTS (SELECT 1 FROM public.student_promotions)
       OR EXISTS (SELECT 1 FROM public.student_guardians)
    THEN
        RAISE EXCEPTION 'Refusing to re-model legacy college tables because they contain data. Migrate the data manually first.';
    END IF;
END;
$$;

-- 1. Remove legacy college structures
DROP TABLE IF EXISTS public.student_promotions CASCADE;
DROP TABLE IF EXISTS public.student_guardians CASCADE;
ALTER TABLE public.students
    DROP COLUMN IF EXISTS batch_id,
    DROP COLUMN IF EXISTS section_id,
    DROP COLUMN IF EXISTS current_semester;
DROP TABLE IF EXISTS public.sections CASCADE;
DROP TABLE IF EXISTS public.batches CASCADE;
DROP TABLE IF EXISTS public.programs CASCADE;
DROP TABLE IF EXISTS public.departments CASCADE;

-- 2. Academic years: lock flag + exactly one current year per institution
ALTER TABLE public.academic_years
    ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_current_academic_year
    ON public.academic_years (institution_id) WHERE is_current;

-- 3. Grades (Class 1..12, LKG, UKG ...)
CREATE TABLE public.grades (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL,
    name           VARCHAR(100) NOT NULL,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_grade_code UNIQUE (institution_id, code)
);

-- 4. Sections: a division of a grade within one academic year
CREATE TABLE public.sections (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    campus_id        UUID REFERENCES public.campuses(id) ON DELETE SET NULL,
    grade_id         UUID NOT NULL REFERENCES public.grades(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES public.academic_years(id) ON DELETE CASCADE,
    name             VARCHAR(50) NOT NULL,
    capacity         INTEGER NOT NULL DEFAULT 40 CHECK (capacity > 0),
    class_teacher_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_section UNIQUE (grade_id, academic_year_id, name)
);

-- 5. Subjects and the grades that teach them
CREATE TABLE public.subjects (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(30) NOT NULL,
    name           VARCHAR(150) NOT NULL,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_subject_code UNIQUE (institution_id, code)
);

CREATE TABLE public.grade_subjects (
    grade_id     UUID NOT NULL REFERENCES public.grades(id) ON DELETE CASCADE,
    subject_id   UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (grade_id, subject_id)
);

-- 6. Students: identity lives on the student; class placement lives in enrollments
ALTER TABLE public.students
    ADD COLUMN campus_id     UUID REFERENCES public.campuses(id) ON DELETE SET NULL,
    ADD COLUMN first_name    VARCHAR(100) NOT NULL,
    ADD COLUMN last_name     VARCHAR(100) NOT NULL,
    ADD COLUMN gender        VARCHAR(20),
    ADD COLUMN date_of_birth DATE,
    ADD COLUMN deleted_at    TIMESTAMPTZ;

-- registration numbers are unique per institution, not globally
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_registration_no_key;
ALTER TABLE public.students
    ADD CONSTRAINT uq_students_institution_reg UNIQUE (institution_id, registration_no),
    ADD CONSTRAINT chk_students_status CHECK (status IN ('Enrolled', 'Transferred', 'Graduated', 'Suspended', 'Left'));

ALTER TABLE public.student_profiles ALTER COLUMN date_of_birth DROP NOT NULL;

CREATE TABLE public.student_enrollments (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id       UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES public.academic_years(id) ON DELETE RESTRICT,
    grade_id         UUID NOT NULL REFERENCES public.grades(id) ON DELETE RESTRICT,
    section_id       UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    roll_no          VARCHAR(30),
    status           VARCHAR(20) NOT NULL DEFAULT 'Active'
                     CHECK (status IN ('Active', 'Promoted', 'Detained', 'Transferred', 'Left')),
    enrolled_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_enrollment_student_year UNIQUE (student_id, academic_year_id)
);
CREATE INDEX idx_enrollments_class
    ON public.student_enrollments (institution_id, academic_year_id, grade_id, section_id);

-- 7. Guardians: one guardian can be linked to several children
CREATE TABLE public.guardians (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id  UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    user_profile_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    full_name       VARCHAR(200) NOT NULL,
    phone           VARCHAR(30) NOT NULL,
    email           VARCHAR(255),
    occupation      VARCHAR(100),
    annual_income   NUMERIC(12, 2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_guardians_phone ON public.guardians (institution_id, phone);

CREATE TABLE public.student_guardians (
    student_id         UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    guardian_id        UUID NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
    relation           VARCHAR(50) NOT NULL,
    is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (student_id, guardian_id)
);

-- 8. Promotion history (year-end promote / detain decisions)
CREATE TABLE public.student_promotions (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id     UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id         UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    from_enrollment_id UUID NOT NULL REFERENCES public.student_enrollments(id) ON DELETE CASCADE,
    to_enrollment_id   UUID REFERENCES public.student_enrollments(id) ON DELETE SET NULL,
    action             VARCHAR(20) NOT NULL CHECK (action IN ('Promoted', 'Detained')),
    remarks            TEXT,
    decided_by         UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. updated_at triggers for the new tables
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['grades', 'sections', 'student_enrollments', 'guardians']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;
END;
$$;
