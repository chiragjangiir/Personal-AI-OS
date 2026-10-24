BEGIN;

CREATE TABLE IF NOT EXISTS idempotency_ledger (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_fingerprint TEXT,
  status TEXT NOT NULL,
  response JSONB,
  response_hash TEXT,
  fencing_epoch NUMERIC(38, 0),
  claim_token_sha256 TEXT,
  claim_owner TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_ledger_pkey PRIMARY KEY (scope, idempotency_key),
  CONSTRAINT idempotency_ledger_scope_ck CHECK (length(scope) BETWEEN 1 AND 256),
  CONSTRAINT idempotency_ledger_key_ck CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CONSTRAINT idempotency_ledger_request_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_ledger_status_ck CHECK (status IN ('in_flight', 'committed', 'failed', 'indeterminate')),
  CONSTRAINT idempotency_ledger_response_hash_ck CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_ledger_response_pair_ck CHECK ((response IS NULL) = (response_hash IS NULL)),
  CONSTRAINT idempotency_ledger_terminal_response_ck CHECK (status = 'in_flight' OR response IS NOT NULL),
  CONSTRAINT idempotency_ledger_fencing_epoch_ck CHECK (fencing_epoch IS NULL OR fencing_epoch >= 1),
  CONSTRAINT idempotency_ledger_claim_token_ck CHECK (claim_token_sha256 IS NULL OR claim_token_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  aggregate_ref JSONB,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  published_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_pkey PRIMARY KEY (event_id),
  CONSTRAINT outbox_events_idempotency_uq UNIQUE (idempotency_scope, idempotency_key, event_type),
  CONSTRAINT outbox_events_aggregate_type_ck CHECK (length(aggregate_type) > 0),
  CONSTRAINT outbox_events_event_type_ck CHECK (length(event_type) > 0),
  CONSTRAINT outbox_events_event_version_ck CHECK (event_version >= 1),
  CONSTRAINT outbox_events_payload_sha256_ck CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outbox_events_status_ck CHECK (status IN ('pending', 'claimed', 'published', 'failed')),
  CONSTRAINT outbox_events_attempt_count_ck CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS outbox_events_claim_idx
  ON outbox_events (status, available_at, created_at, event_id);

CREATE TABLE IF NOT EXISTS outbox_consumer_dedupe (
  consumer_name TEXT NOT NULL,
  event_id UUID NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT outbox_consumer_dedupe_pkey PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT outbox_consumer_dedupe_consumer_ck CHECK (length(consumer_name) BETWEEN 1 AND 256),
  CONSTRAINT outbox_consumer_dedupe_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outbox_consumer_dedupe_event_fk FOREIGN KEY (event_id)
    REFERENCES outbox_events (event_id) ON DELETE CASCADE
);

DO $migration_assert$
DECLARE
  actual_columns TEXT[];
  expected_columns TEXT[];
  required_constraints TEXT[];
BEGIN
  expected_columns := ARRAY[
    'scope', 'idempotency_key', 'request_hash', 'request_fingerprint', 'status',
    'response', 'response_hash', 'fencing_epoch', 'claim_token_sha256', 'claim_owner',
    'claimed_at', 'completed_at', 'created_at', 'updated_at'
  ];
  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.idempotency_ledger'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0001_IDEMPOTENCY_LEDGER_SHAPE_MISMATCH';
  END IF;

  expected_columns := ARRAY[
    'event_id', 'aggregate_type', 'aggregate_id', 'aggregate_ref', 'event_type',
    'event_version', 'idempotency_scope', 'idempotency_key', 'payload', 'payload_sha256',
    'status', 'attempt_count', 'available_at', 'claimed_at', 'claimed_by', 'published_at',
    'last_error_code', 'created_at', 'updated_at'
  ];
  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.outbox_events'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0001_OUTBOX_EVENTS_SHAPE_MISMATCH';
  END IF;

  expected_columns := ARRAY['consumer_name', 'event_id', 'payload_hash', 'processed_at'];
  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.outbox_consumer_dedupe'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0001_OUTBOX_DEDUPE_SHAPE_MISMATCH';
  END IF;

  required_constraints := ARRAY[
    'idempotency_ledger_pkey', 'idempotency_ledger_scope_ck', 'idempotency_ledger_key_ck',
    'idempotency_ledger_request_hash_ck', 'idempotency_ledger_status_ck',
    'idempotency_ledger_response_hash_ck', 'idempotency_ledger_response_pair_ck',
    'idempotency_ledger_terminal_response_ck', 'idempotency_ledger_fencing_epoch_ck',
    'idempotency_ledger_claim_token_ck', 'outbox_events_pkey', 'outbox_events_idempotency_uq',
    'outbox_events_aggregate_type_ck', 'outbox_events_event_type_ck',
    'outbox_events_event_version_ck', 'outbox_events_payload_sha256_ck',
    'outbox_events_status_ck', 'outbox_events_attempt_count_ck',
    'outbox_consumer_dedupe_pkey', 'outbox_consumer_dedupe_consumer_ck',
    'outbox_consumer_dedupe_payload_hash_ck', 'outbox_consumer_dedupe_event_fk'
  ];
  IF EXISTS (
    SELECT 1 FROM unnest(required_constraints) AS required(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conname = required.name
        AND c.connamespace = 'public'::regnamespace
    )
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0001_CONSTRAINT_SET_MISMATCH';
  END IF;
  IF to_regclass('public.outbox_events_claim_idx') IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0001_INDEX_SET_MISMATCH';
  END IF;
END
$migration_assert$;

COMMIT;
