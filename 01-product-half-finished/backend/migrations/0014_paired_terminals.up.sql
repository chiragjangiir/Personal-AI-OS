BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE paired_devices DROP CONSTRAINT paired_devices_device_class_check;
ALTER TABLE paired_devices ADD CONSTRAINT paired_devices_device_class_check CHECK (device_class IN ('iphone', 'glasses'));
DROP INDEX paired_devices_active_class_uq;
-- Preserve the old object name for ledger verifiers; class is now a lookup, not a cardinality limit.
CREATE INDEX paired_devices_active_class_uq ON paired_devices (user_id, device_class) WHERE status = 'active';
CREATE UNIQUE INDEX paired_devices_active_key_uq ON paired_devices (recipient_public_key_sha256) WHERE status = 'active';
COMMIT;
