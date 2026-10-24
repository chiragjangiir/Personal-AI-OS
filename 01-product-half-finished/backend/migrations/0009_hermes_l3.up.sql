-- L3 only: no conversation or parser history.
CREATE TABLE paios_l3_versions (
 principal_id text NOT NULL, assertion_id text NOT NULL, version integer NOT NULL CHECK(version > 0),
 payload jsonb NOT NULL, PRIMARY KEY(principal_id, assertion_id, version)
);
CREATE TABLE paios_l3_heads (
 principal_id text NOT NULL, assertion_id text NOT NULL, version integer NOT NULL,
 PRIMARY KEY(principal_id, assertion_id), FOREIGN KEY(principal_id, assertion_id, version) REFERENCES paios_l3_versions
);
CREATE TABLE paios_l3_receipts (
 principal_id text NOT NULL, command_id text NOT NULL, payload_sha256 text NOT NULL, run_id text NOT NULL,
 receipt jsonb NOT NULL, command_payload jsonb NOT NULL, PRIMARY KEY(principal_id, command_id)
);
CREATE INDEX paios_l3_receipts_run ON paios_l3_receipts(principal_id, run_id);
CREATE TABLE paios_l3_dependencies (
 principal_id text NOT NULL, assertion_id text NOT NULL, version integer NOT NULL,
 dependency_id text NOT NULL, dependency_version integer NOT NULL,
 PRIMARY KEY(principal_id, assertion_id, version, dependency_id, dependency_version),
 FOREIGN KEY(principal_id, assertion_id, version) REFERENCES paios_l3_versions,
 FOREIGN KEY(principal_id, dependency_id, dependency_version) REFERENCES paios_l3_versions
);
CREATE TABLE paios_l3_invalidations (
 principal_id text NOT NULL, assertion_id text NOT NULL, version integer NOT NULL,
 command_id text NOT NULL, reason text NOT NULL,
 PRIMARY KEY(principal_id, assertion_id, version, command_id),
 FOREIGN KEY(principal_id, assertion_id, version) REFERENCES paios_l3_versions,
 FOREIGN KEY(principal_id, command_id) REFERENCES paios_l3_receipts DEFERRABLE INITIALLY DEFERRED
);
CREATE SEQUENCE paios_l3_watermark;
CREATE FUNCTION paios_l3_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'L3 immutable row'; END $$;
CREATE TRIGGER l3_versions_immutable BEFORE UPDATE OR DELETE ON paios_l3_versions FOR EACH ROW EXECUTE FUNCTION paios_l3_immutable_guard();
CREATE TRIGGER l3_receipts_immutable BEFORE UPDATE OR DELETE ON paios_l3_receipts FOR EACH ROW EXECUTE FUNCTION paios_l3_immutable_guard();
CREATE TRIGGER l3_invalidations_immutable BEFORE UPDATE OR DELETE ON paios_l3_invalidations FOR EACH ROW EXECUTE FUNCTION paios_l3_immutable_guard();
CREATE TRIGGER l3_dependencies_immutable BEFORE UPDATE OR DELETE ON paios_l3_dependencies FOR EACH ROW EXECUTE FUNCTION paios_l3_immutable_guard();
