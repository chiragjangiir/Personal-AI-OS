BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE paired_devices DROP CONSTRAINT paired_devices_device_class_check;
ALTER TABLE paired_devices ADD CONSTRAINT paired_devices_device_class_check CHECK (device_class IN ('iphone', 'glasses', 'mac'));
ALTER TABLE paired_devices ADD COLUMN label text
  CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 64 AND label !~ '[[:cntrl:]]'));
ALTER TABLE glasses_enrollments RENAME TO terminal_enrollments;
ALTER TABLE terminal_enrollments ADD COLUMN device_class text NOT NULL DEFAULT 'glasses'
  CHECK (device_class IN ('glasses', 'mac'));
ALTER TABLE terminal_enrollments ALTER COLUMN device_class DROP DEFAULT;
ALTER TABLE terminal_enrollments DROP CONSTRAINT glasses_enrollments_pkey;
ALTER TABLE terminal_enrollments ADD CONSTRAINT terminal_enrollments_pkey PRIMARY KEY (phone_device_id, device_class);
COMMIT;
