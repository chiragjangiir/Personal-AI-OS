BEGIN;

/* 0006 owns this substrate.  0007 only widens its accepted profile. */
LOCK TABLE public.outbox_events IN SHARE ROW EXCLUSIVE MODE;

DO $t04_preflight$
DECLARE
  constraint_count INTEGER;
  function_count INTEGER;
  trigger_count INTEGER;
  cursor_nullable BOOLEAN;
BEGIN
  SELECT NOT a.attnotnull
    INTO cursor_nullable
    FROM pg_catalog.pg_attribute AS a
   WHERE a.attrelid = 'public.outbox_events'::regclass
     AND a.attname = 'accepted_activity_cursor'
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF cursor_nullable IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_CURSOR_PREIMAGE_DRIFT';
  END IF;

  IF to_regclass('public.outbox_events_accepted_activity_cursor_seq') IS NULL
     OR pg_get_serial_sequence('public.outbox_events', 'accepted_activity_cursor')
        IS DISTINCT FROM 'public.outbox_events_accepted_activity_cursor_seq' THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_SEQUENCE_PREIMAGE_DRIFT';
  END IF;

  SELECT count(*) INTO constraint_count
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.outbox_events'::regclass
     AND c.conname IN (
       'outbox_events_accepted_activity_cursor_ck',
       'outbox_events_accepted_activity_profile_ck',
       'outbox_events_accepted_activity_canonical_hashes_ck'
     )
     AND c.contype = 'c'
     AND c.convalidated;
  IF constraint_count <> 3 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_CONSTRAINT_PREIMAGE_DRIFT';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.outbox_events'::regclass
       AND c.conname IN (
         'outbox_events_accepted_activity_cursor_ck',
         'outbox_events_accepted_activity_profile_ck',
         'outbox_events_accepted_activity_canonical_hashes_ck'
       )
       AND pg_get_constraintdef(c.oid, TRUE) ILIKE '%realtime.t04.accepted_user_activity.v1%'
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ALREADY_APPLIED';
  END IF;

  SELECT count(*) INTO function_count
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'outbox_events_accepted_activity_cursor_allocate',
       'outbox_events_accepted_activity_immutable_guard',
       'outbox_events_accepted_activity_notify'
     )
     AND p.prokind = 'f'
     AND p.prorettype = 'trigger'::regtype;
  IF function_count <> 3 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_FUNCTION_PREIMAGE_DRIFT';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'outbox_events_accepted_activity_cursor_allocate',
         'outbox_events_accepted_activity_immutable_guard',
         'outbox_events_accepted_activity_notify'
       )
       AND p.prosrc ILIKE '%realtime.t04.accepted_user_activity.v1%'
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ALREADY_APPLIED';
  END IF;

  SELECT count(*) INTO trigger_count
    FROM pg_catalog.pg_trigger AS t
   WHERE t.tgrelid = 'public.outbox_events'::regclass
     AND NOT t.tgisinternal
     AND t.tgname IN (
       'outbox_events_accepted_activity_cursor_allocator',
       'outbox_events_accepted_activity_immutable_guard',
       'outbox_events_accepted_activity_notify'
     );
  IF trigger_count <> 3 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_TRIGGER_PREIMAGE_DRIFT';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.outbox_events
     WHERE event_type = 'realtime.t04.accepted_user_activity.v1'
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_T04_ROWS_ALREADY_PRESENT';
  END IF;
END
$t04_preflight$;

ALTER TABLE public.outbox_events
  DROP CONSTRAINT outbox_events_accepted_activity_cursor_ck,
  DROP CONSTRAINT outbox_events_accepted_activity_profile_ck,
  DROP CONSTRAINT outbox_events_accepted_activity_canonical_hashes_ck;

ALTER TABLE public.outbox_events
  ADD CONSTRAINT outbox_events_accepted_activity_cursor_ck CHECK (
    (
      event_type IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1')
      AND accepted_activity_cursor IS NOT NULL
      AND accepted_activity_cursor > 0
    )
    OR (
      event_type NOT IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1')
      AND accepted_activity_cursor IS NULL
    )
  ),
  ADD CONSTRAINT outbox_events_accepted_activity_profile_ck CHECK (
    event_type NOT IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1')
    OR (
      aggregate_type = 'realtime'
      AND event_version = 1
      AND idempotency_scope = 'realtime.outbox'
      AND jsonb_typeof(aggregate_ref) = 'object'
      AND aggregate_ref ?& ARRAY['ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256']
      AND (aggregate_ref - ARRAY[
        'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'
      ]::text[]) = '{}'::jsonb
      AND aggregate_ref->>'ref_type' = 'RealtimeSession'
      AND aggregate_ref->>'ref_id' = aggregate_id::text
      AND aggregate_ref->>'object_version' ~ '^[1-9][0-9]*$'
      AND aggregate_ref->>'canonical_payload_sha256' ~ '^[0-9a-f]{64}$'
      AND CASE
        WHEN event_type = 'realtime.continuity.renewed' THEN
          jsonb_typeof(payload) = 'object'
          AND payload ?& ARRAY['activityId', 'continuityId', 'acceptanceRef', 'authorityWatermark']
          AND (payload - ARRAY[
            'activityId', 'continuityId', 'acceptanceRef', 'authorityWatermark'
          ]::text[]) = '{}'::jsonb
          AND payload->>'activityId' = idempotency_key
          AND payload->>'activityId' ~ '^[^[:space:]]+$'
          AND char_length(payload->>'activityId') BETWEEN 1 AND 256
          AND payload->>'continuityId' ~ '^[^[:space:]]+$'
          AND char_length(payload->>'continuityId') BETWEEN 1 AND 256
          AND jsonb_typeof(payload->'acceptanceRef') IN ('string', 'object')
          AND jsonb_typeof(payload->'authorityWatermark') IN ('string', 'object')
        WHEN event_type = 'realtime.t04.accepted_user_activity.v1' THEN
          jsonb_typeof(payload) = 'object'
          AND payload ?& ARRAY[
            'activityId', 'continuityId', 'acceptanceRef', 'authorityWatermark',
            'actionReceipt', 'currentBinding', 'authorityProjection'
          ]
          AND (payload - ARRAY[
            'activityId', 'continuityId', 'acceptanceRef', 'authorityWatermark',
            'actionReceipt', 'currentBinding', 'authorityProjection'
          ]::text[]) = '{}'::jsonb
          AND payload->>'activityId' = idempotency_key
          AND payload->>'activityId' ~ '^[^[:space:]]+$'
          AND char_length(payload->>'activityId') BETWEEN 1 AND 256
          AND payload->>'continuityId' ~ '^[^[:space:]]+$'
          AND char_length(payload->>'continuityId') BETWEEN 1 AND 256
          AND jsonb_typeof(payload->'acceptanceRef') IN ('string', 'object')
          AND jsonb_typeof(payload->'authorityWatermark') IN ('string', 'object')
          AND jsonb_typeof(payload->'actionReceipt') = 'object'
          AND jsonb_typeof(payload->'currentBinding') = 'object'
          AND jsonb_typeof(payload->'authorityProjection') = 'object'
        ELSE FALSE
      END
    )
  ),
  ADD CONSTRAINT outbox_events_accepted_activity_canonical_hashes_ck CHECK (
    event_type NOT IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1')
    OR (
      payload_sha256 ~ '^[0-9a-f]{64}$'
      AND aggregate_ref->>'canonical_payload_sha256' ~ '^[0-9a-f]{64}$'
    )
  );

CREATE OR REPLACE FUNCTION public.outbox_events_accepted_activity_cursor_allocate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $accepted_activity_cursor_allocator$
BEGIN
  IF NEW.event_type IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1') THEN
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
  old_is_accepted := OLD.event_type IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1');
  IF TG_OP = 'DELETE' THEN
    IF old_is_accepted THEN
      RAISE EXCEPTION 'PAIOS_ACCEPTED_ACTIVITY_ROWS_ARE_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  new_is_accepted := NEW.event_type IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1');
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
  IF NEW.event_type IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1') THEN
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

COMMENT ON COLUMN public.outbox_events.accepted_activity_cursor IS
  'T02-owned positive decimal cursor for the legacy renewal and T04 full accepted-activity profiles.';
COMMENT ON CONSTRAINT outbox_events_accepted_activity_cursor_ck ON public.outbox_events IS
  'Both accepted activity profiles require a positive database cursor; every other outbox row requires NULL.';
COMMENT ON CONSTRAINT outbox_events_accepted_activity_profile_ck ON public.outbox_events IS
  'The accepted stream permits the legacy four-field renewal profile and the exact seven-field T04 owner-event profile.';
COMMENT ON FUNCTION public.outbox_events_accepted_activity_cursor_allocate() IS
  'Allocates legacy and T04 accepted-activity cursors from the dedicated sequence and rejects caller-supplied cursors.';
COMMENT ON FUNCTION public.outbox_events_accepted_activity_immutable_guard() IS
  'Prevents identity, payload, hash, creation-time, and cursor mutation or deletion for either accepted-activity profile.';
COMMENT ON FUNCTION public.outbox_events_accepted_activity_notify() IS
  'Publishes only cursor and event_id for both accepted-activity profiles on the existing notification channel.';

DO $t04_assert$
DECLARE
  cursor_is_nullable BOOLEAN;
BEGIN
  SELECT NOT a.attnotnull INTO cursor_is_nullable
    FROM pg_catalog.pg_attribute AS a
   WHERE a.attrelid = 'public.outbox_events'::regclass
     AND a.attname = 'accepted_activity_cursor'
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF cursor_is_nullable IS DISTINCT FROM TRUE
     OR to_regclass('public.outbox_events_accepted_activity_cursor_seq') IS NULL THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_SUBSTRATE_DRIFT';
  END IF;
  IF (
    SELECT count(*) FROM pg_catalog.pg_constraint AS c
     WHERE c.conrelid = 'public.outbox_events'::regclass
       AND c.conname IN (
         'outbox_events_accepted_activity_cursor_ck',
         'outbox_events_accepted_activity_profile_ck',
         'outbox_events_accepted_activity_canonical_hashes_ck'
       )
       AND c.convalidated
  ) <> 3 THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_CONSTRAINT_SET_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE event_type = 'realtime.t04.accepted_user_activity.v1'
       AND accepted_activity_cursor IS NULL
  ) THEN
    RAISE EXCEPTION 'PAIOS_MIGRATION_0007_ACCEPTED_ACTIVITY_CURSOR_DATA_MISMATCH';
  END IF;
END
$t04_assert$;

COMMIT;
