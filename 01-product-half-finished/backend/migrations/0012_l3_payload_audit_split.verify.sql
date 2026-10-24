-- Verifier for 0012_l3_payload_audit_split.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.paios_l3_payloads') IS NOT NULL),
  (to_regclass('public.paios_l3_forgotten') IS NOT NULL),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.paios_l3_versions') AND attname = 'audit' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.paios_l3_receipts') AND attname = 'command_audit' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'l3_version_audit_shape' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'l3_command_audit_shape' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'l3_forgotten_immutable' AND NOT tgisinternal))
) AS v(p);
