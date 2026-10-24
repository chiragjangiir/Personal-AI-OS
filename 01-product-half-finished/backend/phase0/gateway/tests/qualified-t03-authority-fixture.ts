import { T03_APPLE_CYCLING_AUTHORITY_SCHEMA, T03_APPLE_CYCLING_PURPOSE } from '../src/t03-apple-cycling-lease-authority.ts';

const id = (suffix: string) => `01952f00-0000-7000-8000-000000000${suffix}`;
const ref = (ref_type: string, suffix: string, fill: string) => ({
  ref_type, ref_id: id(suffix), object_version: '1', canonical_payload_sha256: fill.repeat(64),
});

// The complete T03 contract is shared by producer and consumer fixtures.
// Callers may override fields to exercise a specific failure or binding.
export function qualifiedT03AuthorityFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const operations = ['bootstrap', 'realtime_e2ee_key_resolve', 'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff'];
  return {
    schema: T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
    grant_id: id('507'), issued_at_utc: '2030-01-01T00:00:00.000Z',
    expires_at_utc: '2030-01-02T00:00:00.000Z', lease_expires_at_utc: '2030-01-01T04:00:00.000Z',
    user_id: id('501'), device_id: id('502'), principal_ref: id('501'),
    capability_ref: ref('CapabilityGrant', '511', '6'),
    scopes: operations, operation_scopes: operations, purpose: T03_APPLE_CYCLING_PURPOSE,
    allowed_media_capabilities: ['audio', 'video', 'data'],
    governance: {
      purpose_scopes: [T03_APPLE_CYCLING_PURPOSE],
      consent_record_refs: [ref('ConsentRecord', '509', '4')],
      policy_decision_refs: [ref('PolicyDecision', '508', '3')],
      purpose_token_refs: [ref('PurposeToken', '510', '5')],
      capability_grant_refs: [ref('CapabilityGrant', '511', '6')],
    },
  consent: {
    watch_workout_metrics: ['heart_rate', 'active_energy'],
    iphone_motion: ['speed', 'location'],
    navigation: 'user_toggle',
    audio_capture: 'explicit_wake_or_tap_only',
    video_capture: 'explicit_wake_or_tap_only',
    background_health: 'platform_authorized',
    background_location: 'platform_authorized',
  },
    revocable: true,
    ...overrides,
  };
}
