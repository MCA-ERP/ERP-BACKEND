-- ====================================================================
-- MIGRATION 033: WHERE A MODULE SHOWS, AND WHETHER IT CAN BE BOUGHT SEPARATELY
-- ====================================================================

ALTER TABLE public.modules
    ADD COLUMN IF NOT EXISTS show_in_parent_app  BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_in_teacher_app BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS offer_as_addon      BOOLEAN NOT NULL DEFAULT FALSE;

-- modules that have a price as an add-on are offered as one
UPDATE public.modules SET offer_as_addon = TRUE WHERE addon_price_paise > 0;
