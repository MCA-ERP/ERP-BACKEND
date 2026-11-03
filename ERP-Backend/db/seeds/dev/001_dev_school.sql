-- ====================================================================
-- DEV SEED: one K-12 school ready to use (never run in production)
--   node db/migrate.js seed dev
-- Idempotent: re-running does not duplicate rows.
-- ====================================================================

INSERT INTO public.institutions (code, name, type, board, contact_email, contact_phone, address, city, state, status)
VALUES ('RAV', 'Ravindra English Medium High School', 'High School', 'State Board', 'principal@rav.edu', '+91-9876543210',
        'Main Campus Road, Sector 4', 'Bangalore', 'Karnataka', 'Active')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.subscriptions (institution_id, plan_id, renews_on)
SELECT i.id, (SELECT id FROM public.plans WHERE code = 'premium'), CURRENT_DATE + 365
FROM public.institutions i
WHERE i.code = 'RAV' AND NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.institution_id = i.id);

INSERT INTO public.campuses (institution_id, code, name, city, state, postal_code)
SELECT i.id, 'MAIN', 'Main Campus', 'Bangalore', 'Karnataka', '560100'
FROM public.institutions i WHERE i.code = 'RAV'
ON CONFLICT (institution_id, code) DO NOTHING;

INSERT INTO public.academic_years (institution_id, name, start_date, end_date, is_current)
SELECT i.id, '2026-2027', DATE '2026-06-01', DATE '2027-03-31', TRUE
FROM public.institutions i WHERE i.code = 'RAV'
ON CONFLICT (institution_id, name) DO NOTHING;

-- Grades: LKG, UKG, Class 1..12
INSERT INTO public.grades (institution_id, code, name, sort_order)
SELECT i.id, g.code, g.name, g.ord
FROM public.institutions i
CROSS JOIN (
    SELECT 'LKG' AS code, 'LKG' AS name, 1 AS ord
    UNION ALL SELECT 'UKG', 'UKG', 2
    UNION ALL SELECT 'G' || n, 'Class ' || n, n + 2 FROM generate_series(1, 12) AS n
) g
WHERE i.code = 'RAV'
ON CONFLICT (institution_id, code) DO NOTHING;

-- Sections A and B for every grade in the current year
INSERT INTO public.sections (institution_id, campus_id, grade_id, academic_year_id, name)
SELECT i.id, c.id, g.id, ay.id, s.name
FROM public.institutions i
JOIN public.campuses c ON c.institution_id = i.id AND c.code = 'MAIN'
JOIN public.grades g ON g.institution_id = i.id
JOIN public.academic_years ay ON ay.institution_id = i.id AND ay.is_current
CROSS JOIN (VALUES ('A'), ('B')) AS s(name)
WHERE i.code = 'RAV'
ON CONFLICT (grade_id, academic_year_id, name) DO NOTHING;

INSERT INTO public.subjects (institution_id, code, name)
SELECT i.id, s.code, s.name
FROM public.institutions i
CROSS JOIN (VALUES
    ('ENG', 'English'), ('KAN', 'Kannada'), ('HIN', 'Hindi'), ('MAT', 'Mathematics'),
    ('SCI', 'Science'), ('SOC', 'Social Science'), ('CMP', 'Computer Science'), ('PED', 'Physical Education')
) AS s(code, name)
WHERE i.code = 'RAV'
ON CONFLICT (institution_id, code) DO NOTHING;
