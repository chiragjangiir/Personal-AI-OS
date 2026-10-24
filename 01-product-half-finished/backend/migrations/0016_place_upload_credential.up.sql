BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE paired_devices ADD COLUMN place_token_sha256 text UNIQUE CHECK (place_token_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT paired_devices_place_phone CHECK (place_token_sha256 IS NULL OR device_class = 'iphone');
COMMIT;
