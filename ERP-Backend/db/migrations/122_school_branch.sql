-- A school's branch (for example "Kukatpally"), so schools sharing one name can be told apart.
ALTER TABLE public.institutions ADD COLUMN IF NOT EXISTS branch VARCHAR(150);

-- the Super Admin school list reads this view; a new column has to go at the end
CREATE OR REPLACE VIEW public.platform_school_overview AS
SELECT i.id, i.code, i.name, i.type, i.board, i.city, i.state, i.status,
       i.contact_name, i.contact_email, i.contact_phone, i.created_at,
       p.code AS plan_code, p.name AS plan_name, p.price_per_student_paise,
       s.renews_on, s.trial_ends_on,
       COALESCE(st.n, 0)::INT AS students,
       (COALESCE(st.n, 0)::BIGINT * COALESCE(p.price_per_student_paise, 0))::BIGINT AS arr_paise,
       i.branch
FROM public.institutions i
LEFT JOIN public.subscriptions s ON s.institution_id = i.id AND s.is_current
LEFT JOIN public.plans p ON p.id = s.plan_id
LEFT JOIN (
    SELECT institution_id, COUNT(*) AS n
    FROM public.students
    WHERE deleted_at IS NULL AND status = 'Enrolled'
    GROUP BY institution_id
) st ON st.institution_id = i.id
WHERE i.deleted_at IS NULL;
