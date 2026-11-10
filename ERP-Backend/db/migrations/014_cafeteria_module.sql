-- Cafeteria appears on the school launcher, so it needs a module the plans can include.
INSERT INTO public.modules (code, name, description, is_core, sort_order) VALUES
    ('cafeteria', 'Cafeteria', 'Canteen menu, wallets and orders', FALSE, 21)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.plan_modules (plan_id, module_code)
SELECT p.id, 'cafeteria'
FROM public.plans p
WHERE p.sort_order >= (SELECT sort_order FROM public.plans WHERE code = 'premium')
ON CONFLICT DO NOTHING;
