SELECT bool_and(p) AS complete,
  EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.apple_physical_canary_bindings')
    AND attname IN ('watch_token_sha256','watch_token_expires_at','watch_token_revoked') AND NOT attisdropped)
  OR to_regclass('public.apple_watch_token_uq') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.apple_physical_canary_bindings') AND conname='apple_watch_token_ck') AS touched
FROM (VALUES
  ((SELECT count(*)=3 FROM pg_attribute WHERE attrelid=to_regclass('public.apple_physical_canary_bindings') AND NOT attisdropped AND
    ((attname='watch_token_sha256' AND atttypid='text'::regtype AND NOT attnotnull)
      OR (attname='watch_token_expires_at' AND atttypid='timestamptz'::regtype AND NOT attnotnull)
      OR (attname='watch_token_revoked' AND atttypid='bool'::regtype AND attnotnull)))),
  (EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    WHERE a.attrelid=to_regclass('public.apple_physical_canary_bindings') AND a.attname='watch_token_revoked' AND pg_get_expr(d.adbin,d.adrelid)='false')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.apple_physical_canary_bindings') AND conname='apple_watch_token_ck' AND contype='c')),
  (EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.apple_watch_token_uq') AND indisunique AND indisvalid
    AND pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX apple_watch_token_uq ON public.apple_physical_canary_bindings USING btree (watch_token_sha256) WHERE (watch_token_sha256 IS NOT NULL)'))
) AS v(p);
