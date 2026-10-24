import { configuredPublicApiOrigin } from './public-api-origins.ts';
import { assertAppleFormalWatchBindingReceipt } from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import { createHash } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

const SCHEMA = 'paios.realtime-production-enrollment-bundle.v1' as const;
// Legacy enrollment uses this schema; paired-device enrollment uses configured public_api_url.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ROUTES: Readonly<Record<string, string>> = Object.freeze({
  bootstrap: '/v1/realtime/bootstrap',
  realtime_e2ee_key_resolve: '/v1/realtime/e2ee/key/resolve',
  connected_credential_refresh: '/v1/realtime/credentials/refresh',
  media_stop: '/v1/realtime/media/stop',
  end_continuity: '/v1/realtime/end-continuity',
});
const REQUIRED_BODIES = Object.freeze([
  'bootstrap', 'connected_credential_refresh', 'end_continuity', 'media_stop', 'realtime_e2ee_key_resolve',
] as const);

function fail(code: string): never {
  throw new Error(code);
}

function plain(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: unknown, keys: readonly string[], code: string): JsonRecord {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
  return value;
}

function cvr(value: unknown, expectedType: string, code: string): JsonRecord {
  const ref = exact(value, ['canonical_payload_sha256', 'object_version', 'ref_id', 'ref_type'], code);
  if (ref.ref_type !== expectedType || typeof ref.ref_id !== 'string' || !UUID_V7.test(ref.ref_id) ||
      typeof ref.object_version !== 'string' || !DECIMAL.test(ref.object_version) ||
      typeof ref.canonical_payload_sha256 !== 'string' || !SHA256.test(ref.canonical_payload_sha256)) fail(code);
  return ref;
}

function parseBytes(bytes: Uint8Array, code: string): JsonRecord {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 131_072) fail(code);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(`${code}_ENCODING`); }
  if (text.charCodeAt(0) === 0xfeff || text.includes('\r') || text.trim() !== text) fail(`${code}_ENCODING`);
  try {
    const value: unknown = JSON.parse(text);
    if (!plain(value)) fail(`${code}_JSON`);
    return value;
  }
  catch (error) { if (error instanceof Error && error.message.startsWith(code)) throw error; fail(`${code}_JSON`); }
}

export function validateAppleProductionEnrollmentBundle(bytes: Uint8Array): JsonRecord {
  const bundle = parseBundle(bytes);
  const bodies = bundle.canonical_bodies as JsonRecord;
  for (const operation of Object.keys(bodies)) {
    const entry = exact(bodies[operation], ['body_base64', 'body_sha256', 'route'], 'APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
    if (entry.route !== ROUTES[operation] || typeof entry.body_base64 !== 'string' || !BASE64.test(entry.body_base64) ||
        typeof entry.body_sha256 !== 'string' || !SHA256.test(entry.body_sha256)) fail('APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
    const bodyBytes = Buffer.from(entry.body_base64, 'base64');
    try {
      if (bodyBytes.byteLength < 2 || bodyBytes.byteLength > 131_072 ||
          bodyBytes.toString('base64') !== entry.body_base64 ||
          createHash('sha256').update(bodyBytes).digest('hex') !== entry.body_sha256) {
        fail('APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
      }
      const body = parseBytes(bodyBytes, 'APPLE_ENROLLMENT_BUNDLE_BODY');
      if (body.operation !== operation) fail('APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
    } finally { bodyBytes.fill(0); }
  }
  return bundle;
}

function parseBundle(bytes: Uint8Array): JsonRecord {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 131_072) fail('APPLE_ENROLLMENT_BUNDLE_INVALID');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('APPLE_ENROLLMENT_BUNDLE_ENCODING_INVALID'); }
  if (text.charCodeAt(0) === 0xfeff || text.includes('\r') || text.trim() !== text) fail('APPLE_ENROLLMENT_BUNDLE_ENCODING_INVALID');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail('APPLE_ENROLLMENT_BUNDLE_JSON_INVALID'); }
  const bundle = exact(parsed, [...(plain(parsed) && Object.hasOwn(parsed, 'formal_watch_binding') ? ['formal_watch_binding'] : []), ...(plain(parsed) && Object.hasOwn(parsed, 'formal_watch_pair_state') ? ['formal_watch_pair_state'] : []), 'binding', 'canonical_bodies', 'credential_ref', 'expires_at', 'origin', 'schema'], 'APPLE_ENROLLMENT_BUNDLE_SCHEMA_INVALID');
  if (bundle.schema !== SCHEMA || bundle.origin !== configuredPublicApiOrigin() || typeof bundle.expires_at !== 'string' || !Number.isFinite(Date.parse(bundle.expires_at))) fail('APPLE_ENROLLMENT_BUNDLE_SCHEMA_INVALID');
  cvr(bundle.credential_ref, 'DeviceCredential', 'APPLE_ENROLLMENT_BUNDLE_CREDENTIAL_INVALID');
  const binding = exact(bundle.binding, ['connection_epoch', 'continuity_id', 'device_lease_ref', 'realtime_session_ref'], 'APPLE_ENROLLMENT_BUNDLE_BINDING_INVALID');
  cvr(binding.realtime_session_ref, 'RealtimeSession', 'APPLE_ENROLLMENT_BUNDLE_SESSION_INVALID');
  cvr(binding.device_lease_ref, 'DeviceLease', 'APPLE_ENROLLMENT_BUNDLE_LEASE_INVALID');
  if (typeof binding.continuity_id !== 'string' || !UUID_V7.test(binding.continuity_id) ||
      typeof binding.connection_epoch !== 'string' || !DECIMAL.test(binding.connection_epoch)) fail('APPLE_ENROLLMENT_BUNDLE_BINDING_INVALID');
  if (bundle.formal_watch_pair_state !== undefined) {
    const pair = exact(bundle.formal_watch_pair_state, ['pair_version', 'status', 'requires_rebind'], 'APPLE_ENROLLMENT_FORMAL_PAIR_STATE_INVALID');
    if (typeof pair.pair_version !== 'string' || !/^(0|[1-9][0-9]{0,37})$/u.test(pair.pair_version) ||
        !['absent', 'active', 'revoked'].includes(String(pair.status)) || typeof pair.requires_rebind !== 'boolean' ||
        (pair.status === 'absent' ? pair.pair_version !== '0' || pair.requires_rebind : pair.pair_version === '0') ||
        (pair.status === 'revoked' && !pair.requires_rebind) ||
        (bundle.formal_watch_binding !== undefined && (pair.status !== 'active' || pair.requires_rebind))) fail('APPLE_ENROLLMENT_FORMAL_PAIR_STATE_INVALID');
  }
  if (bundle.formal_watch_binding !== undefined) {
    const formal = assertAppleFormalWatchBindingReceipt(bundle.formal_watch_binding);
    const pair = bundle.formal_watch_pair_state as JsonRecord | undefined;
    if (pair !== undefined && pair.pair_version !== formal.pairVersion) fail('APPLE_ENROLLMENT_FORMAL_PAIR_STATE_INVALID');
    if (formal.status !== 'active' || !['ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'].every(key => (formal.realtimeSessionRef as unknown as JsonRecord)[key] === (binding.realtime_session_ref as JsonRecord)[key]) ||
        !['ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'].every(key => (formal.iphone.deviceLeaseRef as unknown as JsonRecord)[key] === (binding.device_lease_ref as JsonRecord)[key])) fail('APPLE_ENROLLMENT_FORMAL_WATCH_BINDING_INVALID');
  }
  if (!plain(bundle.canonical_bodies)) fail('APPLE_ENROLLMENT_BUNDLE_BODIES_INVALID');
  const bodies = bundle.canonical_bodies;
  const names = Object.keys(bodies);
  if (REQUIRED_BODIES.some((name) => !names.includes(name)) || names.some((name) => !REQUIRED_BODIES.includes(name as typeof REQUIRED_BODIES[number]))) fail('APPLE_ENROLLMENT_BUNDLE_BODIES_INVALID');
  return bundle;
}
