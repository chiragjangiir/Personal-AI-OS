-- Verifier for 0010_formal_watch_binding.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.apple_physical_canary_bindings') AND attname = 'user_id' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.apple_physical_canary_bindings') AND attname = 'watch_installation_id' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.apple_physical_canary_bindings') AND attname = 'pair_version' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.apple_physical_canary_bindings') AND attname = 'principal_ref' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'apple_companion_source_ck' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'apple_formal_watch_fields_ck' AND convalidated)),
  (to_regclass('public.apple_formal_watch_active_primary_uq') IS NOT NULL),
  (to_regclass('public.apple_formal_watch_active_installation_uq') IS NOT NULL)
) AS v(p);
