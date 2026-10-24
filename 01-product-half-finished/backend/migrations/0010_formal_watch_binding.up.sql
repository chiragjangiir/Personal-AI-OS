BEGIN;
-- Extend the original companion owner. Existing canary rows retain their source and NULL formal fields.
ALTER TABLE apple_physical_canary_bindings
  DROP CONSTRAINT apple_physical_canary_bindings_companion_source_ck,
  ADD COLUMN user_id UUID,
  ADD COLUMN watch_installation_id UUID,
  ADD COLUMN pair_version TEXT,
  ADD COLUMN principal_ref JSONB,
  ADD CONSTRAINT apple_companion_source_ck CHECK
    (companion_source IN ('apple_physical_canary_binding_v1', 'apple_watch_binding_v1')),
  ADD CONSTRAINT apple_formal_watch_fields_ck CHECK (
    (companion_source = 'apple_physical_canary_binding_v1' AND user_id IS NULL
      AND watch_installation_id IS NULL AND pair_version IS NULL AND principal_ref IS NULL)
    OR (companion_source = 'apple_watch_binding_v1' AND user_id IS NOT NULL
      AND watch_installation_id IS NOT NULL AND principal_ref IS NOT NULL
      AND pair_version IS NOT NULL AND pair_version ~ '^[1-9][0-9]{0,37}$')
  );
CREATE UNIQUE INDEX apple_formal_watch_active_primary_uq
  ON apple_physical_canary_bindings (user_id, iphone_device_id)
  WHERE companion_source = 'apple_watch_binding_v1' AND state = 'active';
CREATE UNIQUE INDEX apple_formal_watch_active_installation_uq
  ON apple_physical_canary_bindings (user_id, watch_installation_id)
  WHERE companion_source = 'apple_watch_binding_v1' AND state = 'active';
COMMIT;
