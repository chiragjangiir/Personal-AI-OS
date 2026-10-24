BEGIN;
ALTER TABLE realtime_terminal_facts DROP CONSTRAINT realtime_terminal_facts_operation_ck;
ALTER TABLE realtime_terminal_facts ADD CONSTRAINT realtime_terminal_facts_operation_ck
  CHECK (operation IN (
    'bootstrap', 'connected_refresh', 'fully_disconnected_refresh',
    'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff',
    'reconnect', 'lease_release', 'realtime_e2ee_key_resolve', 'device_lease_renewal'
  ));
COMMIT;
