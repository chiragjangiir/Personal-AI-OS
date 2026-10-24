-- 0017 renames this table; final verification still checks the persisted 0015 contract.
-- pg_restore re-parses 0017's BETWEEN label check into one flat AND; both deparses are the same constraint.
WITH relations AS (
  SELECT to_regclass('public.glasses_enrollments') AS old_table,
    to_regclass('public.terminal_enrollments') AS new_table
), shape AS (
  SELECT COALESCE(old_table, new_table) AS enrollment_table, new_table IS NOT NULL AS terminal,
    (old_table IS NOT NULL) <> (new_table IS NOT NULL) AS single_shape
  FROM relations
)
SELECT bool_and(p) AS complete, enrollment_table IS NOT NULL AS touched FROM shape CROSS JOIN LATERAL (VALUES
  (single_shape),
  ((SELECT count(*) = CASE WHEN terminal THEN 4 ELSE 3 END FROM pg_attribute
    WHERE attrelid = enrollment_table AND attnum > 0 AND NOT attisdropped)),
  ((SELECT count(*) = CASE WHEN terminal THEN 4 ELSE 3 END FROM pg_attribute WHERE attrelid = enrollment_table AND attnotnull AND
    ((attname = 'token_sha256' AND atttypid = 'text'::regtype) OR (attname = 'phone_device_id' AND atttypid = 'uuid'::regtype)
      OR (attname = 'expires_at' AND atttypid = 'timestamptz'::regtype)
      OR (terminal AND attname = 'device_class' AND atttypid = 'text'::regtype AND NOT atthasdef)))),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = enrollment_table AND pg_get_constraintdef(oid) =
    CASE WHEN terminal THEN 'PRIMARY KEY (phone_device_id, device_class)' ELSE 'PRIMARY KEY (phone_device_id)' END)),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = enrollment_table AND pg_get_constraintdef(oid) = 'UNIQUE (token_sha256)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = enrollment_table AND pg_get_constraintdef(oid) = 'FOREIGN KEY (phone_device_id) REFERENCES paired_devices(device_id)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = enrollment_table AND pg_get_constraintdef(oid) = 'CHECK ((token_sha256 ~ ''^[0-9a-f]{64}$''::text))')),
  (NOT terminal OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = enrollment_table AND pg_get_constraintdef(oid) = 'CHECK ((device_class = ANY (ARRAY[''glasses''::text, ''mac''::text])))')),
  (NOT terminal OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND pg_get_constraintdef(oid) = 'CHECK ((device_class = ANY (ARRAY[''iphone''::text, ''glasses''::text, ''mac''::text])))')),
  (NOT terminal OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.paired_devices') AND pg_get_constraintdef(oid) IN ('CHECK (((label IS NULL) OR (((char_length(label) >= 1) AND (char_length(label) <= 64)) AND (label !~ ''[[:cntrl:]]''::text))))',
      'CHECK (((label IS NULL) OR ((char_length(label) >= 1) AND (char_length(label) <= 64) AND (label !~ ''[[:cntrl:]]''::text))))')))
) AS v(p) GROUP BY enrollment_table;
