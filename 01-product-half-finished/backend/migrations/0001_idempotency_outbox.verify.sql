-- Verifier for 0001_idempotency_outbox.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.idempotency_ledger') IS NOT NULL),
  (to_regclass('public.outbox_events') IS NOT NULL),
  (to_regclass('public.outbox_events_claim_idx') IS NOT NULL),
  (to_regclass('public.outbox_consumer_dedupe') IS NOT NULL)
) AS v(p);
