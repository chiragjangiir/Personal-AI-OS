-- Verifier for 0008_realtime_credential_fence.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.realtime_external_effects') AND attname = 'realtime_session_ref' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.realtime_external_effects') AND attname = 'device_lease_ref' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.realtime_external_effects') AND attname = 'continuity_id' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.realtime_external_effects') AND attname = 'connection_epoch' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.realtime_external_effects') AND attname = 'credential_generation' AND attnum > 0 AND NOT attisdropped)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'realtime_external_effects_credential_fence_tuple_ck' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'realtime_external_effects_credential_fence_decimal_ck' AND convalidated)),
  (to_regclass('public.realtime_external_effects_credential_fence_uq') IS NOT NULL),
  (to_regclass('public.realtime_external_effects_credential_fence_lookup_idx') IS NOT NULL)
) AS v(p);
