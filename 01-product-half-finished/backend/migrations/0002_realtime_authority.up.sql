BEGIN;

CREATE TABLE IF NOT EXISTS realtime_sessions (
  session_ref_id UUID NOT NULL,
  realtime_session_ref JSONB,
  session_object_version TEXT NOT NULL,
  session_payload_sha256 TEXT NOT NULL,
  continuity_ref JSONB,
  user_id UUID NOT NULL,
  continuity_id UUID NOT NULL,
  continuity_state TEXT NOT NULL DEFAULT 'active',
  active_device_lease_ref JSONB,
  active_device_id UUID,
  binding JSONB,
  state TEXT NOT NULL,
  connection_epoch NUMERIC(38, 0) NOT NULL,
  last_accepted_activity_at TIMESTAMPTZ,
  continuity_expires_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revision NUMERIC(38, 0) NOT NULL DEFAULT 1,
  CONSTRAINT realtime_sessions_pkey PRIMARY KEY (session_ref_id),
  CONSTRAINT realtime_sessions_object_version_ck CHECK (session_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT realtime_sessions_payload_sha256_ck CHECK (session_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT realtime_sessions_continuity_state_ck CHECK (continuity_state IN ('active', 'ended')),
  CONSTRAINT realtime_sessions_state_ck CHECK (state IN ('active', 'terminal', 'ended', 'expired', 'revoked')),
  CONSTRAINT realtime_sessions_connection_epoch_ck CHECK (connection_epoch >= 1),
  CONSTRAINT realtime_sessions_revision_ck CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS realtime_sessions_one_active_per_continuity_uq
  ON realtime_sessions (continuity_id)
  WHERE state = 'active' AND continuity_state = 'active';

CREATE TABLE IF NOT EXISTS device_leases (
  lease_ref_id UUID NOT NULL,
  device_lease_ref JSONB,
  lease_object_version TEXT NOT NULL,
  lease_payload_sha256 TEXT NOT NULL,
  session_ref_id UUID NOT NULL,
  realtime_session_ref JSONB,
  continuity_ref JSONB,
  user_id UUID NOT NULL,
  device_id UUID NOT NULL,
  continuity_id UUID NOT NULL,
  capabilities JSONB,
  purpose TEXT,
  policy_decision_ref JSONB,
  capability_scope JSONB NOT NULL,
  purpose_scope JSONB NOT NULL,
  policy_binding JSONB NOT NULL,
  revocable BOOLEAN NOT NULL DEFAULT TRUE,
  state TEXT NOT NULL,
  lease_version NUMERIC(38, 0) NOT NULL,
  fencing_token NUMERIC(38, 0) NOT NULL DEFAULT 1,
  issued_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_leases_pkey PRIMARY KEY (lease_ref_id),
  CONSTRAINT device_leases_session_fk FOREIGN KEY (session_ref_id)
    REFERENCES realtime_sessions (session_ref_id) ON DELETE CASCADE,
  CONSTRAINT device_leases_object_version_ck CHECK (lease_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT device_leases_payload_sha256_ck CHECK (lease_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_leases_state_ck CHECK (state IN ('active', 'released', 'expired', 'revoked')),
  CONSTRAINT device_leases_lease_version_ck CHECK (lease_version >= 1),
  CONSTRAINT device_leases_fencing_token_ck CHECK (fencing_token >= 1)
);

CREATE INDEX IF NOT EXISTS device_leases_session_state_idx
  ON device_leases (session_ref_id, state);

CREATE TABLE IF NOT EXISTS realtime_transport_aliases (
  session_ref_id UUID NOT NULL,
  lease_ref_id UUID NOT NULL,
  connection_epoch NUMERIC(38, 0) NOT NULL,
  alias_kind TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT realtime_transport_aliases_pkey PRIMARY KEY (
    session_ref_id, lease_ref_id, connection_epoch, alias_kind, alias_value
  ),
  CONSTRAINT realtime_transport_aliases_session_fk FOREIGN KEY (session_ref_id)
    REFERENCES realtime_sessions (session_ref_id) ON DELETE CASCADE,
  CONSTRAINT realtime_transport_aliases_lease_fk FOREIGN KEY (lease_ref_id)
    REFERENCES device_leases (lease_ref_id) ON DELETE CASCADE,
  CONSTRAINT realtime_transport_aliases_epoch_ck CHECK (connection_epoch >= 1),
  CONSTRAINT realtime_transport_aliases_kind_ck CHECK (
    alias_kind IN ('livekit_room', 'livekit_session', 'livekit_participant', 'provider_alias')
  ),
  CONSTRAINT realtime_transport_aliases_value_ck CHECK (length(alias_value) BETWEEN 1 AND 512)
);

CREATE INDEX IF NOT EXISTS realtime_transport_aliases_active_idx
  ON realtime_transport_aliases (session_ref_id, lease_ref_id, active, connection_epoch);

CREATE TABLE IF NOT EXISTS realtime_terminal_facts (
  terminal_fact_id UUID NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  request_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  session_ref_id UUID,
  lease_ref_id UUID,
  continuity_id UUID,
  connection_epoch NUMERIC(38, 0),
  realtime_session_ref JSONB,
  device_lease_ref JSONB,
  continuity_ref JSONB,
  operation_outcome JSONB NOT NULL,
  execution_facts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT realtime_terminal_facts_pkey PRIMARY KEY (terminal_fact_id),
  CONSTRAINT realtime_terminal_facts_request_uq UNIQUE (request_scope, idempotency_key),
  CONSTRAINT realtime_terminal_facts_operation_ck CHECK (operation IN (
    'bootstrap', 'connected_refresh', 'fully_disconnected_refresh',
    'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff',
    'reconnect', 'lease_release', 'realtime_e2ee_key_resolve'
  )),
  CONSTRAINT realtime_terminal_facts_status_ck CHECK (
    status IN ('success', 'error', 'cancelled', 'expired', 'revoked', 'indeterminate')
  ),
  CONSTRAINT realtime_terminal_facts_request_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT realtime_terminal_facts_epoch_ck CHECK (connection_epoch IS NULL OR connection_epoch >= 1)
);

CREATE TABLE IF NOT EXISTS realtime_handoff_facts (
  handoff_ref_id UUID NOT NULL,
  session_ref_id UUID NOT NULL,
  continuity_id UUID NOT NULL,
  from_device_id UUID NOT NULL,
  to_device_id UUID NOT NULL,
  expected_lease_version NUMERIC(38, 0) NOT NULL,
  resulting_lease_version NUMERIC(38, 0) NOT NULL,
  connection_epoch NUMERIC(38, 0) NOT NULL,
  request_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outcome JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT realtime_handoff_facts_pkey PRIMARY KEY (handoff_ref_id),
  CONSTRAINT realtime_handoff_facts_request_uq UNIQUE (request_scope, idempotency_key),
  CONSTRAINT realtime_handoff_facts_expected_version_ck CHECK (expected_lease_version >= 1),
  CONSTRAINT realtime_handoff_facts_resulting_version_ck CHECK (resulting_lease_version >= 1),
  CONSTRAINT realtime_handoff_facts_epoch_ck CHECK (connection_epoch >= 1),
  CONSTRAINT realtime_handoff_facts_request_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS realtime_external_effects (
  effect_id UUID NOT NULL,
  operation TEXT NOT NULL,
  request_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  wire_request JSONB NOT NULL,
  intent JSONB NOT NULL,
  claim_id TEXT NOT NULL,
  fencing_epoch NUMERIC(38, 0) NOT NULL,
  expected_connection_epoch NUMERIC(38, 0),
  expected_lease_version NUMERIC(38, 0),
  effect_state TEXT NOT NULL,
  stage_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  suppression_result JSONB,
  result JSONB,
  result_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT realtime_external_effects_pkey PRIMARY KEY (effect_id),
  CONSTRAINT realtime_external_effects_request_uq UNIQUE (request_scope, idempotency_key),
  CONSTRAINT realtime_external_effects_claim_uq UNIQUE (claim_id),
  CONSTRAINT realtime_external_effects_operation_ck CHECK (operation IN ('media_stop', 'handoff')),
  CONSTRAINT realtime_external_effects_fingerprint_hash_ck CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT realtime_external_effects_claim_ck CHECK (
    length(claim_id) BETWEEN 1 AND 256 AND claim_id !~ '[[:space:]]'
  ),
  CONSTRAINT realtime_external_effects_fencing_epoch_ck CHECK (fencing_epoch >= 1),
  CONSTRAINT realtime_external_effects_expected_epoch_ck CHECK (
    expected_connection_epoch IS NULL OR expected_connection_epoch >= 1
  ),
  CONSTRAINT realtime_external_effects_expected_lease_ck CHECK (
    expected_lease_version IS NULL OR expected_lease_version >= 1
  ),
  CONSTRAINT realtime_external_effects_state_ck CHECK (
    effect_state IN ('in_flight', 'committed', 'released', 'indeterminate')
  ),
  CONSTRAINT realtime_external_effects_result_hash_ck CHECK (
    result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT realtime_external_effects_result_pair_ck CHECK ((result IS NULL) = (result_sha256 IS NULL))
);

DO $claim_constraint_correction$
DECLARE
  definition TEXT;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid, TRUE) INTO definition
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.realtime_external_effects'::regclass
    AND c.conname = 'realtime_external_effects_claim_ck';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0002_CLAIM_CONSTRAINT_MISSING';
  ELSIF position('{1,256}' IN definition) > 0 THEN
    ALTER TABLE realtime_external_effects
      DROP CONSTRAINT realtime_external_effects_claim_ck;
    ALTER TABLE realtime_external_effects
      ADD CONSTRAINT realtime_external_effects_claim_ck CHECK (
        length(claim_id) BETWEEN 1 AND 256 AND claim_id !~ '[[:space:]]'
      );
  ELSIF position('length(claim_id)' IN definition) = 0
    OR position('!~' IN definition) = 0 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0002_CLAIM_CONSTRAINT_SHAPE_MISMATCH';
  END IF;
END
$claim_constraint_correction$;

DO $migration_assert$
DECLARE
  actual_columns TEXT[];
  expected_columns TEXT[];
  required_constraints TEXT[];
  required_indexes TEXT[];
  table_name TEXT;
  expected_by_table JSONB := jsonb_build_object(
    'realtime_sessions', ARRAY[
      'session_ref_id','realtime_session_ref','session_object_version','session_payload_sha256',
      'continuity_ref','user_id','continuity_id','continuity_state','active_device_lease_ref',
      'active_device_id','binding','state','connection_epoch','last_accepted_activity_at',
      'continuity_expires_at','terminal_at','terminal_reason','created_at','updated_at','revision'
    ],
    'device_leases', ARRAY[
      'lease_ref_id','device_lease_ref','lease_object_version','lease_payload_sha256','session_ref_id',
      'realtime_session_ref','continuity_ref','user_id','device_id','continuity_id','capabilities',
      'purpose','policy_decision_ref','capability_scope','purpose_scope','policy_binding','revocable',
      'state','lease_version','fencing_token','issued_at','acquired_at','expires_at','released_at',
      'revoked_at','updated_at'
    ],
    'realtime_transport_aliases', ARRAY[
      'session_ref_id','lease_ref_id','connection_epoch','alias_kind','alias_value','active','created_at','retired_at'
    ],
    'realtime_terminal_facts', ARRAY[
      'terminal_fact_id','operation','status','request_scope','idempotency_key','request_hash',
      'session_ref_id','lease_ref_id','continuity_id','connection_epoch','realtime_session_ref',
      'device_lease_ref','continuity_ref','operation_outcome','execution_facts','created_at'
    ],
    'realtime_handoff_facts', ARRAY[
      'handoff_ref_id','session_ref_id','continuity_id','from_device_id','to_device_id',
      'expected_lease_version','resulting_lease_version','connection_epoch','request_scope',
      'idempotency_key','request_hash','outcome','occurred_at'
    ],
    'realtime_external_effects', ARRAY[
      'effect_id','operation','request_scope','idempotency_key','fingerprint','fingerprint_sha256',
      'wire_request','intent','claim_id','fencing_epoch','expected_connection_epoch',
      'expected_lease_version','effect_state','stage_state','suppression_result','result',
      'result_sha256','created_at','claimed_at','committed_at','released_at','updated_at'
    ]
  );
BEGIN
  FOR table_name IN SELECT jsonb_object_keys(expected_by_table)
  LOOP
    SELECT array_agg(value ORDER BY ordinality) INTO expected_columns
    FROM jsonb_array_elements_text(expected_by_table -> table_name) WITH ORDINALITY;
    SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = format('public.%I', table_name)::regclass
      AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual_columns IS DISTINCT FROM expected_columns THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0002_TABLE_SHAPE_MISMATCH:%', table_name;
    END IF;
  END LOOP;

  required_constraints := ARRAY[
    'realtime_sessions_pkey','realtime_sessions_object_version_ck','realtime_sessions_payload_sha256_ck',
    'realtime_sessions_continuity_state_ck','realtime_sessions_state_ck','realtime_sessions_connection_epoch_ck',
    'realtime_sessions_revision_ck','device_leases_pkey','device_leases_session_fk',
    'device_leases_object_version_ck','device_leases_payload_sha256_ck','device_leases_state_ck',
    'device_leases_lease_version_ck','device_leases_fencing_token_ck','realtime_transport_aliases_pkey',
    'realtime_transport_aliases_session_fk','realtime_transport_aliases_lease_fk',
    'realtime_transport_aliases_epoch_ck','realtime_transport_aliases_kind_ck','realtime_transport_aliases_value_ck',
    'realtime_terminal_facts_pkey','realtime_terminal_facts_request_uq','realtime_terminal_facts_operation_ck',
    'realtime_terminal_facts_status_ck','realtime_terminal_facts_request_hash_ck','realtime_terminal_facts_epoch_ck',
    'realtime_handoff_facts_pkey','realtime_handoff_facts_request_uq','realtime_handoff_facts_expected_version_ck',
    'realtime_handoff_facts_resulting_version_ck','realtime_handoff_facts_epoch_ck',
    'realtime_handoff_facts_request_hash_ck','realtime_external_effects_pkey',
    'realtime_external_effects_request_uq','realtime_external_effects_claim_uq',
    'realtime_external_effects_operation_ck','realtime_external_effects_fingerprint_hash_ck',
    'realtime_external_effects_claim_ck','realtime_external_effects_fencing_epoch_ck',
    'realtime_external_effects_expected_epoch_ck','realtime_external_effects_expected_lease_ck',
    'realtime_external_effects_state_ck','realtime_external_effects_result_hash_ck',
    'realtime_external_effects_result_pair_ck'
  ];
  IF EXISTS (
    SELECT 1 FROM unnest(required_constraints) AS required(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conname = required.name
        AND c.connamespace = 'public'::regnamespace
    )
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0002_CONSTRAINT_SET_MISMATCH';
  END IF;

  required_indexes := ARRAY[
    'realtime_sessions_one_active_per_continuity_uq',
    'device_leases_session_state_idx',
    'realtime_transport_aliases_active_idx'
  ];
  IF EXISTS (
    SELECT 1 FROM unnest(required_indexes) AS required(name)
    WHERE to_regclass('public.' || required.name) IS NULL
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0002_INDEX_SET_MISMATCH';
  END IF;
END
$migration_assert$;

COMMIT;
