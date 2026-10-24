-- Verifier for 0002_realtime_authority.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.realtime_sessions') IS NOT NULL),
  (to_regclass('public.realtime_sessions_one_active_per_continuity_uq') IS NOT NULL),
  (to_regclass('public.device_leases') IS NOT NULL),
  (to_regclass('public.device_leases_session_state_idx') IS NOT NULL),
  (to_regclass('public.realtime_transport_aliases') IS NOT NULL),
  (to_regclass('public.realtime_transport_aliases_active_idx') IS NOT NULL),
  (to_regclass('public.realtime_terminal_facts') IS NOT NULL),
  (to_regclass('public.realtime_handoff_facts') IS NOT NULL),
  (to_regclass('public.realtime_external_effects') IS NOT NULL)
) AS v(p);
