SELECT bool_and(p) AS complete, bool_or(p) AS touched FROM (VALUES
  (to_regclass('public.paired_devices_active_key_uq') IS NOT NULL),
  (EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.paired_devices_active_class_uq') AND NOT indisunique)),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND conname = 'paired_devices_device_class_check'
    AND pg_get_constraintdef(oid) LIKE '%glasses%' AND pg_get_constraintdef(oid) NOT LIKE '%status%'))
) AS v(p);
