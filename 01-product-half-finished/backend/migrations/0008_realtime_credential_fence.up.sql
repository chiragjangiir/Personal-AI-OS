BEGIN;

LOCK TABLE public.realtime_external_effects IN SHARE ROW EXCLUSIVE MODE;

DO $credential_fence_preflight$
DECLARE
  table_oid OID;
BEGIN
  SELECT to_regclass('public.realtime_external_effects')::oid INTO table_oid;
  IF table_oid IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0008_EXTERNAL_EFFECTS_TABLE_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = table_oid
       AND a.attname IN (
         'realtime_session_ref', 'device_lease_ref', 'continuity_id',
         'connection_epoch', 'credential_generation'
       )
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0008_ALREADY_APPLIED';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = table_oid
       AND c.conname IN (
         'realtime_external_effects_credential_fence_tuple_ck',
         'realtime_external_effects_credential_fence_decimal_ck'
       )
  ) OR to_regclass('public.realtime_external_effects_credential_fence_uq') IS NOT NULL
     OR to_regclass('public.realtime_external_effects_credential_fence_lookup_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0008_OBJECT_PREIMAGE_DRIFT';
  END IF;
END
$credential_fence_preflight$;

ALTER TABLE public.realtime_external_effects
  ADD COLUMN realtime_session_ref JSONB,
  ADD COLUMN device_lease_ref JSONB,
  ADD COLUMN continuity_id TEXT,
  ADD COLUMN connection_epoch NUMERIC(38, 0),
  ADD COLUMN credential_generation NUMERIC(38, 0);

ALTER TABLE public.realtime_external_effects
  ADD CONSTRAINT realtime_external_effects_credential_fence_tuple_ck CHECK (
    (
      operation <> 'media_stop'
      AND realtime_session_ref IS NULL
      AND device_lease_ref IS NULL
      AND continuity_id IS NULL
      AND connection_epoch IS NULL
      AND credential_generation IS NULL
    )
    OR (
      operation = 'media_stop'
      AND (
        (
          realtime_session_ref IS NULL
          AND device_lease_ref IS NULL
          AND continuity_id IS NULL
          AND connection_epoch IS NULL
          AND credential_generation IS NULL
        )
        OR (
          jsonb_typeof(realtime_session_ref) = 'object'
          AND realtime_session_ref ?& ARRAY[
            'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
          ]
          AND (realtime_session_ref - ARRAY[
            'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
          ]::text[]) = '{}'::jsonb
          AND realtime_session_ref->>'ref_type' = 'RealtimeSession'
          AND realtime_session_ref->>'ref_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND realtime_session_ref->>'object_version' ~ '^[1-9][0-9]{0,37}$'
          AND realtime_session_ref->>'canonical_payload_sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(device_lease_ref) = 'object'
          AND device_lease_ref ?& ARRAY[
            'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
          ]
          AND (device_lease_ref - ARRAY[
            'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
          ]::text[]) = '{}'::jsonb
          AND device_lease_ref->>'ref_type' = 'DeviceLease'
          AND device_lease_ref->>'ref_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND device_lease_ref->>'object_version' ~ '^[1-9][0-9]{0,37}$'
          AND device_lease_ref->>'canonical_payload_sha256' ~ '^[0-9a-f]{64}$'
          AND continuity_id ~ '^[^[:space:]]+$'
          AND char_length(continuity_id) BETWEEN 1 AND 256
          AND connection_epoch >= 1
          AND connection_epoch = trunc(connection_epoch)
          AND credential_generation >= 1
          AND credential_generation = trunc(credential_generation)
        )
      )
    )
  ),
  ADD CONSTRAINT realtime_external_effects_credential_fence_decimal_ck CHECK (
    (connection_epoch IS NULL OR (connection_epoch >= 1 AND connection_epoch = trunc(connection_epoch)))
    AND (credential_generation IS NULL OR (credential_generation >= 1 AND credential_generation = trunc(credential_generation)))
  );

CREATE UNIQUE INDEX realtime_external_effects_credential_fence_uq
  ON public.realtime_external_effects (
    realtime_session_ref, device_lease_ref, continuity_id,
    connection_epoch, credential_generation
  )
  WHERE operation = 'media_stop'
    AND realtime_session_ref IS NOT NULL
    AND device_lease_ref IS NOT NULL
    AND continuity_id IS NOT NULL
    AND connection_epoch IS NOT NULL
    AND credential_generation IS NOT NULL
    AND effect_state IN ('in_flight', 'indeterminate', 'committed');

CREATE INDEX realtime_external_effects_credential_fence_lookup_idx
  ON public.realtime_external_effects (
    realtime_session_ref, device_lease_ref, continuity_id,
    connection_epoch, credential_generation, effect_state
  )
  WHERE operation = 'media_stop'
    AND realtime_session_ref IS NOT NULL
    AND device_lease_ref IS NOT NULL
    AND continuity_id IS NOT NULL
    AND connection_epoch IS NOT NULL
    AND credential_generation IS NOT NULL;

COMMENT ON COLUMN public.realtime_external_effects.realtime_session_ref IS
  'Canonical RealtimeSession ref for the credential-fence tuple; NULL only on legacy unfenced rows.';
COMMENT ON COLUMN public.realtime_external_effects.device_lease_ref IS
  'Canonical DeviceLease ref for the credential-fence tuple; NULL only on legacy unfenced rows.';
COMMENT ON COLUMN public.realtime_external_effects.credential_generation IS
  'Credential generation supplied by the credential authority; never inferred from fencing_epoch or lease_version.';
COMMENT ON INDEX public.realtime_external_effects_credential_fence_uq IS
  'Only one active media-stop credential fence may exist for one exact canonical tuple.';

DO $credential_fence_assert$
DECLARE
  expected_columns TEXT[] := ARRAY[
    'effect_id', 'operation', 'request_scope', 'idempotency_key', 'fingerprint',
    'fingerprint_sha256', 'wire_request', 'intent', 'claim_id', 'fencing_epoch',
    'expected_connection_epoch', 'expected_lease_version', 'effect_state', 'stage_state',
    'suppression_result', 'result', 'result_sha256', 'created_at', 'claimed_at',
    'committed_at', 'released_at', 'updated_at', 'realtime_session_ref', 'device_lease_ref',
    'continuity_id', 'connection_epoch', 'credential_generation'
  ];
  actual_columns TEXT[];
BEGIN
  SELECT array_agg(a.attname ORDER BY a.attnum)
    INTO actual_columns
    FROM pg_catalog.pg_attribute AS a
   WHERE a.attrelid = 'public.realtime_external_effects'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0008_EXTERNAL_EFFECTS_TABLE_SHAPE_MISMATCH';
  END IF;
  IF (
    SELECT count(*)
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.realtime_external_effects'::regclass
       AND c.conname IN (
         'realtime_external_effects_credential_fence_tuple_ck',
         'realtime_external_effects_credential_fence_decimal_ck'
       )
       AND c.contype = 'c'
       AND c.convalidated
  ) <> 2 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0008_CREDENTIAL_FENCE_CONSTRAINT_SET_MISMATCH';
  END IF;
  IF to_regclass('public.realtime_external_effects_credential_fence_uq') IS NULL
     OR to_regclass('public.realtime_external_effects_credential_fence_lookup_idx') IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0008_CREDENTIAL_FENCE_INDEX_SET_MISMATCH';
  END IF;
END
$credential_fence_assert$;

COMMIT;
