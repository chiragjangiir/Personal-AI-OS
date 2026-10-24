-- Verifier for 0006_accepted_activity_stream.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.outbox_events') AND attname = 'accepted_activity_cursor' AND attnum > 0 AND NOT attisdropped)),
  (to_regclass('public.outbox_events_accepted_activity_cursor_seq') IS NOT NULL),
  (to_regclass('public.outbox_events_accepted_activity_cursor_uq') IS NOT NULL),
  (to_regclass('public.outbox_events_accepted_activity_read_after_idx') IS NOT NULL),
  (to_regclass('public.outbox_events_accepted_activity_aggregate_read_after_idx') IS NOT NULL),
  (to_regproc('public.outbox_events_accepted_activity_cursor_allocate') IS NOT NULL),
  (to_regproc('public.outbox_events_accepted_activity_immutable_guard') IS NOT NULL),
  (to_regproc('public.outbox_events_accepted_activity_notify') IS NOT NULL),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'outbox_events_accepted_activity_cursor_allocator' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'outbox_events_accepted_activity_immutable_guard' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'outbox_events_accepted_activity_notify' AND NOT tgisinternal)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'outbox_events_accepted_activity_cursor_ck' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'outbox_events_accepted_activity_profile_ck' AND convalidated)),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'outbox_events_accepted_activity_canonical_hashes_ck' AND convalidated))
) AS v(p);
