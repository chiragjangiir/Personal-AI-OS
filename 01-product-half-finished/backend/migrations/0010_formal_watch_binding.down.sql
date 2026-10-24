BEGIN;
-- Rollback cannot erase live formal registration or quietly reinterpret it as canary.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM apple_physical_canary_bindings WHERE companion_source = 'apple_watch_binding_v1') THEN
    RAISE EXCEPTION 'PAIOS_FORMAL_WATCH_ROLLBACK_HAS_RECORDS';
  END IF;
END $$;
DROP INDEX apple_formal_watch_active_primary_uq;
DROP INDEX apple_formal_watch_active_installation_uq;
ALTER TABLE apple_physical_canary_bindings
  DROP CONSTRAINT apple_formal_watch_fields_ck,
  DROP CONSTRAINT apple_companion_source_ck,
  DROP COLUMN user_id, DROP COLUMN watch_installation_id, DROP COLUMN pair_version, DROP COLUMN principal_ref,
  ADD CONSTRAINT apple_physical_canary_bindings_companion_source_ck CHECK
    (companion_source = 'apple_physical_canary_binding_v1');
COMMIT;
