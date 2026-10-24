-- Verifier for 0005_apple_physical_canary_binding.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.apple_physical_canary_bindings') IS NOT NULL),
  (to_regclass('public.apple_physical_canary_bindings_session_state_expires_idx') IS NOT NULL),
  (to_regclass('public.apple_physical_canary_bindings_iphone_lease_idx') IS NOT NULL),
  (to_regclass('public.apple_physical_canary_bindings_watch_lease_idx') IS NOT NULL)
) AS v(p);
