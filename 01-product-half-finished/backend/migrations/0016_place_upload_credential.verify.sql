SELECT bool_and(p) AS complete, EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.paired_devices') AND attname = 'place_token_sha256' AND NOT attisdropped) AS touched FROM (VALUES
  (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.paired_devices') AND attname = 'place_token_sha256' AND atttypid = 'text'::regtype AND NOT attnotnull)),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND pg_get_constraintdef(oid) = 'UNIQUE (place_token_sha256)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND conname = 'paired_devices_place_phone'))
) AS v(p);
