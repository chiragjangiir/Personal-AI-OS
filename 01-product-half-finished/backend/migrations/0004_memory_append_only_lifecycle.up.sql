BEGIN;

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS canonical_payload_jcs TEXT,
  ADD COLUMN IF NOT EXISTS canonical_payload JSONB,
  ADD COLUMN IF NOT EXISTS canonical_receipt_projection JSONB,
  ADD COLUMN IF NOT EXISTS canonical_receipt_projection_jcs TEXT,
  ADD COLUMN IF NOT EXISTS canonical_receipt_projection_sha256 TEXT;

ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS canonical_payload_jcs TEXT,
  ADD COLUMN IF NOT EXISTS canonical_payload JSONB,
  ADD COLUMN IF NOT EXISTS canonical_receipt_projection JSONB,
  ADD COLUMN IF NOT EXISTS canonical_receipt_projection_jcs TEXT,
  ADD COLUMN IF NOT EXISTS canonical_receipt_projection_sha256 TEXT;

DO $canonical_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.memory_candidates'::regclass
      AND conname = 'memory_candidates_canonical_bundle_ck'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_canonical_bundle_ck CHECK (
        (canonical_payload_jcs IS NULL
          AND canonical_payload IS NULL
          AND canonical_receipt_projection IS NULL
          AND canonical_receipt_projection_jcs IS NULL
          AND canonical_receipt_projection_sha256 IS NULL)
        OR
        (canonical_payload_jcs IS NOT NULL
          AND canonical_payload IS NOT NULL
          AND canonical_receipt_projection IS NOT NULL
          AND canonical_receipt_projection_jcs IS NOT NULL
          AND canonical_receipt_projection_sha256 ~ '^[0-9a-f]{64}$')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.memory_versions'::regclass
      AND conname = 'memory_versions_canonical_bundle_ck'
  ) THEN
    ALTER TABLE memory_versions
      ADD CONSTRAINT memory_versions_canonical_bundle_ck CHECK (
        (canonical_payload_jcs IS NULL
          AND canonical_payload IS NULL
          AND canonical_receipt_projection IS NULL
          AND canonical_receipt_projection_jcs IS NULL
          AND canonical_receipt_projection_sha256 IS NULL)
        OR
        (canonical_payload_jcs IS NOT NULL
          AND canonical_payload IS NOT NULL
          AND canonical_receipt_projection IS NOT NULL
          AND canonical_receipt_projection_jcs IS NOT NULL
          AND canonical_receipt_projection_sha256 ~ '^[0-9a-f]{64}$')
      );
  END IF;
END
$canonical_constraints$;

CREATE TABLE IF NOT EXISTS memory_candidate_heads (
  candidate_ref_id UUID NOT NULL,
  candidate_object_version TEXT NOT NULL,
  candidate_payload_sha256 TEXT NOT NULL,
  authority_watermark JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_candidate_heads_pkey PRIMARY KEY (candidate_ref_id),
  CONSTRAINT memory_candidate_heads_version_ck CHECK (candidate_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_candidate_heads_hash_ck CHECK (candidate_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_candidate_heads_candidate_fk FOREIGN KEY (
    candidate_ref_id, candidate_object_version, candidate_payload_sha256
  ) REFERENCES memory_candidates (
    candidate_ref_id, candidate_object_version, candidate_payload_sha256
  )
);

CREATE TABLE IF NOT EXISTS memory_slot_heads (
  user_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  memory_ref_type TEXT NOT NULL,
  memory_ref_id UUID NOT NULL,
  memory_object_version TEXT NOT NULL,
  memory_payload_sha256 TEXT NOT NULL,
  authority_watermark JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_slot_heads_pkey PRIMARY KEY (user_id, slot),
  CONSTRAINT memory_slot_heads_version_ck CHECK (memory_object_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT memory_slot_heads_hash_ck CHECK (memory_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT memory_slot_heads_memory_fk FOREIGN KEY (
    memory_ref_id, memory_object_version, memory_payload_sha256
  ) REFERENCES memory_versions (
    memory_ref_id, memory_object_version, memory_payload_sha256
  )
);

INSERT INTO memory_candidate_heads (
  candidate_ref_id, candidate_object_version, candidate_payload_sha256, authority_watermark
)
SELECT DISTINCT ON (c.candidate_ref_id)
  c.candidate_ref_id,
  c.candidate_object_version,
  c.candidate_payload_sha256,
  jsonb_build_object('authority_seq', clock.watermark)
FROM memory_candidates AS c
CROSS JOIN memory_authority_clock AS clock
WHERE clock.clock_id = TRUE AND c.canonical_payload_jcs IS NOT NULL
ORDER BY c.candidate_ref_id, length(c.candidate_object_version) DESC, c.candidate_object_version DESC
ON CONFLICT (candidate_ref_id) DO UPDATE SET
  candidate_object_version = EXCLUDED.candidate_object_version,
  candidate_payload_sha256 = EXCLUDED.candidate_payload_sha256,
  authority_watermark = EXCLUDED.authority_watermark,
  updated_at = now();

INSERT INTO memory_slot_heads (
  user_id, slot, memory_ref_type, memory_ref_id, memory_object_version,
  memory_payload_sha256, authority_watermark
)
SELECT DISTINCT ON (v.user_id, v.slot)
  v.user_id,
  v.slot,
  v.memory_ref_type,
  v.memory_ref_id,
  v.memory_object_version,
  v.memory_payload_sha256,
  jsonb_build_object('authority_seq', clock.watermark)
FROM memory_versions AS v
CROSS JOIN memory_authority_clock AS clock
WHERE clock.clock_id = TRUE AND v.canonical_payload_jcs IS NOT NULL
ORDER BY v.user_id, v.slot, length(v.memory_object_version) DESC, v.memory_object_version DESC
ON CONFLICT (user_id, slot) DO UPDATE SET
  memory_ref_type = EXCLUDED.memory_ref_type,
  memory_ref_id = EXCLUDED.memory_ref_id,
  memory_object_version = EXCLUDED.memory_object_version,
  memory_payload_sha256 = EXCLUDED.memory_payload_sha256,
  authority_watermark = EXCLUDED.authority_watermark,
  updated_at = now();

DO $head_validation$
BEGIN
  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (candidate_ref_id)
        candidate_ref_id, candidate_object_version, candidate_payload_sha256
      FROM memory_candidates
      WHERE canonical_payload_jcs IS NOT NULL
      ORDER BY candidate_ref_id, length(candidate_object_version) DESC, candidate_object_version DESC
    )
    SELECT 1 FROM latest
    LEFT JOIN memory_candidate_heads AS h
      ON h.candidate_ref_id = latest.candidate_ref_id
      AND h.candidate_object_version = latest.candidate_object_version
      AND h.candidate_payload_sha256 = latest.candidate_payload_sha256
    WHERE h.candidate_ref_id IS NULL
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_CANDIDATE_HEAD_VALIDATION_FAILED';
  END IF;

  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (user_id, slot)
        user_id, slot, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256
      FROM memory_versions
      WHERE canonical_payload_jcs IS NOT NULL
      ORDER BY user_id, slot, length(memory_object_version) DESC, memory_object_version DESC
    )
    SELECT 1 FROM latest
    LEFT JOIN memory_slot_heads AS h
      ON h.user_id = latest.user_id
      AND h.slot = latest.slot
      AND h.memory_ref_type = latest.memory_ref_type
      AND h.memory_ref_id = latest.memory_ref_id
      AND h.memory_object_version = latest.memory_object_version
      AND h.memory_payload_sha256 = latest.memory_payload_sha256
    WHERE h.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_SLOT_HEAD_VALIDATION_FAILED';
  END IF;
END
$head_validation$;

DO $legacy_index_validation$
DECLARE
  index_columns TEXT[];
  index_predicate TEXT;
  index_is_unique BOOLEAN;
BEGIN
  IF to_regclass('public.memory_versions_one_current_per_slot_uq') IS NOT NULL THEN
    SELECT
      ix.indisunique,
      pg_catalog.pg_get_expr(ix.indpred, ix.indrelid),
      array_agg(a.attname ORDER BY keys.ordinality)
    INTO index_is_unique, index_predicate, index_columns
    FROM pg_catalog.pg_index AS ix
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS keys(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = ix.indrelid AND a.attnum = keys.attnum
    WHERE ix.indexrelid = 'public.memory_versions_one_current_per_slot_uq'::regclass
    GROUP BY ix.indisunique, ix.indpred, ix.indrelid;
    IF index_is_unique IS DISTINCT FROM TRUE
      OR index_columns IS DISTINCT FROM ARRAY['user_id', 'slot']
      OR index_predicate IS NULL
      OR position('current' IN lower(index_predicate)) = 0 THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0004_LEGACY_INDEX_SHAPE_MISMATCH';
    END IF;
  END IF;
END
$legacy_index_validation$;

DROP INDEX IF EXISTS memory_versions_one_current_per_slot_uq;

CREATE OR REPLACE FUNCTION memory_append_only_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $memory_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.canonical_payload_jcs IS NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'canonical memory rows are immutable';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.canonical_payload_jcs IS NULL AND NEW.canonical_payload_jcs IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'canonical memory rows are immutable';
  END IF;

  RAISE EXCEPTION 'canonical memory rows are immutable';
END
$memory_guard$;

DO $trigger_install$
DECLARE
  trigger_function OID := 'public.memory_append_only_immutable_guard()'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.memory_candidates'::regclass
      AND tgname = 'memory_candidates_append_only_guard'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER memory_candidates_append_only_guard '
      || 'BEFORE UPDATE OR DELETE ON memory_candidates FOR EACH ROW '
      || 'EXECUTE FUNCTION memory_append_only_immutable_guard()';
  ELSIF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.memory_candidates'::regclass
      AND tgname = 'memory_candidates_append_only_guard'
      AND NOT tgisinternal AND tgfoid <> trigger_function
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_CANDIDATE_TRIGGER_SHAPE_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.memory_versions'::regclass
      AND tgname = 'memory_versions_append_only_guard'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER memory_versions_append_only_guard '
      || 'BEFORE UPDATE OR DELETE ON memory_versions FOR EACH ROW '
      || 'EXECUTE FUNCTION memory_append_only_immutable_guard()';
  ELSIF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.memory_versions'::regclass
      AND tgname = 'memory_versions_append_only_guard'
      AND NOT tgisinternal AND tgfoid <> trigger_function
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_VERSION_TRIGGER_SHAPE_MISMATCH';
  END IF;
END
$trigger_install$;

DO $migration_assert$
DECLARE
  actual_tables TEXT[];
  expected_tables TEXT[] := ARRAY[
    'device_leases','idempotency_ledger','memory_authority_clock','memory_candidate_heads',
    'memory_candidates','memory_deletion_mutations','memory_derived_projections','memory_dream_deltas',
    'memory_rebuild_runs','memory_slot_heads','memory_versions','outbox_consumer_dedupe',
    'outbox_events','realtime_external_effects','realtime_handoff_facts','realtime_sessions',
    'realtime_terminal_facts','realtime_transport_aliases'
  ];
  actual_columns TEXT[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO actual_tables
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = FALSE;
  IF actual_tables IS DISTINCT FROM expected_tables THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_EXACT_18_TABLE_SET_MISMATCH';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.memory_candidate_heads'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'candidate_ref_id','candidate_object_version','candidate_payload_sha256',
    'authority_watermark','updated_at'
  ] THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_CANDIDATE_HEAD_SHAPE_MISMATCH';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.memory_slot_heads'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'user_id','slot','memory_ref_type','memory_ref_id','memory_object_version',
    'memory_payload_sha256','authority_watermark','updated_at'
  ] THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_SLOT_HEAD_SHAPE_MISMATCH';
  END IF;

  IF to_regclass('public.memory_versions_one_current_per_slot_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_LEGACY_INDEX_STILL_PRESENT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname IN ('memory_candidates_canonical_bundle_ck','memory_versions_canonical_bundle_ck')
      AND connamespace = 'public'::regnamespace
    GROUP BY connamespace HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0004_CANONICAL_CONSTRAINT_SET_MISMATCH';
  END IF;
END
$migration_assert$;

COMMIT;
