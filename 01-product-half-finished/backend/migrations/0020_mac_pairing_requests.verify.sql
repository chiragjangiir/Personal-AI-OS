SELECT bool_and(p) AS complete, to_regclass('public.mac_pairing_requests') IS NOT NULL AS touched FROM (VALUES
  ((SELECT count(*) = 4 FROM pg_attribute WHERE attrelid = to_regclass('public.mac_pairing_requests') AND attnotnull AND
    ((attname = 'nonce_sha256' AND atttypid = 'text'::regtype) OR (attname = 'poll_token_sha256' AND atttypid = 'text'::regtype)
      OR (attname = 'registration' AND atttypid = 'jsonb'::regtype) OR (attname = 'expires_at' AND atttypid = 'timestamptz'::regtype)))),
  (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.mac_pairing_requests') AND attname = 'phone_device_id' AND atttypid = 'uuid'::regtype AND NOT attnotnull)),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.mac_pairing_requests') AND pg_get_constraintdef(oid) = 'PRIMARY KEY (nonce_sha256)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.mac_pairing_requests') AND pg_get_constraintdef(oid) = 'FOREIGN KEY (phone_device_id) REFERENCES paired_devices(device_id)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.mac_pairing_requests') AND pg_get_constraintdef(oid) = 'CHECK ((nonce_sha256 ~ ''^[0-9a-f]{64}$''::text))')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.mac_pairing_requests') AND pg_get_constraintdef(oid) = 'CHECK ((poll_token_sha256 ~ ''^[0-9a-f]{64}$''::text))')),
  (EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'mac_pairing_requests' AND indexname = 'mac_pairing_requests_expiry'))
) AS v(p);
