-- Teacher portal, classwork: lesson plan details, chapter percentages, homework marks and checking, assignment submissions, study material details.

-- lesson plans: what the teacher writes, and the principal's remarks
ALTER TABLE public.lesson_plans
    ADD COLUMN IF NOT EXISTS objectives   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS activities   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS remarks      VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS submitted_on DATE;

-- chapter progress as a percentage (status stays, kept in step with it)
ALTER TABLE public.syllabus_progress ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100);
UPDATE public.syllabus_progress SET progress = CASE status WHEN 'Done' THEN 100 WHEN 'In progress' THEN 50 ELSE 0 END WHERE progress = 0 AND status <> 'Not started';

-- homework: instructions, marks out of, and a checked state; a submission can carry a file name
ALTER TABLE public.homework
    ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS max_marks    INTEGER NOT NULL DEFAULT 10 CHECK (max_marks BETWEEN 1 AND 200);
ALTER TABLE public.hw_submissions DROP CONSTRAINT IF EXISTS hw_submissions_status_check;
ALTER TABLE public.hw_submissions ADD CONSTRAINT hw_submissions_status_check CHECK (status IN ('Submitted', 'Pending', 'Late', 'Reassessment', 'Checked'));
ALTER TABLE public.hw_submissions ADD COLUMN IF NOT EXISTS file_name VARCHAR(160);

-- assignments: instructions, rubric file name, the day they were assigned
ALTER TABLE public.assignments
    ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS rubric_name  VARCHAR(160),
    ADD COLUMN IF NOT EXISTS assigned_on  DATE;

CREATE TABLE IF NOT EXISTS public.assignment_submissions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    assignment_id  UUID NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Late', 'Checked')),
    submitted_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    marks          NUMERIC(5, 1) CHECK (marks >= 0),
    feedback       VARCHAR(500),
    feedback_sent  BOOLEAN NOT NULL DEFAULT FALSE,
    marks_published BOOLEAN NOT NULL DEFAULT FALSE,
    file_name      VARCHAR(160),
    UNIQUE (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_school ON public.assignment_submissions (institution_id, assignment_id);
ALTER TABLE public.assignment_submissions ENABLE ROW LEVEL SECURITY;

-- study materials: chapter, size, link, sharing with the subject's other teachers
ALTER TABLE public.study_materials
    ADD COLUMN IF NOT EXISTS chapter    VARCHAR(200) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS size_label VARCHAR(30) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS url        VARCHAR(300),
    ADD COLUMN IF NOT EXISTS shared     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS shared_on  DATE,
    ADD COLUMN IF NOT EXISTS doc_type   VARCHAR(10) NOT NULL DEFAULT 'PDF' CHECK (doc_type IN ('PDF', 'Document', 'Video'));
