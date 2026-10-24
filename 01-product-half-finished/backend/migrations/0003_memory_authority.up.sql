BEGIN;

CREATE TABLE IF NOT EXISTS memory_authority_clock (
  clock_id BOOLEAN NOT NULL DEFAULT TRUE,
  watermark TEXT NOT NULL DEFAULT '1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_authority_clock_pkey PRIMARY KEY (clock_id),
  CONSTRAINT memory_authority_clock_singleton_ck CHECK (clock_id = TRUE),
  CONSTRAINT memory_authority_clock_watermark_ck CHECK (watermark ~ '^[1-9][0-9]*$')
);

INSERT INTO memory_authority_clock (clock_id, watermark)
VALUES (TRUE, '1')
ON CONFLICT (clock_id) DO NOTHING;

ALTER TABLE memory_authority_clock
  DROP CONSTRAINT IF EXISTS memory_authority_clock_watermark_check;
UPDATE memory_authority_clock SET watermark = '1' WHERE clock_id = TRUE AND watermark = '0';
ALTER TABLE memory_authority_clock ALTER COLUMN watermark SET DEFAULT '1';

DO $clock_constraint$
DECLARE
  definition TEXT;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid, TRUE) INTO definition
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.memory_authority_clock'::regclass
    AND c.conname = 'memory_authority_clock_watermark_ck';
  IF definition IS NULL THEN
    ALTER TABLE memory_authority_clock
      ADD CONSTRAINT memory_authority_clock_watermark_ck
      CHECK (watermark ~ '^[1-9][0-9]*$');
  ELSIF position('^[1-9][0-9]*$' IN definition) = 0 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0003_CLOCK_CONSTRAINT_MISMATCH';
  END IF;
END
$clock_constraint$;

CREATE TABLE IF NOT EXISTS memory_candidates (
  candidate_ref JSONB NOT NULL,
  candidate_ref_type TEXT NOT NULL,
  candidate_ref_id UUID NOT NULL,
  candidate_object_version TEXT NOT NULL,
  candidate_payload_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  value JSONB NOT NULL,
  evidence_refs JSONB NOT NULL,
  source_class TEXT NOT NULL,
  confidence_ppm INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  current BOOLEAN NOT NULL DEFAULT FALSE,
  memory_kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose_scopes JSONB NOT NULL,
  sensitivity JSONB NOT NULL,
  validity JSONB NOT NULL,
  target_ref JSONB,
  target_ref_type TEXT,
  target_ref_id UUID,
  target_object_version TEXT,
  target_payload_sha256 TEXT,
  correction_intent JSONB,
  reason JSONB,
  conflict JSONB,
  requires_review BOOLEAN NOT NULL DEFAULT TRUE,
  conflict_binding JSONB,
  linked_memory_ref JSONB,
  linked_memory_ref_type TEXT,
  linked_memory_ref_id UUID,
  linked_memory_object_version TEXT,
  linked_memory_payload_sha256 TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_candidates_identity_uq UNIQUE (
    candidate_ref_id, candidate_object_version, candidate_payload_sha256
  ),
  CONSTRAINT memory_candidates_object_version_ck CHECK (candidate_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_candidates_payload_sha256_ck CHECK (candidate_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_candidates_confidence_ck CHECK (confidence_ppm BETWEEN 0 AND 1000000),
  CONSTRAINT memory_candidates_current_false_ck CHECK (current = FALSE),
  CONSTRAINT memory_candidates_target_bundle_ck CHECK (
    (target_ref IS NULL AND target_ref_type IS NULL AND target_ref_id IS NULL
      AND target_object_version IS NULL AND target_payload_sha256 IS NULL)
    OR
    (target_ref IS NOT NULL AND target_ref_type IS NOT NULL AND target_ref_id IS NOT NULL
      AND target_object_version ~ '^[1-9][0-9]*$'
      AND target_payload_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT memory_candidates_linked_bundle_ck CHECK (
    (linked_memory_ref IS NULL AND linked_memory_ref_type IS NULL AND linked_memory_ref_id IS NULL
      AND linked_memory_object_version IS NULL AND linked_memory_payload_sha256 IS NULL)
    OR
    (linked_memory_ref IS NOT NULL AND linked_memory_ref_type IS NOT NULL AND linked_memory_ref_id IS NOT NULL
      AND linked_memory_object_version ~ '^[1-9][0-9]*$'
      AND linked_memory_payload_sha256 ~ '^[0-9a-f]{64}$')
  )
);

CREATE INDEX IF NOT EXISTS memory_candidates_user_status_idx
  ON memory_candidates (user_id, status, created_at, candidate_ref_id);

CREATE TABLE IF NOT EXISTS memory_versions (
  memory_ref JSONB NOT NULL,
  memory_ref_type TEXT NOT NULL,
  memory_ref_id UUID NOT NULL,
  memory_object_version TEXT NOT NULL,
  memory_payload_sha256 TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot TEXT NOT NULL,
  value JSONB NOT NULL,
  resolved_content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  current BOOLEAN NOT NULL DEFAULT FALSE,
  source_class TEXT NOT NULL,
  evidence_refs JSONB NOT NULL,
  confidence_ppm INTEGER NOT NULL,
  allowed_purpose_scopes JSONB NOT NULL,
  sensitivity JSONB NOT NULL,
  validity JSONB NOT NULL,
  supersedes_ref JSONB,
  supersedes_ref_type TEXT,
  supersedes_ref_id UUID,
  supersedes_object_version TEXT,
  supersedes_payload_sha256 TEXT,
  correction_intent JSONB,
  dream_accepted_delta JSONB,
  deleted_at TIMESTAMPTZ,
  suppressed_at TIMESTAMPTZ,
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  derived_rank_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_versions_identity_uq UNIQUE (
    memory_ref_id, memory_object_version, memory_payload_sha256
  ),
  CONSTRAINT memory_versions_object_version_ck CHECK (memory_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_versions_payload_sha256_ck CHECK (memory_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_versions_confidence_ck CHECK (confidence_ppm BETWEEN 0 AND 1000000),
  CONSTRAINT memory_versions_supersedes_bundle_ck CHECK (
    (supersedes_ref IS NULL AND supersedes_ref_type IS NULL AND supersedes_ref_id IS NULL
      AND supersedes_object_version IS NULL AND supersedes_payload_sha256 IS NULL)
    OR
    (supersedes_ref IS NOT NULL AND supersedes_ref_type IS NOT NULL AND supersedes_ref_id IS NOT NULL
      AND supersedes_object_version ~ '^[1-9][0-9]*$'
      AND supersedes_payload_sha256 ~ '^[0-9a-f]{64}$')
  )
);

DO $legacy_current_index$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.memory_versions'::regclass
      AND attname = 'canonical_payload_jcs' AND NOT attisdropped
  ) THEN
    IF to_regclass('public.memory_versions_one_current_per_slot_uq') IS NULL THEN
      EXECUTE 'CREATE UNIQUE INDEX memory_versions_one_current_per_slot_uq '
        || 'ON memory_versions (user_id, slot) WHERE current = TRUE';
    END IF;
  ELSIF to_regclass('public.memory_versions_one_current_per_slot_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0003_SUCCESSOR_INDEX_STATE_MISMATCH';
  END IF;
END
$legacy_current_index$;

CREATE INDEX IF NOT EXISTS memory_versions_user_slot_read_idx
  ON memory_versions (user_id, slot, updated_at DESC, memory_ref_id);

CREATE TABLE IF NOT EXISTS memory_dream_deltas (
  delta_ref JSONB NOT NULL,
  delta_ref_type TEXT NOT NULL,
  delta_ref_id UUID NOT NULL,
  delta_object_version TEXT NOT NULL,
  delta_payload_sha256 TEXT NOT NULL,
  user_id TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  delta JSONB NOT NULL,
  source_refs JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  authority_watermark JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_dream_deltas_identity_uq UNIQUE (
    delta_ref_id, delta_object_version, delta_payload_sha256
  ),
  CONSTRAINT memory_dream_deltas_object_version_ck CHECK (delta_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_dream_deltas_payload_sha256_ck CHECK (delta_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_dream_deltas_accepted_ck CHECK (accepted = TRUE)
);

CREATE INDEX IF NOT EXISTS memory_dream_deltas_read_idx
  ON memory_dream_deltas (
    user_id, accepted_at, delta_ref_id, delta_object_version, delta_payload_sha256
  );

CREATE TABLE IF NOT EXISTS memory_derived_projections (
  projection_kind TEXT NOT NULL,
  authority_ref JSONB NOT NULL,
  authority_ref_type TEXT NOT NULL,
  authority_ref_id UUID NOT NULL,
  authority_object_version TEXT NOT NULL,
  authority_payload_sha256 TEXT NOT NULL,
  authority_watermark JSONB NOT NULL,
  implementation_version TEXT NOT NULL,
  configuration_sha256 TEXT NOT NULL,
  projection_sha256 TEXT NOT NULL,
  record_count BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_derived_projections_pkey PRIMARY KEY (
    projection_kind, authority_ref_id, authority_object_version,
    authority_payload_sha256, configuration_sha256
  ),
  CONSTRAINT memory_derived_projections_kind_ck CHECK (projection_kind IN ('fts', 'pgvector', 'graph')),
  CONSTRAINT memory_derived_projections_object_version_ck CHECK (authority_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_derived_projections_authority_hash_ck CHECK (authority_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_derived_projections_configuration_hash_ck CHECK (configuration_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_derived_projections_projection_hash_ck CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_derived_projections_record_count_ck CHECK (record_count >= 0),
  CONSTRAINT memory_derived_projections_implementation_ck CHECK (length(implementation_version) > 0)
);

CREATE TABLE IF NOT EXISTS memory_deletion_mutations (
  deletion_job_ref JSONB NOT NULL,
  deletion_job_ref_type TEXT NOT NULL,
  deletion_job_ref_id UUID NOT NULL,
  deletion_job_object_version TEXT NOT NULL,
  deletion_job_payload_sha256 TEXT NOT NULL,
  target_ref JSONB NOT NULL,
  target_ref_type TEXT NOT NULL,
  target_ref_id UUID NOT NULL,
  target_object_version TEXT NOT NULL,
  target_payload_sha256 TEXT NOT NULL,
  target_status TEXT NOT NULL,
  target_current BOOLEAN NOT NULL,
  deleted BOOLEAN NOT NULL,
  suppressed BOOLEAN NOT NULL,
  tombstone BOOLEAN NOT NULL,
  non_resurrection BOOLEAN NOT NULL,
  authority_watermark JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_deletion_mutations_pkey PRIMARY KEY (
    idempotency_key, target_ref_id, target_object_version, target_payload_sha256
  ),
  CONSTRAINT memory_deletion_mutations_job_version_ck CHECK (deletion_job_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_deletion_mutations_job_hash_ck CHECK (deletion_job_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_deletion_mutations_target_version_ck CHECK (target_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_deletion_mutations_target_hash_ck CHECK (target_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_deletion_mutations_non_resurrection_ck CHECK (non_resurrection = TRUE)
);

CREATE TABLE IF NOT EXISTS memory_rebuild_runs ();

DO $migration_assert$
DECLARE
  actual_columns TEXT[];
  expected_columns TEXT[];
  required_constraints TEXT[];
  required_indexes TEXT[];
  table_name TEXT;
  expected_by_table JSONB := jsonb_build_object(
    'memory_authority_clock', ARRAY['clock_id','watermark','updated_at'],
    'memory_candidates', ARRAY[
      'candidate_ref','candidate_ref_type','candidate_ref_id','candidate_object_version',
      'candidate_payload_sha256','kind','status','proposal_id','slot','value','evidence_refs',
      'source_class','confidence_ppm','idempotency_key','current','memory_kind','user_id',
      'purpose_scopes','sensitivity','validity','target_ref','target_ref_type','target_ref_id',
      'target_object_version','target_payload_sha256','correction_intent','reason','conflict',
      'requires_review','conflict_binding','linked_memory_ref','linked_memory_ref_type',
      'linked_memory_ref_id','linked_memory_object_version','linked_memory_payload_sha256',
      'reviewed_at','created_at','updated_at'
    ],
    'memory_versions', ARRAY[
      'memory_ref','memory_ref_type','memory_ref_id','memory_object_version','memory_payload_sha256',
      'user_id','kind','slot','value','resolved_content','status','current','source_class',
      'evidence_refs','confidence_ppm','allowed_purpose_scopes','sensitivity','validity',
      'supersedes_ref','supersedes_ref_type','supersedes_ref_id','supersedes_object_version',
      'supersedes_payload_sha256','correction_intent','dream_accepted_delta','deleted_at',
      'suppressed_at','stale','derived_rank_score','created_at','updated_at'
    ],
    'memory_dream_deltas', ARRAY[
      'delta_ref','delta_ref_type','delta_ref_id','delta_object_version','delta_payload_sha256',
      'user_id','accepted','delta','source_refs','accepted_at','authority_watermark','created_at'
    ],
    'memory_derived_projections', ARRAY[
      'projection_kind','authority_ref','authority_ref_type','authority_ref_id',
      'authority_object_version','authority_payload_sha256','authority_watermark',
      'implementation_version','configuration_sha256','projection_sha256','record_count',
      'created_at','updated_at'
    ],
    'memory_deletion_mutations', ARRAY[
      'deletion_job_ref','deletion_job_ref_type','deletion_job_ref_id','deletion_job_object_version',
      'deletion_job_payload_sha256','target_ref','target_ref_type','target_ref_id',
      'target_object_version','target_payload_sha256','target_status','target_current','deleted',
      'suppressed','tombstone','non_resurrection','authority_watermark','idempotency_key',
      'created_at','updated_at'
    ],
    'memory_rebuild_runs', ARRAY[]::TEXT[]
  );
BEGIN
  FOR table_name IN SELECT jsonb_object_keys(expected_by_table)
  LOOP
    SELECT array_agg(value ORDER BY ordinality) INTO expected_columns
    FROM jsonb_array_elements_text(expected_by_table -> table_name) WITH ORDINALITY;
    IF table_name IN ('memory_candidates', 'memory_versions') AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = format('public.%I', table_name)::regclass
        AND attname = 'canonical_payload_jcs' AND NOT attisdropped
    ) THEN
      expected_columns := expected_columns || ARRAY[
        'canonical_payload_jcs','canonical_payload','canonical_receipt_projection',
        'canonical_receipt_projection_jcs','canonical_receipt_projection_sha256'
      ];
    END IF;
    SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = format('public.%I', table_name)::regclass
      AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual_columns IS DISTINCT FROM expected_columns THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0003_TABLE_SHAPE_MISMATCH:%', table_name;
    END IF;
  END LOOP;

  required_constraints := ARRAY[
    'memory_authority_clock_pkey','memory_authority_clock_singleton_ck',
    'memory_authority_clock_watermark_ck','memory_candidates_identity_uq',
    'memory_candidates_object_version_ck','memory_candidates_payload_sha256_ck',
    'memory_candidates_confidence_ck','memory_candidates_current_false_ck',
    'memory_candidates_target_bundle_ck','memory_candidates_linked_bundle_ck',
    'memory_versions_identity_uq','memory_versions_object_version_ck',
    'memory_versions_payload_sha256_ck','memory_versions_confidence_ck',
    'memory_versions_supersedes_bundle_ck','memory_dream_deltas_identity_uq',
    'memory_dream_deltas_object_version_ck','memory_dream_deltas_payload_sha256_ck',
    'memory_dream_deltas_accepted_ck','memory_derived_projections_pkey',
    'memory_derived_projections_kind_ck','memory_derived_projections_object_version_ck',
    'memory_derived_projections_authority_hash_ck','memory_derived_projections_configuration_hash_ck',
    'memory_derived_projections_projection_hash_ck','memory_derived_projections_record_count_ck',
    'memory_derived_projections_implementation_ck','memory_deletion_mutations_pkey',
    'memory_deletion_mutations_job_version_ck','memory_deletion_mutations_job_hash_ck',
    'memory_deletion_mutations_target_version_ck','memory_deletion_mutations_target_hash_ck',
    'memory_deletion_mutations_non_resurrection_ck'
  ];
  IF EXISTS (
    SELECT 1 FROM unnest(required_constraints) AS required(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conname = required.name
        AND c.connamespace = 'public'::regnamespace
    )
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0003_CONSTRAINT_SET_MISMATCH';
  END IF;

  required_indexes := ARRAY[
    'memory_candidates_user_status_idx','memory_versions_user_slot_read_idx','memory_dream_deltas_read_idx'
  ];
  IF EXISTS (
    SELECT 1 FROM unnest(required_indexes) AS required(name)
    WHERE to_regclass('public.' || required.name) IS NULL
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0003_INDEX_SET_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.memory_versions'::regclass
      AND attname = 'canonical_payload_jcs' AND NOT attisdropped
  ) THEN
    IF to_regclass('public.memory_versions_one_current_per_slot_uq') IS NOT NULL THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0003_SUCCESSOR_INDEX_PRESENT';
    END IF;
  ELSIF to_regclass('public.memory_versions_one_current_per_slot_uq') IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0003_LEGACY_INDEX_MISSING';
  END IF;
END
$migration_assert$;

COMMIT;
