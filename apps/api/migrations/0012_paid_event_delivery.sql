-- Delivering the paid event.
--
-- The event has been written durably since 0009; nothing consumed it. Delivery
-- is one HTTP call to the notification service, made by a worker that claims
-- events by lease exactly as reconciliation claims payments, so a worker that
-- dies mid-delivery delays its events by one lease and loses none.
--
-- The notification service deduplicates on the idempotency key it is sent, which
-- is the event's own id. A retry after a timeout therefore cannot produce a
-- second message, however many times the same event is handed over.
-- ===================================================================
ALTER TABLE payment_events
  -- `delivered`: the notification service accepted it, and its identifier is in
  -- delivery_reference. `skipped`: nobody could be told, because the payment
  -- carried no recipient. `abandoned`: every attempt failed and an operator owns
  -- it. Only `pending` is ever claimed.
  ADD COLUMN delivery_status    TEXT NOT NULL DEFAULT 'pending'
                                CHECK (delivery_status IN ('pending', 'delivered', 'skipped', 'abandoned')),
  ADD COLUMN delivery_reference TEXT,
  ADD COLUMN last_failure       TEXT,
  ADD CONSTRAINT payment_events_published_shape CHECK (
    (delivery_status = 'pending') = (published_at IS NULL)
  ),
  ADD CONSTRAINT payment_events_delivered_carry_reference CHECK (
    delivery_status <> 'delivered' OR delivery_reference IS NOT NULL
  );

DROP INDEX payment_events_unpublished;
CREATE INDEX payment_events_unpublished
  ON payment_events (next_attempt_at)
  WHERE delivery_status = 'pending';

-- Cross-tenant for the same reason reconciliation's claim is: one worker delivers
-- for every organization and has no tenant to scope itself to until it has read
-- one. It returns only events still pending and already due, and every write
-- that follows goes through the ordinary tenant-scoped path.
CREATE FUNCTION claim_payment_events_for_delivery(claim_limit INT, lease_seconds INT)
RETURNS TABLE (
  id              UUID,
  organization_id UUID,
  event_type      TEXT,
  payload         JSONB,
  occurred_at     TIMESTAMPTZ,
  attempts        INTEGER
)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  WITH due AS (
    SELECT payment_events.id FROM payment_events
     WHERE payment_events.delivery_status = 'pending'
       AND payment_events.next_attempt_at <= now()
     ORDER BY payment_events.next_attempt_at
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  )
  UPDATE payment_events
     SET next_attempt_at = now() + make_interval(secs => lease_seconds),
         attempts = payment_events.attempts + 1
   WHERE payment_events.id IN (SELECT due.id FROM due)
  RETURNING payment_events.id, payment_events.organization_id, payment_events.event_type,
            payment_events.payload, payment_events.occurred_at, payment_events.attempts;
$$;

-- Events delivery has given up on: the operator backlog for this queue.
CREATE FUNCTION count_payment_events_abandoned()
RETURNS BIGINT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM payment_events WHERE payment_events.delivery_status = 'abandoned';
$$;
