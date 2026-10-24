BEGIN;
SET LOCAL lock_timeout = '5s';
-- Rollback is intentionally refused if multiple terminals cannot fit the previous contract.
DROP INDEX paired_devices_active_key_uq;
DROP INDEX paired_devices_active_class_uq;
ALTER TABLE paired_devices DROP CONSTRAINT paired_devices_device_class_check;
ALTER TABLE paired_devices ADD CONSTRAINT paired_devices_device_class_check CHECK (device_class = 'iphone' OR (device_class = 'glasses' AND status = 'revoked'));
CREATE UNIQUE INDEX paired_devices_active_class_uq ON paired_devices (user_id, device_class) WHERE status = 'active';
COMMIT;
