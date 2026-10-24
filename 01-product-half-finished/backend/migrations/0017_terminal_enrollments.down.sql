BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM paired_devices WHERE device_class = 'mac') THEN
    RAISE EXCEPTION 'MAC_TERMINAL_HISTORY_PRESENT';
  END IF;
END $$;
DELETE FROM terminal_enrollments WHERE device_class = 'mac';
ALTER TABLE terminal_enrollments DROP CONSTRAINT terminal_enrollments_pkey;
ALTER TABLE terminal_enrollments ADD CONSTRAINT glasses_enrollments_pkey PRIMARY KEY (phone_device_id);
ALTER TABLE terminal_enrollments DROP COLUMN device_class;
ALTER TABLE terminal_enrollments RENAME TO glasses_enrollments;
ALTER TABLE paired_devices DROP COLUMN label;
ALTER TABLE paired_devices DROP CONSTRAINT paired_devices_device_class_check;
ALTER TABLE paired_devices ADD CONSTRAINT paired_devices_device_class_check CHECK (device_class IN ('iphone', 'glasses'));
COMMIT;
