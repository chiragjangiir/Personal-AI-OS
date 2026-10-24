-- Read-only verifier for a one-receipt, many-assertion forget closure.
SELECT to_regclass('public.paios_l3_forgotten') IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM pg_catalog.pg_constraint
 WHERE conrelid=to_regclass('public.paios_l3_forgotten')
 AND conname='paios_l3_forgotten_principal_id_command_id_key'
) AS complete, to_regclass('public.paios_l3_forgotten') IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM pg_catalog.pg_constraint
 WHERE conrelid=to_regclass('public.paios_l3_forgotten')
 AND conname='paios_l3_forgotten_principal_id_command_id_key'
) AS touched;
