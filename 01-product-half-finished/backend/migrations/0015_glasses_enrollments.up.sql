BEGIN;
CREATE TABLE glasses_enrollments (
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  phone_device_id uuid PRIMARY KEY REFERENCES paired_devices(device_id),
  expires_at timestamptz NOT NULL
);
COMMIT;
