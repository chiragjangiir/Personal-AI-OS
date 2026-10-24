BEGIN;
-- Derived bearer material belongs to the existing formal companion binding owner.
ALTER TABLE apple_physical_canary_bindings
  ADD COLUMN watch_token_sha256 text,
  ADD COLUMN watch_token_expires_at timestamptz,
  ADD COLUMN watch_token_revoked boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT apple_watch_token_ck CHECK (
    (watch_token_sha256 IS NULL AND watch_token_expires_at IS NULL) OR
    (companion_source='apple_watch_binding_v1' AND watch_token_sha256 ~ '^[0-9a-f]{64}$'
      AND watch_token_expires_at IS NOT NULL AND watch_token_expires_at <= expires_at));
CREATE UNIQUE INDEX apple_watch_token_uq ON apple_physical_canary_bindings(watch_token_sha256) WHERE watch_token_sha256 IS NOT NULL;
COMMIT;
