-- Resolving a notification to a payment.
--
-- A notification arrives before any tenant is known: the provider reference is
-- what identifies the merchant, not the other way round, so this cannot be
-- scoped by one. It is narrow in exchange — one provider, one reference, one row
-- or none — and every write that follows is scoped to the organization it
-- returns. A reference nobody holds resolves to nothing, which is how a
-- notification is prevented from naming another merchant's payment.
CREATE FUNCTION find_payment_by_provider_reference(
  candidate_provider_code TEXT,
  candidate_reference     TEXT
)
RETURNS TABLE (payment_id UUID, organization_id UUID)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT payment_attempts.payment_id, payment_attempts.organization_id
    FROM payment_attempts
   WHERE payment_attempts.provider_code = candidate_provider_code
     AND payment_attempts.provider_reference = candidate_reference
   ORDER BY payment_attempts.attempt_number DESC
   LIMIT 1;
$$;
