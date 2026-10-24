BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE paired_devices DROP COLUMN place_token_sha256;
COMMIT;
