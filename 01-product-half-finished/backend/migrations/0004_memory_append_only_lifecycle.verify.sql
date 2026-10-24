-- Verifier for 0004_memory_append_only_lifecycle.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_candidates') AND attname = 'canonical_payload_jcs' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_candidates') AND attname = 'canonical_payload' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_candidates') AND attname = 'canonical_receipt_projection' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_candidates') AND attname = 'canonical_receipt_projection_jcs' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_candidates') AND attname = 'canonical_receipt_projection_sha256' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_versions') AND attname = 'canonical_payload_jcs' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_versions') AND attname = 'canonical_payload' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_versions') AND attname = 'canonical_receipt_projection' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_versions') AND attname = 'canonical_receipt_projection_jcs' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.memory_versions') AND attname = 'canonical_receipt_projection_sha256' AND attnum > 0 AND NOT attisdropped)),
  (to_regclass('public.memory_candidate_heads') IS NOT NULL),
  (to_regclass('public.memory_slot_heads') IS NOT NULL),
  (to_regproc('public.memory_append_only_immutable_guard') IS NOT NULL),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'memory_candidates_append_only_guard' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'memory_versions_append_only_guard' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'memory_candidates_canonical_bundle_ck' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'memory_versions_canonical_bundle_ck' AND convalidated))
) AS v(p);
