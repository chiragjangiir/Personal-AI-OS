-- pg_restore re-parses the BETWEEN label check into one flat AND; both deparses are the same constraint.
SELECT bool_and(p) AS complete, to_regclass('public.terminal_enrollments') IS NOT NULL AS touched FROM (VALUES
  ((SELECT count(*) = 4 FROM pg_attribute WHERE attrelid = to_regclass('public.terminal_enrollments') AND attnotnull AND
    ((attname = 'token_sha256' AND atttypid = 'text'::regtype) OR (attname = 'phone_device_id' AND atttypid = 'uuid'::regtype)
      OR (attname = 'device_class' AND atttypid = 'text'::regtype) OR (attname = 'expires_at' AND atttypid = 'timestamptz'::regtype)))),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.terminal_enrollments') AND pg_get_constraintdef(oid) = 'PRIMARY KEY (phone_device_id, device_class)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.terminal_enrollments') AND pg_get_constraintdef(oid) = 'UNIQUE (token_sha256)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.terminal_enrollments') AND pg_get_constraintdef(oid) = 'FOREIGN KEY (phone_device_id) REFERENCES paired_devices(device_id)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.terminal_enrollments') AND pg_get_constraintdef(oid) = 'CHECK ((token_sha256 ~ ''^[0-9a-f]{64}$''::text))'))
  ,(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND pg_get_constraintdef(oid) = 'CHECK ((device_class = ANY (ARRAY[''iphone''::text, ''glasses''::text, ''mac''::text])))'))
  ,(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.terminal_enrollments') AND pg_get_constraintdef(oid) = 'CHECK ((device_class = ANY (ARRAY[''glasses''::text, ''mac''::text])))'))
  ,(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND pg_get_constraintdef(oid) IN ('CHECK (((label IS NULL) OR (((char_length(label) >= 1) AND (char_length(label) <= 64)) AND (label !~ ''[[:cntrl:]]''::text))))',
      'CHECK (((label IS NULL) OR ((char_length(label) >= 1) AND (char_length(label) <= 64) AND (label !~ ''[[:cntrl:]]''::text))))')))
) AS v(p);
