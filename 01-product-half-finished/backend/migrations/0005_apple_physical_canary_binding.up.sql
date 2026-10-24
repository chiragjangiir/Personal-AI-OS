BEGIN;

DO $migration_preflight$
DECLARE
  actual_tables TEXT[];
  expected_tables TEXT[] := ARRAY[
    'device_leases','idempotency_ledger','memory_authority_clock','memory_candidate_heads',
    'memory_candidates','memory_deletion_mutations','memory_derived_projections','memory_dream_deltas',
    'memory_rebuild_runs','memory_slot_heads','memory_versions','outbox_consumer_dedupe',
    'outbox_events','realtime_external_effects','realtime_handoff_facts','realtime_sessions',
    'realtime_terminal_facts','realtime_transport_aliases'
  ];
BEGIN
  IF to_regclass('public.apple_physical_canary_bindings') IS NOT NULL THEN
    expected_tables := array_append(expected_tables, 'apple_physical_canary_bindings');
  END IF;
  SELECT array_agg(c.relname ORDER BY c.relname) INTO actual_tables
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = FALSE;
  SELECT array_agg(value ORDER BY value) INTO expected_tables FROM unnest(expected_tables) AS value;
  IF actual_tables IS DISTINCT FROM expected_tables THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_PREIMAGE_TABLE_SET_MISMATCH';
  END IF;
END
$migration_preflight$;

CREATE TABLE IF NOT EXISTS apple_physical_canary_bindings (
  binding_id UUID NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint_sha256 TEXT NOT NULL,
  realtime_session_ref JSONB NOT NULL,
  session_ref_id UUID NOT NULL,
  session_object_version TEXT NOT NULL,
  session_payload_sha256 TEXT NOT NULL,
  iphone_device_lease_ref JSONB NOT NULL,
  iphone_lease_ref_id UUID NOT NULL,
  iphone_lease_object_version TEXT NOT NULL,
  iphone_lease_payload_sha256 TEXT NOT NULL,
  iphone_device_id UUID NOT NULL,
  iphone_client_instance_id UUID NOT NULL,
  watch_device_lease_ref JSONB NOT NULL,
  watch_lease_ref_id UUID NOT NULL,
  watch_lease_object_version TEXT NOT NULL,
  watch_lease_payload_sha256 TEXT NOT NULL,
  watch_device_id UUID NOT NULL,
  watch_client_instance_id UUID NOT NULL,
  companion_role TEXT NOT NULL DEFAULT 'watch',
  companion_source TEXT NOT NULL DEFAULT 'apple_physical_canary_binding_v1',
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  object_version TEXT NOT NULL,
  receipt_jcs TEXT NOT NULL,
  canonical_payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT apple_physical_canary_bindings_pkey PRIMARY KEY (binding_id),
  CONSTRAINT apple_physical_canary_bindings_request_uq UNIQUE (request_id),
  CONSTRAINT apple_physical_canary_bindings_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT apple_physical_canary_bindings_session_fk FOREIGN KEY (session_ref_id)
    REFERENCES realtime_sessions (session_ref_id),
  CONSTRAINT apple_physical_canary_bindings_iphone_lease_fk FOREIGN KEY (iphone_lease_ref_id)
    REFERENCES device_leases (lease_ref_id),
  CONSTRAINT apple_physical_canary_bindings_watch_lease_fk FOREIGN KEY (watch_lease_ref_id)
    REFERENCES device_leases (lease_ref_id),
  CONSTRAINT apple_physical_canary_bindings_binding_uuidv7_ck CHECK (
    binding_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_request_ck CHECK (
    length(request_id) BETWEEN 1 AND 256 AND request_id !~ '[[:space:]]'
  ),
  CONSTRAINT apple_physical_canary_bindings_idempotency_ck CHECK (
    length(idempotency_key) BETWEEN 1 AND 256 AND idempotency_key !~ '[[:space:]]'
  ),
  CONSTRAINT apple_physical_canary_bindings_request_hash_ck CHECK (
    request_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_session_version_ck CHECK (
    session_object_version ~ '^[1-9][0-9]{0,37}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_session_hash_ck CHECK (
    session_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_iphone_lease_version_ck CHECK (
    iphone_lease_object_version ~ '^[1-9][0-9]{0,37}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_iphone_lease_hash_ck CHECK (
    iphone_lease_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_watch_lease_version_ck CHECK (
    watch_lease_object_version ~ '^[1-9][0-9]{0,37}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_watch_lease_hash_ck CHECK (
    watch_lease_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_companion_role_ck CHECK (companion_role = 'watch'),
  CONSTRAINT apple_physical_canary_bindings_companion_source_ck CHECK (
    companion_source = 'apple_physical_canary_binding_v1'
  ),
  CONSTRAINT apple_physical_canary_bindings_object_version_ck CHECK (
    object_version ~ '^[1-9][0-9]{0,37}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_payload_hash_ck CHECK (
    canonical_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT apple_physical_canary_bindings_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT apple_physical_canary_bindings_state_ck CHECK (state IN ('active', 'revoked')),
  CONSTRAINT apple_physical_canary_bindings_revocation_ck CHECK (
    (state = 'active' AND revoked_at IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT apple_physical_canary_bindings_lease_distinct_ck CHECK (
    iphone_lease_ref_id <> watch_lease_ref_id
  ),
  CONSTRAINT apple_physical_canary_bindings_identity_distinct_ck CHECK (
    iphone_device_id <> iphone_client_instance_id
    AND iphone_device_id <> watch_device_id
    AND iphone_device_id <> watch_client_instance_id
    AND iphone_client_instance_id <> watch_device_id
    AND iphone_client_instance_id <> watch_client_instance_id
    AND watch_device_id <> watch_client_instance_id
  )
);

CREATE INDEX IF NOT EXISTS apple_physical_canary_bindings_session_state_expires_idx
  ON apple_physical_canary_bindings (session_ref_id, state, expires_at);
CREATE INDEX IF NOT EXISTS apple_physical_canary_bindings_iphone_lease_idx
  ON apple_physical_canary_bindings (iphone_lease_ref_id);
CREATE INDEX IF NOT EXISTS apple_physical_canary_bindings_watch_lease_idx
  ON apple_physical_canary_bindings (watch_lease_ref_id);

DO $migration_assert$
DECLARE
  actual_tables TEXT[];
  expected_tables TEXT[] := ARRAY[
    'apple_physical_canary_bindings','device_leases','idempotency_ledger','memory_authority_clock',
    'memory_candidate_heads','memory_candidates','memory_deletion_mutations','memory_derived_projections',
    'memory_dream_deltas','memory_rebuild_runs','memory_slot_heads','memory_versions',
    'outbox_consumer_dedupe','outbox_events','realtime_external_effects','realtime_handoff_facts',
    'realtime_sessions','realtime_terminal_facts','realtime_transport_aliases'
  ];
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
  SELECT array_agg(c.relname ORDER BY c.relname) INTO actual_tables
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = FALSE;
  IF actual_tables IS DISTINCT FROM expected_tables THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_EXACT_19_TABLE_SET_MISMATCH';
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
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_TABLE_SHAPE_MISMATCH';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_not_null_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.apple_physical_canary_bindings'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull;
  IF actual_not_null_columns IS DISTINCT FROM expected_not_null_columns THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_NOT_NULL_SET_MISMATCH';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_nullable_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.apple_physical_canary_bindings'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull;
  IF actual_nullable_columns IS DISTINCT FROM ARRAY['revoked_at'] THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_NULLABLE_SET_MISMATCH';
  END IF;

  SELECT array_agg(c.conname ORDER BY c.conname) INTO actual_constraints
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.apple_physical_canary_bindings'::regclass
    AND c.contype <> 'n';
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_CONSTRAINT_SET_MISMATCH';
  END IF;

  SELECT array_agg(c.relname ORDER BY c.relname) INTO actual_indexes
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.apple_physical_canary_bindings'::regclass;
  IF actual_indexes IS DISTINCT FROM expected_indexes THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0005_INDEX_SET_MISMATCH';
  END IF;
END
$migration_assert$;

COMMIT;
