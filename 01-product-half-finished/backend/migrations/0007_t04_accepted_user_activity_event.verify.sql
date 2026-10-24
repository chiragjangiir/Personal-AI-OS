-- Verifier for 0007_t04_accepted_user_activity_event.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'outbox_events_accepted_activity_profile_ck' AND convalidated AND pg_get_constraintdef(oid, TRUE) ILIKE '%realtime.t04.accepted_user_activity.v1%')),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = to_regproc('public.outbox_events_accepted_activity_cursor_allocate') AND prosrc ILIKE '%realtime.t04.accepted_user_activity.v1%')),
  (EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = to_regproc('public.outbox_events_accepted_activity_notify') AND prosrc ILIKE '%realtime.t04.accepted_user_activity.v1%'))
) AS v(p);
