-- Restore only before the first forget. Never invent erased values.
BEGIN;
LOCK TABLE paios_l3_versions,paios_l3_receipts,paios_l3_payloads,paios_l3_forgotten IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM paios_l3_forgotten) OR
 (SELECT count(*) FROM paios_l3_payloads)<>(SELECT count(*) FROM paios_l3_versions)
 THEN RAISE EXCEPTION 'L3_ERASURE_ROLLBACK_UNAVAILABLE'; END IF;
END $$;
ALTER TABLE paios_l3_versions DISABLE TRIGGER l3_versions_immutable;
ALTER TABLE paios_l3_receipts DISABLE TRIGGER l3_receipts_immutable;
ALTER TABLE paios_l3_versions DROP CONSTRAINT l3_version_audit_shape;
ALTER TABLE paios_l3_receipts DROP CONSTRAINT l3_command_audit_shape;
UPDATE paios_l3_versions v SET audit=p.assertion_payload FROM paios_l3_payloads p
 WHERE (v.principal_id,v.assertion_id,v.version)=(p.principal_id,p.assertion_id,p.version);
UPDATE paios_l3_receipts r SET command_audit=p.command_payload FROM paios_l3_payloads p
 WHERE r.principal_id=p.principal_id AND r.command_id=p.command_payload->>'command_id';
ALTER TABLE paios_l3_versions RENAME COLUMN audit TO payload;
ALTER TABLE paios_l3_receipts RENAME COLUMN command_audit TO command_payload;
ALTER TABLE paios_l3_versions ENABLE TRIGGER l3_versions_immutable;
ALTER TABLE paios_l3_receipts ENABLE TRIGGER l3_receipts_immutable;
DROP TABLE paios_l3_forgotten,paios_l3_payloads;
COMMIT;
