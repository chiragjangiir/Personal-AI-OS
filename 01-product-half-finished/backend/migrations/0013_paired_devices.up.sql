BEGIN;
-- One row per paired device: the single authority for device identity, bearer credential, E2EE recipient key,
-- media scope and the governance refs minted at pairing. Replaces the T03 authority file and enrollment bundles.
CREATE TABLE paired_devices (
  device_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  device_class text NOT NULL CHECK (device_class IN ('iphone')),
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_public_key text NOT NULL CHECK (recipient_public_key ~ '^[A-Za-z0-9_-]{43}$'),
  recipient_public_key_sha256 text NOT NULL CHECK (recipient_public_key_sha256 ~ '^[0-9a-f]{64}$'),
  device_credential_ref jsonb NOT NULL,
  media text[] NOT NULL CHECK (media <@ ARRAY['audio', 'video', 'data'] AND 'data' = ANY (media)),
  governance jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  paired_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX paired_devices_active_class_uq ON paired_devices (user_id, device_class) WHERE status = 'active';
COMMIT;
