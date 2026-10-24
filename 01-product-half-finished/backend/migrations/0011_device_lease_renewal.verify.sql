-- Verifier for 0011_device_lease_renewal.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'realtime_terminal_facts_operation_ck' AND convalidated AND pg_get_constraintdef(oid, TRUE) LIKE '%device_lease_renewal%'))
) AS v(p);
