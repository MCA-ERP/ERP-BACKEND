-- Geo-fence settings used by HR > Attendance > Geo-Fencing: what each campus fence covers, and the app check-in rules.
ALTER TABLE public.campuses     ADD COLUMN IF NOT EXISTS geofence_covers VARCHAR(160);
ALTER TABLE public.att_settings ADD COLUMN IF NOT EXISTS geo_rules       JSONB;
