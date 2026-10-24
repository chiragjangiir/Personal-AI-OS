BEGIN;
DROP INDEX apple_watch_token_uq;
ALTER TABLE apple_physical_canary_bindings DROP CONSTRAINT apple_watch_token_ck, DROP COLUMN watch_token_sha256, DROP COLUMN watch_token_expires_at, DROP COLUMN watch_token_revoked;
COMMIT;
