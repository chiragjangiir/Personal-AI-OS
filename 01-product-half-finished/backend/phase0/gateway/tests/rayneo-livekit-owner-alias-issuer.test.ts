import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertRayneoLiveKitOwnerAliasReceipt,
  createProductionRayneoLiveKitOwnerAliasIssuer,
  type RayneoLiveKitOwnerAliasIssueInput,
} from '../src/rayneo-livekit-owner-alias-issuer.ts';

const INPUT: RayneoLiveKitOwnerAliasIssueInput = Object.freeze({
  livekitServerUrl: 'wss://livekit.example.test',
  livekitClientUrl: 'wss://livekit.example.test',
  grantRoom: 'actual-room-from-grant',
  participantSubject: 'actual-participant-subject',
  sessionId: 'phase0_session_aaaaaaaaaaaaaaaaaaaa',
  deviceId: 'rayneo_device_bbbbbbbbbbbbbbbbbbbb',
  clientInstanceId: 'rayneo_client_cccccccccccccccccccc',
  issuedAt: '2026-08-29T10:00:00.000Z',
  tokenExpiresAt: '2026-08-29T10:02:00.000Z',
  participantTokenSha256: 'a'.repeat(64),
});

test('owner alias issuer cryptographically issues four opaque aliases and exact replay', () => {
  const issuer = createProductionRayneoLiveKitOwnerAliasIssuer({
    randomBytes: (size) => {
      assert.equal(size, 96);
      return Buffer.alloc(size, 7);
    },
  });
  const first = issuer.issue(INPUT);
  assert.equal(first.kind, 'paios.rayneo.livekit-owner-alias.v1');
  assert.equal(first.objectVersion, '1');
  assert.deepEqual(first, issuer.issue({ ...INPUT }));
  assert.deepEqual(assertRayneoLiveKitOwnerAliasReceipt(first, INPUT), first);
  assert.equal(first.aliases.tokenExpiresAt, INPUT.tokenExpiresAt);
  assert.equal(new Set([
    first.aliases.provider,
    first.aliases.sessionAlias,
    first.aliases.roomAlias,
    first.aliases.participantAlias,
  ]).size, 4);
  assert.deepEqual(Object.keys(first).sort(), ['aliases', 'canonicalPayloadSha256', 'kind', 'objectVersion']);
  assert.deepEqual(Object.keys(first.aliases).sort(), [
    'participantAlias', 'provider', 'roomAlias', 'sessionAlias', 'tokenExpiresAt',
  ]);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /actual-room-from-grant|actual-participant-subject|phase0_session_|rayneo_device_|rayneo_client_|aaaaaaaa/u);
});

test('owner alias issuer rejects input/hash drift and closes after Stop', () => {
  const issuer = createProductionRayneoLiveKitOwnerAliasIssuer({ randomBytes: (size) => Buffer.alloc(size, 3) });
  const first = issuer.issue(INPUT);
  assert.throws(() => issuer.issue({ ...INPUT, grantRoom: 'different-room' }), /ISSUANCE_DRIFT/u);
  assert.throws(() => assertRayneoLiveKitOwnerAliasReceipt(first, { ...INPUT, participantSubject: 'different-subject' }), /HASH_INVALID/u);
  assert.throws(() => issuer.issue({ ...INPUT, tokenExpiresAt: '2026-08-29T09:59:00.000Z' }), /TIME_INVALID/u);
  assert.throws(() => issuer.issue({ ...INPUT, participantTokenSha256: 'b'.repeat(64) }), /ISSUANCE_DRIFT/u);
  issuer.clear();
  assert.throws(() => issuer.issue(INPUT), /ISSUER_CLOSED/u);
});

test('owner alias issuer has no ambient identity or JWT/body retention path', () => {
  const source = readFileSync(new URL('../src/rayneo-livekit-owner-alias-issuer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, ''), /process\.env|randomUUID|livekit_token|new Map/u);
  assert.equal(typeof createProductionRayneoLiveKitOwnerAliasIssuer, 'function');
});
