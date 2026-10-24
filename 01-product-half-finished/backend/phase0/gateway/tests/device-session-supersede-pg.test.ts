import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import { createRealtimeAuthorityRepository } from '../../../services/platform-data/src/realtime-authority-repository.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import { RealtimeSessionService } from '../../../services/realtime-core/src/realtime-session-service.ts';
import { assertCanonicalTimestamp, assertDecimalConnectionEpoch, type CanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import type { LeasePolicyPort } from '../../../services/realtime-core/src/ports.ts';
import { createRuntimeCurrentBindingProvider } from '../src/apple-production-enrollment-owner.ts';
import { DEVICE_SESSION_PURPOSE } from '../src/paired-device-authority.ts';

// G-04: an app killed mid-session never sends its Stop; the next explicit Start must leave exactly one current session,
// or the Watch's current-binding read (the real consumer) is ambiguous forever.
const databaseUrl = process.env.PAIOS_FORMAL_SOURCE_TEST_DATABASE_URL;
const connect = (url: string) => { const value = new URL(url); return createPostgresPool({ host: value.hostname, port: Number(value.port), database: value.pathname.slice(1), user: value.username, password: value.password, max: 4 }); };

test('a new Start supersedes the session the device still holds: one current binding for the Watch, no resurrection, late Stop harmless, concurrent Starts serialize', { skip: databaseUrl === undefined }, async () => {
  const admin = connect(databaseUrl!), name = 'supersede_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE DATABASE ' + name);
  const parsed = new URL(databaseUrl!); parsed.pathname = '/' + name;
  const pool = connect(parsed.href);
  try {
    const migrations = new URL('../../../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter((file) => file.endsWith('.up.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    let clockMs = Date.now() - 60_000;
    const at = (): CanonicalTimestamp => assertCanonicalTimestamp(new Date(clockMs).toISOString());
    const clock = { now: () => assertCanonicalTimestamp(new Date().toISOString()) };
    const identity = createProductionRealtimeIdentityPort({ clock }), equality = createProductionStructuralEquality();
    const user = identity.createConnectionId({ deviceId: 'supersede', requestId: 'user' });
    const device = identity.createConnectionId({ deviceId: user, requestId: 'device' });
    const policyRef = { ref_type: 'PolicyDecision', ref_id: identity.createConnectionId({ deviceId: device, requestId: 'policy' }), object_version: '1', canonical_payload_sha256: 'a'.repeat(64) };
    const policy: LeasePolicyPort = { evaluate: async (input) => ({ allowed: true, policyDecisionRef: policyRef, capabilities: input.capabilities, purpose: DEVICE_SESSION_PURPOSE,
      leaseExpiresAt: assertCanonicalTimestamp(new Date(Date.parse(input.occurredAt) + 24 * 3_600_000).toISOString()), revocable: true }) };
    const unused = { verify: async () => { throw new Error('UNUSED'); } };
    const service = new RealtimeSessionService({ repository: createRealtimeAuthorityRepository(pool), policy, activityAcceptance: unused as never,
      transportDisconnection: unused as never, identity, clock, equality });
    const watch = createRuntimeCurrentBindingProvider(pool, { userId: user, deviceId: device, principalRef: user });
    const startedAt = new Map<string, CanonicalTimestamp>();
    const start = (key: string) => { clockMs += 1_000; const occurredAt = startedAt.get(key) ?? at(); startedAt.set(key, occurredAt);
      return service.bootstrap({ requestId: key, idempotencyKey: key, mode: 'initial', userId: user, deviceId: device,
        capabilities: ['data'], purpose: DEVICE_SESSION_PURPOSE, occurredAt, governance: 'governance' as never }); };
    const current = async () => ((await watch.readCurrentBindingSnapshot!()) as { readonly binding: { readonly session: { readonly realtimeSessionRef: unknown } } } | undefined)?.binding.session.realtimeSessionRef;
    const session = async (ref: unknown) => (await pool.query("SELECT state, continuity_state, terminal_reason, binding->>'state' AS binding FROM realtime_sessions WHERE realtime_session_ref = $1::jsonb", [JSON.stringify(ref)])).rows[0];

    const first = await start('start-a');
    assert.deepEqual(await current(), first.realtimeSessionRef);
    // The app is killed: no Stop. The user starts again.
    const second = await start('start-b');
    assert.deepEqual(await current(), second.realtimeSessionRef, 'the Watch reads exactly the new session (was APPLE_ENROLLMENT_CURRENT_BINDING_CONFLICT)');
    assert.deepEqual(await session(first.realtimeSessionRef), { state: 'terminal', continuity_state: 'ended', terminal_reason: 'superseded_by_new_start', binding: 'released' });
    assert.equal((await pool.query("SELECT state FROM device_leases WHERE device_lease_ref = $1::jsonb", [JSON.stringify(first.deviceLeaseRef)])).rows[0].state, 'released');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'realtime.session.superseded' AND idempotency_key = 'start-b'")).rows[0].n, 1);
    // The old Start's retry is never resurrected as connection material.
    await assert.rejects(start('start-a'), /BOOTSTRAP_REPLAY_SESSION_ENDED/);
    assert.deepEqual(await current(), second.realtimeSessionRef, 'and the refused replay changed nothing');
    assert.equal((await start('start-b')).receipt.replayed, true, 'the live session still replays for its own retry');
    // The old app's late Stop cannot touch the new session.
    clockMs += 1_000;
    await assert.rejects(service.stop({ requestId: 'late-stop', idempotencyKey: 'late-stop', operation: 'media_stop', realtimeSessionRef: first.realtimeSessionRef,
      continuityId: first.continuityId, deviceLeaseRef: first.deviceLeaseRef, deviceId: device, expectedConnectionEpoch: assertDecimalConnectionEpoch(first.connectionEpoch),
      expectedLeaseVersion: '1' as never, reason: 'user_stop', occurredAt: at(), governance: 'governance' as never }));
    assert.deepEqual(await current(), second.realtimeSessionRef);
    assert.equal((await session(second.realtimeSessionRef)).binding, 'connected');
    // Two Starts at once: one winner, the other superseded; never two current sessions.
    const [third, fourth] = await Promise.all([start('start-c'), start('start-d')]);
    const winner = await current();
    assert.ok(equality.same(winner as never, third.realtimeSessionRef) || equality.same(winner as never, fourth.realtimeSessionRef));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM realtime_sessions WHERE active_device_id = $1::uuid AND state = 'active'", [device])).rows[0].n, 1);
    assert.equal((await session(second.realtimeSessionRef)).state, 'terminal');
  } finally {
    await pool.end();
    await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
    await admin.end();
  }
});
