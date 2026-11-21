-- The no-update/no-delete rules also blocked deleting a school. Use a trigger that refuses direct edits but lets a school's deletion cascade.
DROP RULE IF EXISTS consent_no_update ON public.consent_records;
DROP RULE IF EXISTS consent_no_delete ON public.consent_records;
CREATE OR REPLACE FUNCTION public.consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Consent entries cannot be edited or deleted';
END $$;
CREATE TRIGGER consent_immutable BEFORE UPDATE OR DELETE ON public.consent_records FOR EACH ROW EXECUTE FUNCTION public.consent_guard();
