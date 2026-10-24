-- Verifier for 0009_hermes_l3.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.paios_l3_versions') IS NOT NULL),
  (to_regclass('public.paios_l3_heads') IS NOT NULL),
  (to_regclass('public.paios_l3_receipts') IS NOT NULL),
  (to_regclass('public.paios_l3_receipts_run') IS NOT NULL),
  (to_regclass('public.paios_l3_dependencies') IS NOT NULL),
  (to_regclass('public.paios_l3_invalidations') IS NOT NULL),
  (to_regclass('public.paios_l3_watermark') IS NOT NULL),
  (to_regproc('public.paios_l3_immutable_guard') IS NOT NULL),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'l3_versions_immutable' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'l3_receipts_immutable' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'l3_invalidations_immutable' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'l3_dependencies_immutable' AND NOT tgisinternal))
) AS v(p);
