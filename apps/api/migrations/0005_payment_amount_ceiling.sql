-- The per-organization payment ceiling, enforced.
--
-- organizations.maximum_payment_amount_minor has existed since 0001, and its own
-- comment claims the payment table references it. Nothing did: the only cap in
-- force was one hard-coded literal in the HTTP schema, shared by every tenant.
-- The legacy system enforced its R$3.000,00 ceiling with a JavaScript alert(),
-- which any caller bypassed by not being a browser. A column nobody reads is the
-- same defect wearing a better hat.
--
-- Enforced here rather than only in the application because a ceiling that lives
-- in code is a ceiling that the next write path forgets. Amounts are integer
-- minor units throughout, so this comparison is exact.

CREATE OR REPLACE FUNCTION assert_payment_within_organization_ceiling()
RETURNS TRIGGER
  LANGUAGE plpgsql
  -- SECURITY DEFINER so the ceiling is readable regardless of the row level
  -- security policy applying to the caller. It reads exactly one column of the
  -- organization the payment already names, so it grants no wider visibility.
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  ceiling_minor BIGINT;
BEGIN
  SELECT maximum_payment_amount_minor INTO ceiling_minor
    FROM organizations
   WHERE id = NEW.organization_id;

  IF ceiling_minor IS NULL THEN
    RAISE EXCEPTION 'payment_ceiling_unknown: organization % has no ceiling', NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.expected_amount_minor > ceiling_minor THEN
    RAISE EXCEPTION
      'payment_exceeds_organization_ceiling: % exceeds the ceiling of % minor units',
      NEW.expected_amount_minor, ceiling_minor
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- Only on insert. The expected amount is not editable afterwards, and lowering an
-- organization's ceiling must not retroactively invalidate payments already made
-- under the old one.
CREATE TRIGGER payments_within_organization_ceiling
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION assert_payment_within_organization_ceiling();
