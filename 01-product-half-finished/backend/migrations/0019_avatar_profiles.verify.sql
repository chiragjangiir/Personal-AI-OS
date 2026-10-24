SELECT bool_and(p) AS complete,
  to_regclass('public.avatar_profiles') IS NOT NULL OR to_regclass('public.avatar_profile_commands') IS NOT NULL AS touched
FROM (VALUES
  ((SELECT count(*)=2 FROM pg_attribute WHERE attrelid=to_regclass('public.avatar_profiles') AND attnotnull AND
    ((attname='principal_id' AND atttypid='text'::regtype) OR (attname='record' AND atttypid='jsonb'::regtype)))),
  ((SELECT count(*)=5 FROM pg_attribute WHERE attrelid=to_regclass('public.avatar_profile_commands') AND attnotnull AND
    ((attname IN ('principal_id','command_id','state') AND atttypid='text'::regtype) OR
      (attname='created_at' AND atttypid='timestamptz'::regtype) OR (attname='record' AND atttypid='jsonb'::regtype)))),
  (EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.avatar_profile_commands_pending')
    AND indrelid=to_regclass('public.avatar_profile_commands') AND indisvalid)),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.avatar_profiles') AND pg_get_constraintdef(oid)='PRIMARY KEY (principal_id)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.avatar_profile_commands') AND pg_get_constraintdef(oid)='PRIMARY KEY (principal_id, command_id)')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.avatar_profile_commands') AND contype='f'
    AND confrelid=to_regclass('public.avatar_profiles') AND condeferrable AND condeferred)),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.avatar_profiles') AND conname='avatar_profiles_record_check')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.avatar_profile_commands') AND conname='avatar_profile_commands_record_check')),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.avatar_profile_commands') AND conname='avatar_profile_commands_state_check'))
) AS v(p);
