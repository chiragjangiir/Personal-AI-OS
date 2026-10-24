-- One forget command erases all versions in its historical dependency closure.
-- Per-assertion tombstones and the deferred durable receipt reference remain authoritative.
BEGIN;
ALTER TABLE paios_l3_forgotten
 DROP CONSTRAINT paios_l3_forgotten_principal_id_command_id_key;
COMMIT;
