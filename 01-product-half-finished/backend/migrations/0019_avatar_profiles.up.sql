CREATE TABLE avatar_profiles (
  principal_id text PRIMARY KEY,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE TABLE avatar_profile_commands (
  principal_id text NOT NULL REFERENCES avatar_profiles(principal_id) DEFERRABLE INITIALLY DEFERRED,
  command_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','submitting','pending','ready','failed','submission_uncertain','superseded')),
  created_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY(principal_id,command_id)
);
CREATE INDEX avatar_profile_commands_pending ON avatar_profile_commands(created_at)
  WHERE state IN ('queued','submitting','pending');
