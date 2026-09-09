-- Scheduling must also survive a payment that is born uncertain.
--
-- 0006 attached the scheduling trigger to UPDATE OF status only, on the reasoning
-- that a payment is always inserted as `pending` and reaches `unknown` by moving.
-- That is true today and is exactly the kind of assumption the trigger exists to
-- stop depending on: a payment inserted directly as `unknown` would carry no due
-- time and would never be discovered, which is the failure the whole design is
-- meant to make impossible to create by omission.

CREATE OR REPLACE FUNCTION schedule_reconciliation_with_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- On INSERT, OLD is NULL, so IS DISTINCT FROM reports true and a payment born
  -- uncertain is scheduled immediately.
  IF NEW.status = 'unknown' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'unknown') THEN
    NEW.reconciliation_due_at := now();
    NEW.reconciliation_attempts := 0;
  ELSIF TG_OP = 'UPDATE' AND NEW.status <> 'unknown' AND OLD.status = 'unknown' THEN
    NEW.reconciliation_due_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payments_schedule_reconciliation ON payments;

CREATE TRIGGER payments_schedule_reconciliation
  BEFORE INSERT OR UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION schedule_reconciliation_with_status();
