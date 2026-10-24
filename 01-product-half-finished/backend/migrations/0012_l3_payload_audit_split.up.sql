-- Owned, offline source migration. Apply only after draining old writers in this namespace.
BEGIN;
LOCK TABLE paios_l3_versions, paios_l3_receipts, paios_l3_heads, paios_l3_dependencies, paios_l3_invalidations IN ACCESS EXCLUSIVE MODE;
CREATE TABLE paios_l3_payloads (
 principal_id text NOT NULL, assertion_id text NOT NULL, version integer NOT NULL,
 assertion_payload jsonb NOT NULL, command_payload jsonb NOT NULL,
 PRIMARY KEY(principal_id, assertion_id, version),
 FOREIGN KEY(principal_id, assertion_id, version) REFERENCES paios_l3_versions
);
INSERT INTO paios_l3_payloads
 SELECT v.principal_id,v.assertion_id,v.version,v.payload,r.command_payload
 FROM paios_l3_versions v JOIN paios_l3_receipts r ON r.principal_id=v.principal_id
 AND r.receipt->>'assertion_id'=v.assertion_id AND r.receipt->>'version'=v.version::text
 AND r.command_payload->'assertion'->>'assertion_id'=v.assertion_id
 AND r.command_payload->>'expected_version'=(v.version-1)::text;
DO $$ BEGIN
 IF (SELECT count(*) FROM paios_l3_payloads)<>(SELECT count(*) FROM paios_l3_versions)
 THEN RAISE EXCEPTION 'L3_PAYLOAD_BACKFILL_INCOMPLETE'; END IF;
END $$;
ALTER TABLE paios_l3_versions DISABLE TRIGGER l3_versions_immutable;
ALTER TABLE paios_l3_receipts DISABLE TRIGGER l3_receipts_immutable;
UPDATE paios_l3_versions SET payload=jsonb_build_object('schema','l3.audit.v1',
 'status',payload->>'status','applicability_status',payload->>'applicability_status');
UPDATE paios_l3_receipts SET command_payload=jsonb_build_object('schema','l3.command-audit.v1',
 'operation',command_payload->>'operation','assertion_id',command_payload->'assertion'->>'assertion_id',
 'expected_version',command_payload->'expected_version');
ALTER TABLE paios_l3_versions RENAME COLUMN payload TO audit;
ALTER TABLE paios_l3_receipts RENAME COLUMN command_payload TO command_audit;
ALTER TABLE paios_l3_versions ADD CONSTRAINT l3_version_audit_shape CHECK ((
 audit=jsonb_build_object('schema','l3.audit.v1','status',audit->>'status','applicability_status',audit->>'applicability_status')
 AND audit->>'status' IN ('candidate','active','retracted','deleted')
 AND audit->>'applicability_status' IN ('applicable','stopped','needs_reevaluation')) IS TRUE);
ALTER TABLE paios_l3_receipts ADD CONSTRAINT l3_command_audit_shape CHECK ((
 command_audit=jsonb_build_object('schema','l3.command-audit.v1','operation',command_audit->>'operation',
 'assertion_id',command_audit->>'assertion_id','expected_version',command_audit->'expected_version')
 AND command_audit->>'operation' IN ('create','correct','review','delete','retract','deny','forget')
 AND jsonb_typeof(command_audit->'assertion_id')='string'
 AND jsonb_typeof(command_audit->'expected_version')='number') IS TRUE);
ALTER TABLE paios_l3_versions ENABLE TRIGGER l3_versions_immutable;
ALTER TABLE paios_l3_receipts ENABLE TRIGGER l3_receipts_immutable;
CREATE TABLE paios_l3_forgotten (
 principal_id text NOT NULL, assertion_id text NOT NULL, version integer NOT NULL,
 command_id text NOT NULL, payload_sha256 text NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(principal_id,assertion_id), UNIQUE(principal_id,command_id),
 FOREIGN KEY(principal_id,assertion_id,version) REFERENCES paios_l3_versions,
 FOREIGN KEY(principal_id,command_id) REFERENCES paios_l3_receipts DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER l3_forgotten_immutable BEFORE UPDATE OR DELETE ON paios_l3_forgotten
 FOR EACH ROW EXECUTE FUNCTION paios_l3_immutable_guard();
COMMIT;
