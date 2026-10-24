-- The unique constraint can be restored only before any multi-assertion forget.
BEGIN;
ALTER TABLE paios_l3_forgotten
 ADD CONSTRAINT paios_l3_forgotten_principal_id_command_id_key UNIQUE(principal_id,command_id);
COMMIT;
