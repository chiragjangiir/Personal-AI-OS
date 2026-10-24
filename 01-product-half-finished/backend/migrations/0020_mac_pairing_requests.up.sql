BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE mac_pairing_requests (
  nonce_sha256 text PRIMARY KEY CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  poll_token_sha256 text NOT NULL CHECK (poll_token_sha256 ~ '^[0-9a-f]{64}$'),
  registration jsonb NOT NULL CHECK (jsonb_typeof(registration) = 'object' AND registration->>'device_type' = 'mac'),
  phone_device_id uuid REFERENCES paired_devices(device_id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX mac_pairing_requests_expiry ON mac_pairing_requests(expires_at);
COMMIT;
