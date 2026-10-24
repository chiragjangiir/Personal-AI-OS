CREATE TABLE IF NOT EXISTS paios_action_proposals (
  principal_id text NOT NULL, action_id text NOT NULL, business_intent_id text NOT NULL,
  parameter_version integer NOT NULL CHECK (parameter_version > 0), payload_sha256 text NOT NULL,
  command jsonb NOT NULL, pending_receipt jsonb NOT NULL,
  PRIMARY KEY(principal_id,action_id), UNIQUE(principal_id,business_intent_id,parameter_version)
);
CREATE TABLE IF NOT EXISTS paios_action_confirmations (
  principal_id text NOT NULL, action_id text NOT NULL, payload_sha256 text NOT NULL,
  consent_ref text NOT NULL, target_device_id text NOT NULL, source text NOT NULL CHECK(source='explicit_user_ui'),
  PRIMARY KEY(principal_id,action_id), FOREIGN KEY(principal_id,action_id) REFERENCES paios_action_proposals
);
CREATE TABLE IF NOT EXISTS paios_action_invocations (
  principal_id text NOT NULL, action_id text NOT NULL, run_id text NOT NULL,
  PRIMARY KEY(principal_id,action_id,run_id), FOREIGN KEY(principal_id,action_id) REFERENCES paios_action_proposals
);
CREATE TABLE IF NOT EXISTS paios_action_execution (
  principal_id text NOT NULL, action_id text NOT NULL, execution_run_id text NOT NULL,
  PRIMARY KEY(principal_id,action_id), FOREIGN KEY(principal_id,action_id) REFERENCES paios_action_proposals
);
CREATE OR REPLACE FUNCTION paios_action_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ACTION_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS proposal_immutable ON paios_action_proposals;
CREATE TRIGGER proposal_immutable BEFORE UPDATE OR DELETE ON paios_action_proposals FOR EACH ROW EXECUTE FUNCTION paios_action_immutable();
DROP TRIGGER IF EXISTS confirmation_immutable ON paios_action_confirmations;
CREATE TRIGGER confirmation_immutable BEFORE UPDATE OR DELETE ON paios_action_confirmations FOR EACH ROW EXECUTE FUNCTION paios_action_immutable();
