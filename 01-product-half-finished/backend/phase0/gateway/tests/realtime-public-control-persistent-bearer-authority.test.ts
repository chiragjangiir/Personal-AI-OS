import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { RealtimeOperation } from '../src/realtime-public-control-runtime.ts';
import type {
  PersistentPublicOwnerProtectionPort,
  PersistentPublicSecretFileReader,
} from '../src/realtime-public-control-persistent-public-ports.ts';
import {
  PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH,
  PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA,
  PersistentPublicBearerAuthorityError,
  createPersistentPublicBearerAuthority,
} from '../src/realtime-public-control-persistent-bearer-authority.ts';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const ISSUED = '2029-12-31T23:00:00.000Z';
const EXPIRES = '2030-01-01T01:00:00.000Z';
const TOKEN_A = sha256('owner-issued-token-a');
const TOKEN_B = sha256('owner-issued-token-b');
const ALL_OPERATIONS: readonly RealtimeOperation[] = Object.freeze([
  'bootstrap',
  'realtime_e2ee_key_resolve',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
]);

type MutableRecord = Record<string, unknown>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validRecord(overrides: MutableRecord = {}): MutableRecord {
  return {
    schema: PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA,
    grant_id: 'grant:cycling-owner:1',
    issued_at_utc: ISSUED,
    expires_at_utc: EXPIRES,
    token_sha256: TOKEN_A,
    principal_ref: { ref_type: 'User', ref_id: 'owner-opaque' },
    device_id: 'iphone-cycling-owner',
    capability_ref: { ref_type: 'CapabilityGrant', ref_id: 'capability-opaque' },
    scopes: [...ALL_OPERATIONS],
    issuer_ref: { ref_type: 'AuthorityIssuer', ref_id: 'issuer-opaque' },
    ...overrides,
  };
}

function fixture(options: {
  record?: MutableRecord;
  bytes?: () => Buffer;
  regular?: boolean;
  reparse?: boolean;
  protected?: boolean;
  inspectError?: Error;
  readError?: Error;
  now?: () => number;
} = {}) {
  let current = options.record ?? validRecord();
  const inspected: string[] = [];
  const read: string[] = [];
  const fileReader: PersistentPublicSecretFileReader = {
    inspect(path) {
      inspected.push(path);
      if (options.inspectError !== undefined) throw options.inspectError;
      return { regular: options.regular !== false, reparse: options.reparse === true };
    },
    read(path) {
      read.push(path);
      if (options.readError !== undefined) throw options.readError;
      return options.bytes?.() ?? Buffer.from(JSON.stringify(current), 'utf8');
    },
  };
  const ownerProtection: PersistentPublicOwnerProtectionPort = {
    isOwnerProtected: () => options.protected !== false,
  };
  const authority = createPersistentPublicBearerAuthority({
    fileReader,
    ownerProtection,
    now: options.now ?? (() => NOW),
  });
  return {
    authority,
    inspected,
    read,
    replace(record: MutableRecord) { current = record; },
  };
}

test('valid owner record maps the exact closed snapshot for all six operations', async () => {
  const { authority, inspected, read } = fixture();
  assert.equal(authority.isReady(), true);
  for (const operation of ALL_OPERATIONS) {
    const snapshot = await authority.resolve({ tokenSha256: TOKEN_A, operation });
    assert.deepEqual(snapshot, {
      tokenSha256: TOKEN_A,
      principal: { ref_type: 'User', ref_id: 'owner-opaque' },
      deviceId: 'iphone-cycling-owner',
      capabilityRef: { ref_type: 'CapabilityGrant', ref_id: 'capability-opaque' },
      expiresAt: EXPIRES,
      scopes: ALL_OPERATIONS,
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot?.principal), true);
    assert.equal(Object.isFrozen(snapshot?.capabilityRef), true);
    assert.equal(Object.isFrozen(snapshot?.scopes), true);
  }
  assert.ok(inspected.every((path) => path === PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH));
  assert.ok(read.every((path) => path === PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH));
});

test('digest mismatch and absent scope are unauthorized, while atomic replacement rotates without restart', async () => {
  const state = fixture({ record: validRecord({ scopes: ['bootstrap'] }) });
  assert.equal(await state.authority.resolve({ tokenSha256: TOKEN_A, operation: 'place_upload' }), undefined);
  assert.equal(await state.authority.resolve({ tokenSha256: TOKEN_B, operation: 'bootstrap' }), undefined);
  assert.equal(await state.authority.resolve({ tokenSha256: TOKEN_A, operation: 'media_stop' }), undefined);
  assert.equal((await state.authority.resolve({ tokenSha256: TOKEN_A, operation: 'bootstrap' }))?.deviceId, 'iphone-cycling-owner');

  state.replace(validRecord({
    grant_id: 'grant:cycling-owner:2',
    token_sha256: TOKEN_B,
    device_id: 'iphone-cycling-owner-rotated',
    scopes: ['bootstrap', 'media_stop'],
  }));
  assert.equal(await state.authority.resolve({ tokenSha256: TOKEN_A, operation: 'bootstrap' }), undefined);
  assert.equal((await state.authority.resolve({ tokenSha256: TOKEN_B, operation: 'media_stop' }))?.deviceId,
    'iphone-cycling-owner-rotated');
});

test('closed authority fences readiness and all subsequent resolution', async () => {
  const { authority } = fixture();
  assert.equal(authority.isReady(), true);
  await authority.close?.();
  assert.equal(authority.isReady(), false);
  await assert.rejects(
    authority.resolve({ tokenSha256: TOKEN_A, operation: 'bootstrap' }),
    (error: unknown) => error instanceof PersistentPublicBearerAuthorityError &&
      error.code === 'PERSISTENT_BEARER_AUTHORITY_CLOSED',
  );
  await authority.close?.();
});

test('record shape, identity, time, and scope drift all fail closed', async (context) => {
  const cases: readonly [string, () => MutableRecord][] = [
    ['wrong schema', () => validRecord({ schema: 'wrong' })],
    ['missing key', () => { const value = validRecord(); delete value.grant_id; return value; }],
    ['extra key', () => validRecord({ extra: true })],
    ['bad grant', () => validRecord({ grant_id: 'bad grant' })],
    ['uppercase hash', () => validRecord({ token_sha256: TOKEN_A.toUpperCase() })],
    ['bad device', () => validRecord({ device_id: 'bad device' })],
    ['future issued', () => validRecord({ issued_at_utc: '2030-01-01T00:00:00.001Z' })],
    ['expired', () => validRecord({ expires_at_utc: '2030-01-01T00:00:00.000Z' })],
    ['noncanonical issued', () => validRecord({ issued_at_utc: '2029-12-31T23:00:00Z' })],
    ['empty scopes', () => validRecord({ scopes: [] })],
    ['duplicate scope', () => validRecord({ scopes: ['bootstrap', 'bootstrap'] })],
    ['unknown scope', () => validRecord({ scopes: ['bootstrap', 'unknown'] })],
    ['null principal', () => validRecord({ principal_ref: null })],
    ['null issuer', () => validRecord({ issuer_ref: null })],
    ['null capability', () => validRecord({ capability_ref: null })],
  ];
  for (const [name, makeRecord] of cases) {
    await context.test(name, async () => {
      const { authority } = fixture({ record: makeRecord() });
      assert.equal(authority.isReady(), false);
      await assert.rejects(authority.resolve({ tokenSha256: TOKEN_A, operation: 'bootstrap' }),
        PersistentPublicBearerAuthorityError);
    });
  }
});

test('file, encoding, and protection failures are closed without leaking owner details', async (context) => {
  const secretDetail = 'must-not-escape-owner-record-or-token';
  const cases: readonly [string, Parameters<typeof fixture>[0]][] = [
    ['not regular', { regular: false }],
    ['reparse', { reparse: true }],
    ['not owner protected', { protected: false }],
    ['inspect unavailable', { inspectError: new Error(secretDetail) }],
    ['read unavailable', { readError: new Error(secretDetail) }],
    ['malformed json', { bytes: () => Buffer.from(`{"secret":"${secretDetail}"`, 'utf8') }],
    ['utf8 bom', { bytes: () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]) }],
    ['invalid utf8', { bytes: () => Buffer.from([0xc3, 0x28]) }],
    ['oversized', { bytes: () => Buffer.alloc(16_385, 0x20) }],
  ];
  for (const [name, options] of cases) {
    await context.test(name, async () => {
      const { authority } = fixture(options);
      assert.equal(authority.isReady(), false);
      let message = '';
      try {
        await authority.resolve({ tokenSha256: TOKEN_A, operation: 'bootstrap' });
      } catch (error) {
        message = String(error);
      }
      assert.match(message, /^PersistentPublicBearerAuthorityError: PERSISTENT_BEARER_AUTHORITY_/u);
      assert.doesNotMatch(message, new RegExp(secretDetail, 'u'));
      assert.doesNotMatch(message, /owner-issued-token/u);
    });
  }
});

test('invalid construction and invalid direct resolution input cannot create authority', async () => {
  assert.throws(
    () => createPersistentPublicBearerAuthority({} as never),
    /PERSISTENT_BEARER_AUTHORITY_OPTIONS_INVALID/u,
  );
  const { authority } = fixture();
  assert.equal(await authority.resolve({ tokenSha256: 'not-a-hash', operation: 'bootstrap' }), undefined);
  assert.equal(await authority.resolve({ tokenSha256: TOKEN_A, operation: 'invalid' as RealtimeOperation }), undefined);
});
