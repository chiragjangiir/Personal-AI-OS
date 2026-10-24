BEGIN;

DO $migration_down_preflight$
DECLARE
  actual_columns TEXT[];
  actual_not_null_columns TEXT[];
  expected_not_null_columns TEXT[] := ARRAY[
    'binding_id','request_id','idempotency_key','request_fingerprint_sha256',
    'realtime_session_ref','session_ref_id','session_object_version','session_payload_sha256',
    'iphone_device_lease_ref','iphone_lease_ref_id','iphone_lease_object_version',
    'iphone_lease_payload_sha256','iphone_device_id','iphone_client_instance_id',
    'watch_device_lease_ref','watch_lease_ref_id','watch_lease_object_version',
    'watch_lease_payload_sha256','watch_device_id','watch_client_instance_id','companion_role',
    'companion_source','issued_at','expires_at','object_version','receipt_jcs','canonical_payload_sha256',
    'state','created_at','updated_at'
  ];
  actual_nullable_columns TEXT[];
  actual_constraints TEXT[];
  expected_constraints TEXT[] := ARRAY[
    'apple_physical_canary_bindings_binding_uuidv7_ck',
    'apple_physical_canary_bindings_companion_role_ck',
    'apple_physical_canary_bindings_companion_source_ck',
    'apple_physical_canary_bindings_expiry_ck',
    'apple_physical_canary_bindings_idempotency_ck',
    'apple_physical_canary_bindings_idempotency_uq',
    'apple_physical_canary_bindings_identity_distinct_ck',
    'apple_physical_canary_bindings_iphone_lease_fk',
    'apple_physical_canary_bindings_iphone_lease_hash_ck',
    'apple_physical_canary_bindings_iphone_lease_version_ck',
    'apple_physical_canary_bindings_lease_distinct_ck',
    'apple_physical_canary_bindings_object_version_ck',
    'apple_physical_canary_bindings_payload_hash_ck',
    'apple_physical_canary_bindings_pkey',
    'apple_physical_canary_bindings_request_ck',
    'apple_physical_canary_bindings_request_hash_ck',
    'apple_physical_canary_bindings_request_uq',
    'apple_physical_canary_bindings_revocation_ck',
    'apple_physical_canary_bindings_session_fk',
    'apple_physical_canary_bindings_session_hash_ck',
    'apple_physical_canary_bindings_session_version_ck',
    'apple_physical_canary_bindings_state_ck',
    'apple_physical_canary_bindings_watch_lease_fk',
    'apple_physical_canary_bindings_watch_lease_hash_ck',
    'apple_physical_canary_bindings_watch_lease_version_ck'
  ];
  actual_indexes TEXT[];
  expected_indexes TEXT[] := ARRAY[
    'apple_physical_canary_bindings_idempotency_uq',
    'apple_physical_canary_bindings_iphone_lease_idx',
    'apple_physical_canary_bindings_pkey',
    'apple_physical_canary_bindings_request_uq',
    'apple_physical_canary_bindings_session_state_expires_idx',
    'apple_physical_canary_bindings_watch_lease_idx'
  ];
BEGIN
  IF to_regclass('public.apple_physical_canary_bindings') IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(expected_indexes)
    ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_ORPHAN_INDEX_DRIFT';
    END IF;
    RETURN;
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.apple_physical_canary_bindings'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'binding_id','request_id','idempotency_key','request_fingerprint_sha256',
    'realtime_session_ref','session_ref_id','session_object_version','session_payload_sha256',
    'iphone_device_lease_ref','iphone_lease_ref_id','iphone_lease_object_version',
    'iphone_lease_payload_sha256','iphone_device_id','iphone_client_instance_id',
    'watch_device_lease_ref','watch_lease_ref_id','watch_lease_object_version',
    'watch_lease_payload_sha256','watch_device_id','watch_client_instance_id','companion_role',
    'companion_source','issued_at','expires_at','object_version','receipt_jcs','canonical_payload_sha256','state',
    'revoked_at','created_at','updated_at'
  ] THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_TABLE_SHAPE_MISMATCH';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_not_null_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.apple_physical_canary_bindings'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull;
  IF actual_not_null_columns IS DISTINCT FROM expected_not_null_columns THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_NOT_NULL_SET_MISMATCH';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_nullable_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.apple_physical_canary_bindings'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull;
  IF actual_nullable_columns IS DISTINCT FROM ARRAY['revoked_at'] THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_NULLABLE_SET_MISMATCH';
  END IF;

  SELECT array_agg(c.conname ORDER BY c.conname) INTO actual_constraints
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.apple_physical_canary_bindings'::regclass
    AND c.contype <> 'n';
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_CONSTRAINT_SET_MISMATCH';
  END IF;

  SELECT array_agg(c.relname ORDER BY c.relname) INTO actual_indexes
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.apple_physical_canary_bindings'::regclass;
  IF actual_indexes IS DISTINCT FROM expected_indexes THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_INDEX_SET_MISMATCH';
  END IF;
END
$migration_down_preflight$;

DROP TABLE IF EXISTS apple_physical_canary_bindings;

DO $migration_down_assert$
BEGIN
  IF to_regclass('public.apple_physical_canary_bindings') IS NOT NULL
    OR to_regclass('public.apple_physical_canary_bindings_session_state_expires_idx') IS NOT NULL
    OR to_regclass('public.apple_physical_canary_bindings_iphone_lease_idx') IS NOT NULL
    OR to_regclass('public.apple_physical_canary_bindings_watch_lease_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_DOWN_POSTSTATE_MISMATCH';
  END IF;
END
$migration_down_assert$;

COMMIT;
