-- Verifier for 0003_memory_authority.up.sql: one row (complete, touched). complete = every object this version creates
-- exists; touched = at least one exists (a mix of true/false means partial application). Read-only.
SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.memory_authority_clock') IS NOT NULL),
  (to_regclass('public.memory_candidates') IS NOT NULL),
  (to_regclass('public.memory_candidates_user_status_idx') IS NOT NULL),
  (to_regclass('public.memory_versions') IS NOT NULL),
  (to_regclass('public.memory_versions_user_slot_read_idx') IS NOT NULL),
  (to_regclass('public.memory_dream_deltas') IS NOT NULL),
  (to_regclass('public.memory_dream_deltas_read_idx') IS NOT NULL),
  (to_regclass('public.memory_derived_projections') IS NOT NULL),
  (to_regclass('public.memory_deletion_mutations') IS NOT NULL),
  (to_regclass('public.memory_rebuild_runs') IS NOT NULL)
) AS v(p);
