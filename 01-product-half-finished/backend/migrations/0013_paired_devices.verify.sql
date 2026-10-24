-- Verifier for 0013_paired_devices.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.paired_devices') IS NOT NULL),
  (to_regclass('public.paired_devices_active_class_uq') IS NOT NULL)
) AS v(p);
