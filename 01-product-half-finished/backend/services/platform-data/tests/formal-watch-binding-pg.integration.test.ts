// Enrollment uses the same explicitly configured origin as the fictional product fixture.
process.env.PAIOS_PUBLIC_API_URL = 'https://ai.example.invalid';
import { Readable } from 'node:stream';
import { RealtimePublicControlController } from '../../../phase0/gateway/src/realtime-public-control-controller.ts';
import { RealtimePublicControlRuntime } from '../../../phase0/gateway/src/realtime-public-control-runtime.ts';
import { validateAppleProductionEnrollmentBundle } from '../../../phase0/gateway/src/apple-production-enrollment-bundle.ts';
import { createRuntimeCurrentBindingProvider } from '../../../phase0/gateway/src/apple-production-enrollment-owner.ts';
import { T03_APPLE_CYCLING_PURPOSE } from '../../../phase0/gateway/src/t03-apple-cycling-lease-authority.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createPostgresPool } from '../src/postgres-pool.ts';
import { createProductionRealtimeIdentityPort } from '../src/realtime-identity-issuer.ts';
import { createProductionRealtimeCanonicalDeviceIdentityIssuer } from '../src/realtime-canonical-device-issuer.ts';
import { createApplePhysicalCanaryBindingPostgres, type AppleFormalWatchMutationInput } from '../src/apple-physical-canary-binding-postgres.ts';
import { withTransaction } from '../src/transaction.ts';
const url = process.env.PAIOS_WATCH_TEST_DATABASE_URL;
const connect = (value: string) => { const u = new URL(value); return createPostgresPool({ host: u.hostname, port: Number(u.port), database: u.pathname.slice(1), user: u.username, password: u.password, max: 5 }); };
const identity = () => createProductionRealtimeIdentityPort({ clock: { now: () => new Date().toISOString() as never } });
const owner = (pool: ReturnType<typeof connect>) => createApplePhysicalCanaryBindingPostgres({ pool, identity: identity(), canonicalDeviceIssuer: createProductionRealtimeCanonicalDeviceIdentityIssuer(), formalPrimaryAuthority: { resolve: async value => value as never } });
if (process.env.PAIOS_WATCH_CHILD) {
  const params = JSON.parse(process.env.PAIOS_WATCH_CHILD);
  const pool = connect(params.url);
  try { process.stdout.write(JSON.stringify(await owner(pool).mutateFormal(params.input, params.auth))); }
  finally { await pool.end(); }
} else test('formal Watch PostgreSQL source owner: identity, CAS, rollback, revoke, snapshot, process replay', { skip: url === undefined }, async () => {
  assert.equal(new URL(url!).hostname, '127.0.0.1'); assert.equal(new URL(url!).port, '55439');
  const admin = connect(url!); const name = 'formal_watch_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE DATABASE ' + name);
  const target = new URL(url!); target.pathname = '/' + name;
  const pool = connect(target.href); const api = owner(pool); const issuer = identity();
  const device = issuer.createConnectionId({ deviceId: 'fixture', requestId: 'primary' });
  const userId = issuer.createConnectionId({ deviceId: device, requestId: 'user' });
  const continuity = issuer.createContinuityId({ userId, requestId: 'continuity' });
  const session = issuer.createSessionRef({ continuityId: continuity, userId, requestId: 'session' });
  const lease = issuer.createDeviceLeaseRef({ sessionRef: session, deviceId: device, requestId: 'lease' });
  const sid = (session as any).ref_id; const lid = (lease as any).ref_id;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const auth = { userId, deviceId: device, principalRef: 'fixture-principal-distinct-from-user', expiresAt, purpose: T03_APPLE_CYCLING_PURPOSE, policyDecisionRef: {}, capabilities: ['data'] };
  const make = (id: string, action: 'register' | 'replace' | 'revoke', expectedPairVersion: string): AppleFormalWatchMutationInput => ({
    action, requestId: id, idempotencyKey: id, realtimeSessionRef: session, iphoneDeviceLeaseRef: lease, expectedPairVersion,
    ...(action === 'revoke' ? {} : { installationId: randomUUID(), ttlSeconds: 600 }),
  });
  const child = async (input: AppleFormalWatchMutationInput) => {
    const proc = spawn(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, PAIOS_WATCH_CHILD: JSON.stringify({ url: target.href, input, auth }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; proc.stdout.on('data', (c) => output += c); proc.stderr.on('data', (c) => errors += c);
    const code = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
    assert.equal(code, 0, errors); return JSON.parse(output);
  };
  try {
    const files = (await readdir(new URL('../../../migrations/', import.meta.url))).filter(f => f.endsWith('.up.sql')).sort();
    for (const file of files) await pool.query(await readFile(new URL('../../../migrations/' + file, import.meta.url), 'utf8'));
    await pool.query(`INSERT INTO realtime_sessions(session_ref_id,realtime_session_ref,session_object_version,session_payload_sha256,user_id,continuity_id,continuity_ref,active_device_lease_ref,active_device_id,binding,state,connection_epoch,continuity_expires_at)
      VALUES($1,$2,'1',$3,$4,$5,'{}',$6,$7,'{"state":"connected"}','active',1,$8)`, [sid, session, (session as any).canonical_payload_sha256, userId, continuity, lease, device, expiresAt]);
    await pool.query(`INSERT INTO device_leases(lease_ref_id,device_lease_ref,lease_object_version,lease_payload_sha256,session_ref_id,realtime_session_ref,continuity_ref,user_id,device_id,continuity_id,capabilities,purpose,policy_decision_ref,capability_scope,purpose_scope,policy_binding,state,lease_version,fencing_token,issued_at,acquired_at,expires_at)
      VALUES($1,$2,'1',$3,$4,$5,'{}',$6,$7,$8,'["data"]','${T03_APPLE_CYCLING_PURPOSE}','{}','{}','{}','{}','active',1,1,now(),now(),$9)`, [lid, lease, (lease as any).canonical_payload_sha256, sid, session, userId, device, continuity, expiresAt]);
    await pool.query('UPDATE realtime_sessions SET last_accepted_activity_at=now() WHERE session_ref_id=$1', [sid]);
    const enrollmentProjection = createRuntimeCurrentBindingProvider(pool, { userId, deviceId: device, principalRef: auth.principalRef });
    const canary = await api.issue({ requestId: 'legacy-canary', idempotencyKey: 'legacy-canary', realtimeSessionRef: session, iphoneDeviceLeaseRef: lease,
      iphoneCoreDeviceId: randomUUID(), iphoneLocalClientInstanceId: randomUUID(), watchCoreDeviceId: randomUUID(), watchLocalClientInstanceId: randomUUID(), ttlSeconds: 500 });
    assert.equal(canary.kind, 't02.apple.physical-canary-binding.v1');
    assert.equal(await withTransaction(pool, c => api.readFormalByPrimaryInTransaction(c, { realtimeSessionRef: session, iphoneDeviceLeaseRef: lease }), { isolation: 'REPEATABLE READ', readOnly: true }), undefined);
    const beforeFormal = await enrollmentProjection.readCurrentBindingSnapshot!();
    assert.equal((beforeFormal as any).formalWatchBinding, undefined);
    assert.deepEqual((beforeFormal as any).formalWatchPairState, { pairVersion: "0", status: "absent", requiresRebind: false });
    assert.equal((beforeFormal as any).handoffDeviceId, undefined);
    const initial = make('formal-initial', 'register', '0');
    await assert.rejects(api.mutateFormal(initial, { ...auth, userId: issuer.createConnectionId({ deviceId: device, requestId: 'wrong-user' }) }), /AUTHORITY_MISMATCH/);
    await assert.rejects(api.mutateFormal(initial, { ...auth, deviceId: userId }), /AUTHORITY_MISMATCH/);
    await assert.rejects(api.mutateFormal({ ...initial, iphoneDeviceLeaseRef: { ...(lease as Record<string, unknown>), canonical_payload_sha256: 'a'.repeat(64) } as never }, auth), /LEASE_INVALID/);
    let bootstrapCalls = 0;
    const unused = async () => { bootstrapCalls += 1; throw new Error('UNEXPECTED_SESSION_OPERATION'); };
    const routeOwner = createApplePhysicalCanaryBindingPostgres({ pool, identity: identity(), canonicalDeviceIssuer: createProductionRealtimeCanonicalDeviceIdentityIssuer(),
      formalPrimaryAuthority: { resolve: async bearer => { assert.deepEqual(bearer, { principal: auth.principalRef, deviceId: device }); return auth; } } });
    const runtime = new RealtimePublicControlRuntime({ watchBinding: routeOwner,
      governance: { evaluate: unused }, sessions: { bootstrap: unused, refresh: unused, endContinuity: unused },
      mediaStop: { claim: unused, complete: unused }, e2ee: { issue: unused }, e2eeCiphertext: { resolve: unused },
      tokenSigner: { assertProjectUrl() {}, sign: unused, close() {} },
      participant: { connect: unused, disconnect: unused, snapshot: () => ({ connected: false, transportState: 'disconnected' }), close: async () => undefined } } as never);
    const controller = new RealtimePublicControlController({ enabled: true, controlHost: 'ai.example.invalid', runtime,
      edge: { authorize: async () => undefined }, bearer: { authorize: async input => {
        assert.equal(input.operation, 'bootstrap'); assert.equal(input.request.operation, 'watch_binding');
        return { principal: auth.principalRef, deviceId: device }; } } });
    const route = async (mutation: AppleFormalWatchMutationInput | undefined, extra: Record<string, unknown> = {}, authenticated = true) => {
      const wire = { operation: 'watch_binding', realtime_session_ref: session, iphone_device_lease_ref: lease, ...(mutation === undefined ? {} : { action: mutation.action, request_id: mutation.requestId,
        idempotency_key: mutation.idempotencyKey, realtime_session_ref: mutation.realtimeSessionRef,
        iphone_device_lease_ref: mutation.iphoneDeviceLeaseRef, expected_pair_version: mutation.expectedPairVersion,
        ...(mutation.action === 'revoke' ? {} : { installation_id: mutation.installationId, ttl_seconds: mutation.ttlSeconds }) }), ...extra };
      const bytes = Buffer.from(JSON.stringify(wire)); const req = Readable.from([bytes]);
      Object.assign(req, { method: 'POST', url: '/v1/realtime/watch-binding' + (mutation === undefined ? '/read' : ''), socket: { remoteAddress: '127.0.0.1' }, rawHeaders: ['Content-Type','application/json','Content-Length',String(bytes.length), ...(authenticated ? ['Authorization','Bearer fixture-token-0123456789'] : [])] });
      let status = 0; let response = ''; const capture = { headersSent: false, writableEnded: false, writeHead(value: number) { status = value; this.headersSent = true; }, end(value: string) { response = value; this.writableEnded = true; } };
      assert.equal(await controller.handle(req as never, capture as never), true);
      return { status, body: JSON.parse(response) };
    };
    assert.deepEqual(await route(undefined), { status: 200, body: { operation: 'watch_binding', pair_state: { pair_version: '0', status: 'absent', requires_rebind: false }, binding: null } });
    assert.deepEqual(await route(undefined, {}, false), await route(initial, {}, false));
    for (const extra of [
      { realtime_session_ref: issuer.createSessionRef({ continuityId: continuity, userId, requestId: 'stale-session' }) },
      { iphone_device_lease_ref: issuer.createDeviceLeaseRef({ sessionRef: session, deviceId: device, requestId: 'wrong-lease' }) },
    ]) {
      const rejected = await route(undefined, extra); assert.equal(rejected.status, 403);
      assert.deepEqual(rejected, await route(initial, extra));
    }
    assert.equal((await route(initial, { authenticated: true })).status, 422);
    const firstResponse = await route(initial); assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.body));
    const first = firstResponse.body.binding;
    assert.deepEqual(await route(undefined), { status: 200, body: { operation: 'watch_binding', pair_state: { pair_version: '1', status: 'active', requires_rebind: false }, binding: first } });
    assert.equal(bootstrapCalls, 0);
    assert.deepEqual((await route(initial)).body.binding, first);
    assert.equal(first.kind, 't02.apple.watch-binding.v1'); assert.equal(first.pairVersion, '1');
    assert.notEqual(first.watch.deviceId, initial.installationId); assert.notEqual(first.watch.deviceId, device);
    assert.deepEqual(await api.readActiveByPrimary({ realtimeSessionRef: session, iphoneDeviceLeaseRef: lease }), canary);
    assert.deepEqual(await child(initial), first);
    const snapshot = await withTransaction(pool, client => api.readFormalByPrimaryInTransaction(client, { realtimeSessionRef: session, iphoneDeviceLeaseRef: lease }), { isolation: 'REPEATABLE READ', readOnly: true });
    assert.deepEqual(snapshot, first);
    const envelope = await enrollmentProjection.readCurrentBindingSnapshot!();
    assert.deepEqual((envelope as any).formalWatchBinding, first);
    assert.deepEqual((envelope as any).formalWatchPairState, { pairVersion: "1", status: "active", requiresRebind: false });
    const changedGrant = await createRuntimeCurrentBindingProvider(pool, { userId, deviceId: device, principalRef: "changed-grant" }).readCurrentBindingSnapshot!();
    assert.equal((changedGrant as any).formalWatchBinding, undefined);
    assert.deepEqual((changedGrant as any).formalWatchPairState, { pairVersion: "1", status: "active", requiresRebind: true });
    assert.equal((envelope as any).handoffDeviceId, first.watch.deviceId);
    const bodyEntries = Object.fromEntries([['bootstrap','bootstrap'], ['realtime_e2ee_key_resolve','e2ee/key/resolve'], ['connected_credential_refresh','credentials/refresh'], ['media_stop','media/stop'], ['end_continuity','end-continuity']].map(([operation, path]) => {
      const body = Buffer.from(JSON.stringify({ operation }));
      return [operation, { route: '/v1/realtime/' + path, body_base64: body.toString('base64'), body_sha256: createHash('sha256').update(body).digest('hex') }];
    }));
    const bundle = { schema: 'paios.realtime-production-enrollment-bundle.v1', origin: 'https://ai.example.invalid',
      credential_ref: { ...(session as Record<string, unknown>), ref_type: 'DeviceCredential' }, expires_at: expiresAt,
      binding: { realtime_session_ref: session, device_lease_ref: lease, continuity_id: continuity, connection_epoch: '1' },
      canonical_bodies: bodyEntries, formal_watch_binding: first, formal_watch_pair_state: { pair_version: "1", status: "active", requires_rebind: false } };
    assert.deepEqual(validateAppleProductionEnrollmentBundle(Buffer.from(JSON.stringify(bundle))).formal_watch_binding, first);
    assert.throws(() => validateAppleProductionEnrollmentBundle(Buffer.from(JSON.stringify({ ...bundle, formal_watch_binding: canary }))), /SOURCE_INVALID/);
    assert.throws(() => validateAppleProductionEnrollmentBundle(Buffer.from(JSON.stringify({ ...bundle, formal_watch_binding: { ...first, canonicalPayloadSha256: 'a'.repeat(64) } }))), /HASH_DRIFT/);
    // Force failure after lease allocation, before receipt commit; the whole transaction must roll back.
    await pool.query(`CREATE FUNCTION reject_formal_watch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = 'rollback-replace' THEN RAISE EXCEPTION 'FIXTURE_INSERT_FAILURE'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_formal_watch BEFORE INSERT ON apple_physical_canary_bindings FOR EACH ROW EXECUTE FUNCTION reject_formal_watch()');
    const before = (await pool.query('SELECT count(*) AS n FROM device_leases')).rows[0].n;
    await assert.rejects(api.mutateFormal(make('rollback-replace', 'replace', '1'), auth), /FIXTURE_INSERT_FAILURE/);
    assert.equal((await pool.query('SELECT count(*) AS n FROM device_leases')).rows[0].n, before);
    assert.deepEqual(await api.read(first.bindingId), first);
    const contenders = [make('replace-one', 'replace', '1'), make('replace-two', 'replace', '1')];
    const result = await withTransaction(pool, async client => {
      const prior = await api.readFormalByPrimaryInTransaction(client, { realtimeSessionRef: session, iphoneDeviceLeaseRef: lease });
      const mutations = await Promise.allSettled(contenders.map(i => owner(pool).mutateFormal(i, auth)));
      assert.deepEqual(await api.readFormalByPrimaryInTransaction(client, { realtimeSessionRef: session, iphoneDeviceLeaseRef: lease }), prior);
      return mutations;
    }, { isolation: 'REPEATABLE READ', readOnly: true });
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    const second = result.find(r => r.status === 'fulfilled')! as PromiseFulfilledResult<typeof first>;
    assert.equal(second.value.pairVersion, '2');
    await assert.rejects(api.read(first.bindingId), /BINDING_REVOKED/);
    assert.equal((await pool.query("SELECT count(*) AS n FROM device_leases WHERE device_id=$1 AND state='active'", [first.watch.deviceId])).rows[0].n, '0');
    assert.deepEqual(await child(initial), first);
    const revoke = make('formal-revoke', 'revoke', '2'); const revoked = await api.mutateFormal(revoke, auth);
    assert.equal(revoked.status, 'revoked'); assert.equal(revoked.pairVersion, '3');
    assert.deepEqual((await route(undefined)).body, { operation: 'watch_binding', pair_state: { pair_version: '3', status: 'revoked', requires_rebind: true }, binding: null });
    assert.deepEqual((await enrollmentProjection.readCurrentBindingSnapshot!() as any).formalWatchPairState, { pairVersion: '3', status: 'revoked', requiresRebind: true });
    assert.deepEqual(await child(revoke), revoked);
    assert.equal(await withTransaction(pool, c => api.readFormalByPrimaryInTransaction(c, { realtimeSessionRef: session, iphoneDeviceLeaseRef: lease }), { isolation: 'REPEATABLE READ', readOnly: true }), undefined);
    await assert.rejects(api.read(second.value.bindingId), /BINDING_REVOKED/);
    const third = await api.mutateFormal(make('formal-reregister', 'register', '3'), auth); assert.equal(third.pairVersion, '4');
    await pool.query("UPDATE realtime_sessions SET active_device_lease_ref = NULL WHERE session_ref_id=$1", [sid]);
    assert.deepEqual(await child(initial), first); // readback remains original after mutable current authority changed.
    await assert.rejects(api.mutateFormal(make('bad-current', 'replace', '4'), auth), /AUTHORITY_BINDING_DRIFT/);
    const nextLease = issuer.createDeviceLeaseRef({ sessionRef: session, deviceId: device, requestId: 'rotated-primary' });
    await pool.query(`INSERT INTO device_leases(lease_ref_id,device_lease_ref,lease_object_version,lease_payload_sha256,session_ref_id,realtime_session_ref,continuity_ref,user_id,device_id,continuity_id,capabilities,purpose,policy_decision_ref,capability_scope,purpose_scope,policy_binding,state,lease_version,fencing_token,issued_at,acquired_at,expires_at)
      SELECT $1,$2,'1',$3,session_ref_id,realtime_session_ref,continuity_ref,user_id,device_id,continuity_id,capabilities,purpose,policy_decision_ref,capability_scope,purpose_scope,policy_binding,'active',1,1,now(),now(),expires_at FROM device_leases WHERE lease_ref_id=$4`,
      [(nextLease as any).ref_id, nextLease, (nextLease as any).canonical_payload_sha256, lid]);
    await pool.query('UPDATE realtime_sessions SET active_device_lease_ref=$1 WHERE session_ref_id=$2', [nextLease, sid]);
    await pool.query("UPDATE device_leases SET state='released', released_at=now() WHERE lease_ref_id=$1", [lid]);
    assert.deepEqual(await route(undefined), await route(make('stale-primary', 'replace', '4')));
    assert.deepEqual((await route(undefined, { iphone_device_lease_ref: nextLease })).body, { operation: 'watch_binding', pair_state: { pair_version: '4', status: 'active', requires_rebind: true }, binding: null });
    const restarted = await createRuntimeCurrentBindingProvider(pool, { userId, deviceId: device, principalRef: auth.principalRef }).readCurrentBindingSnapshot!();
    assert.equal((restarted as any).formalWatchBinding, undefined);
    assert.deepEqual((restarted as any).formalWatchPairState, { pairVersion: '4', status: 'active', requiresRebind: true });
    const rotated = { ...make('rotated-primary-replace', 'replace', '4'), iphoneDeviceLeaseRef: nextLease };
    await assert.rejects(api.mutateFormal(rotated, { ...auth, principalRef: 'different-principal' }), /AUTHORITY_MISMATCH/);
    const fourth = await api.mutateFormal(rotated, auth);
    assert.deepEqual((await route(undefined, { iphone_device_lease_ref: nextLease })).body, { operation: 'watch_binding', pair_state: { pair_version: '5', status: 'active', requires_rebind: false }, binding: fourth });
    assert.equal(fourth.pairVersion, '5');
    assert.deepEqual((await enrollmentProjection.readCurrentBindingSnapshot!() as any).formalWatchPairState, { pairVersion: '5', status: 'active', requiresRebind: false });
    assert.deepEqual(await child(initial), first);
    assert.equal((await pool.query("SELECT count(*) AS n FROM apple_physical_canary_bindings WHERE companion_source='apple_watch_binding_v1' AND state='active'")).rows[0].n, '1');
    assert.equal((await pool.query('SELECT count(*) AS n FROM outbox_events')).rows[0].n, '5');
  } finally { await pool.end(); await admin.query('DROP DATABASE ' + name); await admin.end(); }
});
