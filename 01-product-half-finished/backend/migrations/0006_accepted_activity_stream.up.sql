BEGIN;

LOCK TABLE public.outbox_events IN SHARE ROW EXCLUSIVE MODE;

DO $accepted_activity_catalog_preflight$
DECLARE
  column_exists BOOLEAN;
  column_attnum INTEGER;
  column_type OID;
  column_not_null BOOLEAN;
  sequence_oid OID;
  sequence_relkind "char";
  sequence_type OID;
  sequence_start NUMERIC;
  sequence_increment NUMERIC;
  sequence_min NUMERIC;
  sequence_max NUMERIC;
  sequence_cache NUMERIC;
  sequence_cycle BOOLEAN;
  index_oid OID;
  index_relkind "char";
  index_table OID;
  index_am TEXT;
  index_unique BOOLEAN;
  index_valid BOOLEAN;
  index_ready BOOLEAN;
  index_live BOOLEAN;
  index_predicate TEXT;
  index_columns TEXT[];
  existing_constraint RECORD;
  constraint_def TEXT;
  existing_function RECORD;
  function_source TEXT;
  existing_trigger RECORD;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = 'public.outbox_events'::regclass
       AND a.attname = 'accepted_activity_cursor'
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) INTO column_exists;
  IF column_exists THEN
    SELECT a.attnum, a.atttypid, a.attnotnull
      INTO column_attnum, column_type, column_not_null
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = 'public.outbox_events'::regclass
       AND a.attname = 'accepted_activity_cursor'
       AND a.attnum > 0
       AND NOT a.attisdropped;
    IF column_attnum IS NULL
      OR column_type IS DISTINCT FROM 'int8'::regtype
      OR column_not_null IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_COLUMN_SHAPE_MISMATCH';
    END IF;
  END IF;

  SELECT c.oid, c.relkind, s.seqtypid, s.seqstart, s.seqincrement,
         s.seqmin, s.seqmax, s.seqcache, s.seqcycle
    INTO sequence_oid, sequence_relkind, sequence_type, sequence_start,
         sequence_increment, sequence_min, sequence_max, sequence_cache,
         sequence_cycle
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_sequence AS s ON s.seqrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relname = 'outbox_events_accepted_activity_cursor_seq';
  IF sequence_oid IS NOT NULL THEN
    IF sequence_relkind IS DISTINCT FROM 'S'
      OR sequence_type IS DISTINCT FROM 'int8'::regtype
      OR sequence_start IS DISTINCT FROM 1::numeric
      OR sequence_increment IS DISTINCT FROM 1::numeric
      OR sequence_min IS DISTINCT FROM 1::numeric
      OR sequence_max IS DISTINCT FROM 9223372036854775807::numeric
      OR sequence_cache IS DISTINCT FROM 1::numeric
      OR sequence_cycle IS DISTINCT FROM FALSE
      OR (
        column_exists
        AND to_regclass(pg_get_serial_sequence(
          'public.outbox_events', 'accepted_activity_cursor'
        )) IS DISTINCT FROM sequence_oid
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_SEQUENCE_SHAPE_MISMATCH';
    END IF;
  END IF;

  SELECT c.oid, c.relkind, i.indrelid, am.amname, i.indisunique,
         i.indisvalid, i.indisready, i.indislive,
         pg_get_expr(i.indpred, i.indrelid)
    INTO index_oid, index_relkind, index_table, index_am, index_unique,
         index_valid, index_ready, index_live, index_predicate
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.oid
    LEFT JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
   WHERE n.nspname = 'public'
     AND c.relname = 'outbox_events_accepted_activity_cursor_uq';
  IF index_oid IS NOT NULL THEN
    SELECT array_agg(a.attname ORDER BY k.ordinality)
      INTO index_columns
      FROM pg_catalog.pg_index AS i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      LEFT JOIN pg_catalog.pg_attribute AS a
        ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indexrelid = index_oid;
    IF index_relkind IS DISTINCT FROM 'i'
      OR index_table IS DISTINCT FROM 'public.outbox_events'::regclass
      OR index_am IS DISTINCT FROM 'btree'
      OR index_unique IS DISTINCT FROM TRUE
      OR index_valid IS DISTINCT FROM TRUE
      OR index_ready IS DISTINCT FROM TRUE
      OR index_live IS DISTINCT FROM TRUE
      OR index_columns IS DISTINCT FROM ARRAY['accepted_activity_cursor']::text[]
      OR regexp_replace(lower(COALESCE(index_predicate, '')), '[[:space:]()]', '', 'g')
         IS DISTINCT FROM 'accepted_activity_cursorisnotnull' THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CURSOR_INDEX_SHAPE_MISMATCH';
    END IF;
  END IF;

  SELECT c.oid, c.relkind, i.indrelid, am.amname, i.indisunique,
         i.indisvalid, i.indisready, i.indislive,
         pg_get_expr(i.indpred, i.indrelid)
    INTO index_oid, index_relkind, index_table, index_am, index_unique,
         index_valid, index_ready, index_live, index_predicate
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.oid
    LEFT JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
   WHERE n.nspname = 'public'
     AND c.relname = 'outbox_events_accepted_activity_read_after_idx';
  IF index_oid IS NOT NULL THEN
    SELECT array_agg(a.attname ORDER BY k.ordinality)
      INTO index_columns
      FROM pg_catalog.pg_index AS i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      LEFT JOIN pg_catalog.pg_attribute AS a
        ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indexrelid = index_oid;
    IF index_relkind IS DISTINCT FROM 'i'
      OR index_table IS DISTINCT FROM 'public.outbox_events'::regclass
      OR index_am IS DISTINCT FROM 'btree'
      OR index_unique IS DISTINCT FROM FALSE
      OR index_valid IS DISTINCT FROM TRUE
      OR index_ready IS DISTINCT FROM TRUE
      OR index_live IS DISTINCT FROM TRUE
      OR index_columns IS DISTINCT FROM ARRAY['accepted_activity_cursor', 'event_id']::text[]
      OR regexp_replace(lower(COALESCE(index_predicate, '')), '[[:space:]()]', '', 'g')
         IS DISTINCT FROM 'accepted_activity_cursorisnotnull' THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_READ_INDEX_SHAPE_MISMATCH';
    END IF;
  END IF;

  SELECT c.oid, c.relkind, i.indrelid, am.amname, i.indisunique,
         i.indisvalid, i.indisready, i.indislive,
         pg_get_expr(i.indpred, i.indrelid)
    INTO index_oid, index_relkind, index_table, index_am, index_unique,
         index_valid, index_ready, index_live, index_predicate
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.oid
    LEFT JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
   WHERE n.nspname = 'public'
     AND c.relname = 'outbox_events_accepted_activity_aggregate_read_after_idx';
  IF index_oid IS NOT NULL THEN
    SELECT array_agg(a.attname ORDER BY k.ordinality)
      INTO index_columns
      FROM pg_catalog.pg_index AS i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      LEFT JOIN pg_catalog.pg_attribute AS a
        ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indexrelid = index_oid;
    IF index_relkind IS DISTINCT FROM 'i'
      OR index_table IS DISTINCT FROM 'public.outbox_events'::regclass
      OR index_am IS DISTINCT FROM 'btree'
      OR index_unique IS DISTINCT FROM FALSE
      OR index_valid IS DISTINCT FROM TRUE
      OR index_ready IS DISTINCT FROM TRUE
      OR index_live IS DISTINCT FROM TRUE
      OR index_columns IS DISTINCT FROM ARRAY['aggregate_id', 'accepted_activity_cursor', 'event_id']::text[]
      OR regexp_replace(lower(COALESCE(index_predicate, '')), '[[:space:]()]', '', 'g')
         IS DISTINCT FROM 'accepted_activity_cursorisnotnull' THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_AGGREGATE_INDEX_SHAPE_MISMATCH';
    END IF;
  END IF;

  FOR existing_constraint IN
    SELECT c.conname, c.conrelid, c.contype, c.convalidated,
           pg_get_constraintdef(c.oid, TRUE) AS definition
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.connamespace
     WHERE n.nspname = 'public'
       AND c.conname IN (
         'outbox_events_accepted_activity_cursor_ck',
         'outbox_events_accepted_activity_profile_ck',
         'outbox_events_accepted_activity_canonical_hashes_ck'
       )
  LOOP
    IF existing_constraint.conrelid IS DISTINCT FROM 'public.outbox_events'::regclass
      OR existing_constraint.contype IS DISTINCT FROM 'c'
      OR existing_constraint.convalidated IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CONSTRAINT_SHAPE_MISMATCH:%',
        existing_constraint.conname;
    END IF;
    constraint_def := lower(existing_constraint.definition);
    IF position('select' IN constraint_def) > 0
      OR position('jsonb_object_keys' IN constraint_def) > 0 THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_CHECK_SUBQUERY_SHAPE_MISMATCH:%',
        existing_constraint.conname;
    END IF;
    IF existing_constraint.conname = 'outbox_events_accepted_activity_cursor_ck'
      AND (
        position('realtime.continuity.renewed' IN constraint_def) = 0
        OR position('accepted_activity_cursor' IN constraint_def) = 0
        OR position('> 0' IN constraint_def) = 0
        OR position('is null' IN constraint_def) = 0
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CURSOR_CONSTRAINT_SHAPE_MISMATCH';
    ELSIF existing_constraint.conname = 'outbox_events_accepted_activity_profile_ck'
      AND (
        position('aggregate_type' IN constraint_def) = 0
        OR position('event_version' IN constraint_def) = 0
        OR position('idempotency_scope' IN constraint_def) = 0
        OR position('?&' IN constraint_def) = 0
        OR position('- array' IN constraint_def) = 0
        OR position('activityid' IN constraint_def) = 0
        OR position('continuityid' IN constraint_def) = 0
        OR position('acceptanceref' IN constraint_def) = 0
        OR position('authoritywatermark' IN constraint_def) = 0
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_PROFILE_CONSTRAINT_SHAPE_MISMATCH';
    ELSIF existing_constraint.conname = 'outbox_events_accepted_activity_canonical_hashes_ck'
      AND (
        position('payload_sha256' IN constraint_def) = 0
        OR position('canonical_payload_sha256' IN constraint_def) = 0
        OR position('aggregate_ref' IN constraint_def) = 0
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_HASH_CONSTRAINT_SHAPE_MISMATCH';
    END IF;
  END LOOP;

  FOR existing_function IN
    SELECT p.proname, p.pronargs, p.prokind, p.prorettype, l.lanname, p.prosrc
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'outbox_events_accepted_activity_cursor_allocate',
         'outbox_events_accepted_activity_immutable_guard',
         'outbox_events_accepted_activity_notify'
       )
  LOOP
    function_source := lower(existing_function.prosrc);
    IF existing_function.proname = 'outbox_events_accepted_activity_cursor_allocate' THEN
      IF existing_function.pronargs IS DISTINCT FROM 0
        OR existing_function.prokind IS DISTINCT FROM 'f'
        OR existing_function.prorettype IS DISTINCT FROM 'trigger'::regtype
        OR existing_function.lanname IS DISTINCT FROM 'plpgsql'
        OR position('pg_advisory_xact_lock' IN function_source) = 0
        OR position('nextval' IN function_source) = 0
        OR position('realtime.continuity.renewed' IN function_source) = 0
        OR position('accepted_activity_cursor' IN function_source) = 0 THEN
        RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CURSOR_FUNCTION_SHAPE_MISMATCH';
      END IF;
    ELSIF existing_function.proname = 'outbox_events_accepted_activity_immutable_guard' THEN
      IF existing_function.pronargs IS DISTINCT FROM 0
        OR existing_function.prokind IS DISTINCT FROM 'f'
        OR existing_function.prorettype IS DISTINCT FROM 'trigger'::regtype
        OR existing_function.lanname IS DISTINCT FROM 'plpgsql'
        OR position('old.event_id' IN function_source) = 0
        OR position('old.payload' IN function_source) = 0
        OR position('old.created_at' IN function_source) = 0
        OR position('old.accepted_activity_cursor' IN function_source) = 0
        OR position('delete' IN function_source) = 0
        OR position('immutable' IN function_source) = 0 THEN
        RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_GUARD_FUNCTION_SHAPE_MISMATCH';
      END IF;
    ELSE
      IF existing_function.pronargs IS DISTINCT FROM 0
        OR existing_function.prokind IS DISTINCT FROM 'f'
        OR existing_function.prorettype IS DISTINCT FROM 'trigger'::regtype
        OR existing_function.lanname IS DISTINCT FROM 'plpgsql'
        OR position('pg_notify' IN function_source) = 0
        OR position('paios_accepted_activity_v1' IN function_source) = 0
        OR position('cursor' IN function_source) = 0
        OR position('event_id' IN function_source) = 0
        OR position('payload' IN function_source) > 0 THEN
        RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_NOTIFY_FUNCTION_SHAPE_MISMATCH';
      END IF;
    END IF;
  END LOOP;

  FOR existing_trigger IN
    SELECT t.tgname, t.tgtype, t.tgenabled, t.tgisinternal, t.tgfoid,
           pg_get_triggerdef(t.oid, TRUE) AS definition
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname IN (
         'outbox_events_accepted_activity_cursor_allocator',
         'outbox_events_accepted_activity_immutable_guard',
         'outbox_events_accepted_activity_notify'
       )
  LOOP
    IF existing_trigger.tgisinternal IS DISTINCT FROM FALSE
      OR existing_trigger.tgenabled IS DISTINCT FROM 'O' THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_TRIGGER_SHAPE_MISMATCH:%',
        existing_trigger.tgname;
    ELSIF existing_trigger.tgname = 'outbox_events_accepted_activity_cursor_allocator'
      AND (
        existing_trigger.tgtype IS DISTINCT FROM 7
        OR existing_trigger.tgfoid IS DISTINCT FROM to_regprocedure(
          'public.outbox_events_accepted_activity_cursor_allocate()'
        )
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CURSOR_TRIGGER_SHAPE_MISMATCH';
    ELSIF existing_trigger.tgname = 'outbox_events_accepted_activity_immutable_guard'
      AND (
        existing_trigger.tgtype IS DISTINCT FROM 27
        OR existing_trigger.tgfoid IS DISTINCT FROM to_regprocedure(
          'public.outbox_events_accepted_activity_immutable_guard()'
        )
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_GUARD_TRIGGER_SHAPE_MISMATCH';
    ELSIF existing_trigger.tgname = 'outbox_events_accepted_activity_notify'
      AND (
        existing_trigger.tgtype IS DISTINCT FROM 5
        OR existing_trigger.tgfoid IS DISTINCT FROM to_regprocedure(
          'public.outbox_events_accepted_activity_notify()'
        )
      ) THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_NOTIFY_TRIGGER_SHAPE_MISMATCH';
    END IF;
  END LOOP;
END
$accepted_activity_catalog_preflight$;

DO $accepted_activity_column_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = 'public.outbox_events'::regclass
       AND a.attname = 'accepted_activity_cursor'
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.outbox_events
      ADD COLUMN accepted_activity_cursor BIGINT;
  END IF;
END
$accepted_activity_column_install$;

DO $accepted_activity_sequence_install$
BEGIN
  IF to_regclass('public.outbox_events_accepted_activity_cursor_seq') IS NULL THEN
    CREATE SEQUENCE public.outbox_events_accepted_activity_cursor_seq
      AS BIGINT
      START WITH 1
      INCREMENT BY 1
      MINVALUE 1
      NO MAXVALUE
      CACHE 1;
  END IF;
  IF pg_get_serial_sequence(
    'public.outbox_events', 'accepted_activity_cursor'
  ) IS NULL THEN
    ALTER SEQUENCE public.outbox_events_accepted_activity_cursor_seq
      OWNED BY public.outbox_events.accepted_activity_cursor;
  END IF;
END
$accepted_activity_sequence_install$;

DO $accepted_activity_backfill$
DECLARE
  existing_row RECORD;
  current_cursor BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('paios.outbox_events.accepted_activity_cursor', 0)
  );

  IF EXISTS (
    SELECT 1
      FROM public.outbox_events AS event
     WHERE event.event_type = 'realtime.continuity.renewed'
       AND NOT EXISTS (
         SELECT 1
          FROM public.idempotency_ledger AS ledger
         WHERE ledger.scope = 'activity_renewal'
            AND ledger.idempotency_key = event.payload->>'activityId'
            AND ledger.idempotency_key = event.idempotency_key
            AND ledger.status = 'committed'
       )
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACTIVITY_RENEWAL_LEDGER_PARTNER_MISSING';
  END IF;

  SELECT MAX(accepted_activity_cursor)
    INTO current_cursor
    FROM public.outbox_events;

  IF current_cursor IS NULL THEN
    PERFORM setval(
      'public.outbox_events_accepted_activity_cursor_seq'::regclass,
      1,
      FALSE
    );
  ELSE
    IF current_cursor < 1 THEN
      RAISE EXCEPTION 'PAIOS_MIGRATION_0006_INVALID_EXISTING_ACTIVITY_CURSOR';
    END IF;
    PERFORM setval(
      'public.outbox_events_accepted_activity_cursor_seq'::regclass,
      current_cursor,
      TRUE
    );
  END IF;

  FOR existing_row IN
    SELECT event_id
      FROM public.outbox_events
     WHERE event_type = 'realtime.continuity.renewed'
       AND accepted_activity_cursor IS NULL
     ORDER BY created_at, event_id
  LOOP
    UPDATE public.outbox_events
       SET accepted_activity_cursor = nextval(
         'public.outbox_events_accepted_activity_cursor_seq'::regclass
       )
     WHERE event_id = existing_row.event_id;
  END LOOP;
END
$accepted_activity_backfill$;

DO $accepted_activity_cursor_constraint_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.outbox_events'::regclass
       AND c.conname = 'outbox_events_accepted_activity_cursor_ck'
  ) THEN
    ALTER TABLE public.outbox_events
      ADD CONSTRAINT outbox_events_accepted_activity_cursor_ck CHECK (
        (
          event_type = 'realtime.continuity.renewed'
          AND accepted_activity_cursor IS NOT NULL
          AND accepted_activity_cursor > 0
        )
        OR (
          event_type <> 'realtime.continuity.renewed'
          AND accepted_activity_cursor IS NULL
        )
      );
  END IF;
END
$accepted_activity_cursor_constraint_install$;

DO $accepted_activity_profile_constraint_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.outbox_events'::regclass
       AND c.conname = 'outbox_events_accepted_activity_profile_ck'
  ) THEN
    ALTER TABLE public.outbox_events
      ADD CONSTRAINT outbox_events_accepted_activity_profile_ck CHECK (
        event_type <> 'realtime.continuity.renewed'
        OR (
          aggregate_type = 'realtime'
          AND event_version = 1
          AND idempotency_scope = 'realtime.outbox'
          AND CASE
            WHEN jsonb_typeof(aggregate_ref) = 'object' THEN
              aggregate_ref ?& ARRAY[
                'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
              ]
              AND (aggregate_ref - ARRAY[
                'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
              ]::text[]) = '{}'::jsonb
              AND aggregate_ref->>'ref_type' IS NOT NULL
              AND aggregate_ref->>'ref_type' = 'RealtimeSession'
              AND aggregate_ref->>'ref_id' IS NOT NULL
              AND aggregate_ref->>'ref_id' = aggregate_id::text
              AND aggregate_ref->>'object_version' IS NOT NULL
              AND aggregate_ref->>'object_version' ~ '^[1-9][0-9]*$'
              AND aggregate_ref->>'canonical_payload_sha256' IS NOT NULL
              AND aggregate_ref->>'canonical_payload_sha256' ~ '^[0-9a-f]{64}$'
            ELSE FALSE
          END
          AND CASE
            WHEN jsonb_typeof(payload) = 'object' THEN
              payload ?& ARRAY[
                'activityId', 'continuityId', 'acceptanceRef', 'authorityWatermark'
              ]
              AND (payload - ARRAY[
                'activityId', 'continuityId', 'acceptanceRef', 'authorityWatermark'
              ]::text[]) = '{}'::jsonb
              AND payload->>'activityId' IS NOT NULL
              AND payload->>'activityId' = idempotency_key
              AND payload->>'activityId' ~ '^[^[:space:]]+$'
              AND char_length(payload->>'activityId') BETWEEN 1 AND 256
              AND payload->>'continuityId' IS NOT NULL
              AND payload->>'continuityId' ~ '^[^[:space:]]+$'
              AND char_length(payload->>'continuityId') BETWEEN 1 AND 256
              AND jsonb_typeof(payload->'acceptanceRef') IN ('string', 'object')
              AND jsonb_typeof(payload->'authorityWatermark') IN ('string', 'object')
            ELSE FALSE
          END
        )
      );
  END IF;
END
$accepted_activity_profile_constraint_install$;

DO $accepted_activity_hash_constraint_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.outbox_events'::regclass
       AND c.conname = 'outbox_events_accepted_activity_canonical_hashes_ck'
  ) THEN
    ALTER TABLE public.outbox_events
      ADD CONSTRAINT outbox_events_accepted_activity_canonical_hashes_ck CHECK (
        event_type <> 'realtime.continuity.renewed'
        OR (
          payload_sha256 IS NOT NULL
          AND payload_sha256 ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(aggregate_ref) = 'object'
          AND aggregate_ref->>'canonical_payload_sha256' IS NOT NULL
          AND aggregate_ref->>'canonical_payload_sha256' ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END
$accepted_activity_hash_constraint_install$;

DO $accepted_activity_index_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'outbox_events_accepted_activity_cursor_uq'
  ) THEN
    CREATE UNIQUE INDEX outbox_events_accepted_activity_cursor_uq
      ON public.outbox_events (accepted_activity_cursor)
      WHERE accepted_activity_cursor IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'outbox_events_accepted_activity_read_after_idx'
  ) THEN
    CREATE INDEX outbox_events_accepted_activity_read_after_idx
      ON public.outbox_events (accepted_activity_cursor, event_id)
      WHERE accepted_activity_cursor IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'outbox_events_accepted_activity_aggregate_read_after_idx'
  ) THEN
    CREATE INDEX outbox_events_accepted_activity_aggregate_read_after_idx
      ON public.outbox_events (aggregate_id, accepted_activity_cursor, event_id)
      WHERE accepted_activity_cursor IS NOT NULL;
  END IF;
END
$accepted_activity_index_install$;

CREATE OR REPLACE FUNCTION public.outbox_events_accepted_activity_cursor_allocate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $accepted_activity_cursor_allocator$
BEGIN
  IF NEW.event_type = 'realtime.continuity.renewed' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('paios.outbox_events.accepted_activity_cursor', 0)
    );
    IF NEW.accepted_activity_cursor IS NOT NULL THEN
      RAISE EXCEPTION 'PAIOS_ACCEPTED_ACTIVITY_CURSOR_MUST_BE_DATABASE_ALLOCATED';
    END IF;
    NEW.accepted_activity_cursor := nextval(
      'public.outbox_events_accepted_activity_cursor_seq'::regclass
    );
  ELSIF NEW.accepted_activity_cursor IS NOT NULL THEN
    RAISE EXCEPTION 'PAIOS_ACCEPTED_ACTIVITY_CURSOR_FORBIDDEN_FOR_NON_ACCEPTED_ROW';
  END IF;
  RETURN NEW;
END
$accepted_activity_cursor_allocator$;

CREATE OR REPLACE FUNCTION public.outbox_events_accepted_activity_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $accepted_activity_immutable_guard$
DECLARE
  old_is_accepted BOOLEAN;
  new_is_accepted BOOLEAN;
BEGIN
  old_is_accepted := OLD.event_type = 'realtime.continuity.renewed';
  IF TG_OP = 'DELETE' THEN
    IF old_is_accepted THEN
      RAISE EXCEPTION 'PAIOS_ACCEPTED_ACTIVITY_ROWS_ARE_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  new_is_accepted := NEW.event_type = 'realtime.continuity.renewed';
  IF TG_OP = 'UPDATE' AND (old_is_accepted OR new_is_accepted) THEN
    IF OLD.event_id IS DISTINCT FROM NEW.event_id
      OR OLD.aggregate_type IS DISTINCT FROM NEW.aggregate_type
      OR OLD.aggregate_id IS DISTINCT FROM NEW.aggregate_id
      OR OLD.aggregate_ref IS DISTINCT FROM NEW.aggregate_ref
      OR OLD.event_type IS DISTINCT FROM NEW.event_type
      OR OLD.event_version IS DISTINCT FROM NEW.event_version
      OR OLD.idempotency_scope IS DISTINCT FROM NEW.idempotency_scope
      OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
      OR OLD.payload IS DISTINCT FROM NEW.payload
      OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
      OR OLD.accepted_activity_cursor IS DISTINCT FROM NEW.accepted_activity_cursor
      OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'PAIOS_ACCEPTED_ACTIVITY_AUTHORITY_FIELDS_ARE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PAIOS_ACCEPTED_ACTIVITY_IMMUTABLE_GUARD_UNEXPECTED_OPERATION';
END
$accepted_activity_immutable_guard$;

CREATE OR REPLACE FUNCTION public.outbox_events_accepted_activity_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $accepted_activity_notify$
BEGIN
  IF NEW.event_type = 'realtime.continuity.renewed' THEN
    PERFORM pg_notify(
      'paios_accepted_activity_v1',
      jsonb_build_object(
        'cursor', NEW.accepted_activity_cursor::text,
        'event_id', NEW.event_id::text
      )::text
    );
  END IF;
  RETURN NEW;
END
$accepted_activity_notify$;

DO $accepted_activity_trigger_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname = 'outbox_events_accepted_activity_cursor_allocator'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER outbox_events_accepted_activity_cursor_allocator
    BEFORE INSERT ON public.outbox_events
    FOR EACH ROW
    EXECUTE FUNCTION public.outbox_events_accepted_activity_cursor_allocate();
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname = 'outbox_events_accepted_activity_immutable_guard'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER outbox_events_accepted_activity_immutable_guard
    BEFORE UPDATE OR DELETE ON public.outbox_events
    FOR EACH ROW
    EXECUTE FUNCTION public.outbox_events_accepted_activity_immutable_guard();
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname = 'outbox_events_accepted_activity_notify'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER outbox_events_accepted_activity_notify
    AFTER INSERT ON public.outbox_events
    FOR EACH ROW
    EXECUTE FUNCTION public.outbox_events_accepted_activity_notify();
  END IF;
END
$accepted_activity_trigger_install$;

COMMENT ON COLUMN public.outbox_events.accepted_activity_cursor IS
  'T02-owned positive decimal read-after cursor populated only for realtime.continuity.renewed accepted activity.';
COMMENT ON SEQUENCE public.outbox_events_accepted_activity_cursor_seq IS
  'T02-owned BIGINT allocator for accepted activity cursors; allocation is serialized by a transaction advisory lock.';
COMMENT ON CONSTRAINT outbox_events_accepted_activity_cursor_ck ON public.outbox_events IS
  'The accepted continuity-renewal profile requires a positive cursor and every other outbox row requires NULL.';
COMMENT ON CONSTRAINT outbox_events_accepted_activity_profile_ck ON public.outbox_events IS
  'The accepted stream is exactly realtime.continuity.renewed v1 with the current four-field renewal payload and canonical session reference.';
COMMENT ON CONSTRAINT outbox_events_accepted_activity_canonical_hashes_ck ON public.outbox_events IS
  'Accepted rows retain the outbox payload SHA-256 and canonical aggregate-reference SHA-256.';
COMMENT ON INDEX public.outbox_events_accepted_activity_cursor_uq IS
  'One accepted activity cursor identifies at most one outbox row.';
COMMENT ON INDEX public.outbox_events_accepted_activity_read_after_idx IS
  'Read-after index for the accepted activity cursor stream.';
COMMENT ON INDEX public.outbox_events_accepted_activity_aggregate_read_after_idx IS
  'Aggregate-scoped read-after index for the accepted activity cursor stream.';
COMMENT ON FUNCTION public.outbox_events_accepted_activity_cursor_allocate() IS
  'Allocates accepted activity cursors from the dedicated sequence under a transaction advisory lock and rejects caller-supplied cursors.';
COMMENT ON FUNCTION public.outbox_events_accepted_activity_immutable_guard() IS
  'Prevents accepted activity identity, payload, hash, creation-time, and cursor mutation or deletion while delivery-state updates remain mutable.';
COMMENT ON FUNCTION public.outbox_events_accepted_activity_notify() IS
  'Publishes only cursor and event_id on the paios_accepted_activity_v1 PostgreSQL notification channel after accepted activity insertion.';
COMMENT ON TRIGGER outbox_events_accepted_activity_cursor_allocator ON public.outbox_events IS
  'Database allocator trigger for accepted activity rows.';
COMMENT ON TRIGGER outbox_events_accepted_activity_immutable_guard ON public.outbox_events IS
  'Authority immutability guard for accepted activity rows; delivery-state updates remain allowed.';
COMMENT ON TRIGGER outbox_events_accepted_activity_notify ON public.outbox_events IS
  'After-insert notification containing only the cursor and event_id.';

DO $migration_assert$
DECLARE
  cursor_is_nullable BOOLEAN;
BEGIN
  SELECT NOT a.attnotnull
    INTO cursor_is_nullable
    FROM pg_catalog.pg_attribute AS a
   WHERE a.attrelid = 'public.outbox_events'::regclass
     AND a.attname = 'accepted_activity_cursor'
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF cursor_is_nullable IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CURSOR_NULLABILITY_MISMATCH';
  END IF;

  IF to_regclass('public.outbox_events_accepted_activity_cursor_seq') IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_SEQUENCE_MISSING';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.outbox_events'::regclass
       AND c.conname IN (
         'outbox_events_accepted_activity_cursor_ck',
         'outbox_events_accepted_activity_profile_ck',
         'outbox_events_accepted_activity_canonical_hashes_ck'
       )
  ) <> 3 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CONSTRAINT_SET_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'outbox_events_accepted_activity_cursor_uq'
       AND c.relkind = 'i'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'outbox_events_accepted_activity_read_after_idx'
       AND c.relkind = 'i'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'outbox_events_accepted_activity_aggregate_read_after_idx'
       AND c.relkind = 'i'
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_INDEX_SET_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname = 'outbox_events_accepted_activity_cursor_allocator'
       AND NOT t.tgisinternal
       AND t.tgfoid = 'public.outbox_events_accepted_activity_cursor_allocate()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname = 'outbox_events_accepted_activity_immutable_guard'
       AND NOT t.tgisinternal
       AND t.tgfoid = 'public.outbox_events_accepted_activity_immutable_guard()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.outbox_events'::regclass
       AND t.tgname = 'outbox_events_accepted_activity_notify'
       AND NOT t.tgisinternal
       AND t.tgfoid = 'public.outbox_events_accepted_activity_notify()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_TRIGGER_SET_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.outbox_events
     WHERE (
       event_type = 'realtime.continuity.renewed'
       AND (accepted_activity_cursor IS NULL OR accepted_activity_cursor < 1)
     ) OR (
       event_type <> 'realtime.continuity.renewed'
       AND accepted_activity_cursor IS NOT NULL
     )
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0006_ACCEPTED_ACTIVITY_CURSOR_DATA_MISMATCH';
  END IF;
END
$migration_assert$;

COMMIT;
