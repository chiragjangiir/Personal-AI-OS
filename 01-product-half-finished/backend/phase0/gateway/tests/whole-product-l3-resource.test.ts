import {fakeQwenConfiguration,fakeTtsConfiguration} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import './gateway-test-port.ts';
import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import { makeMacProductResourceFixture } from './mac-product-resource-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DashScopeTts } from '../../../services/personal-aios-integration/src/tts.ts';
import { L3Service } from '../../../services/personal-aios-integration/src/memory/l3.ts';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import { createPersistentPublicExecutionOwner, type CentralTextResources } from '../src/persistent-public-execution-owner.ts';
import { createRayneoPersistentProductionHandoff, startRayneoPersistentProduction,
  type WholeProductOwnerPorts } from '../src/rayneo-persistent-production-entrypoint.ts';
import { makePublicControl } from './whole-product-public-owner-fixture.ts';

const SECRET = Buffer.alloc(32, 1).toString('base64url');
test('L3 product handoff borrows the one ready pool, reaches the same lower assembly and closes once after joins', async t => {
  const resources = makeMacProductResourceFixture();
  t.after(() => resources.cleanup());
  const root = await mkdtemp(join(tmpdir(), 'product-l3-owner-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const calls: string[] = [];
  const pool = {end: async () => {calls.push('pool.end');}} as never;
  const service = new L3Service(pool);
  // Catalog acceptance is exercised separately against explicit test PG; this seam tests composition ownership.
  t.mock.method(L3Service, 'openExisting', async (actual: unknown, namespace: string) => {
    assert.equal(actual, pool); assert.equal(namespace, 'test_l3'); calls.push('l3.open'); return service;
  });
  const tts = new DashScopeTts(fakeQwenConfiguration(),fakeTtsConfiguration);
  const central: CentralTextResources = {storage: new PosixStorage(root),tts,
    native: sourceClient({create: async () => {throw new Error('NO_MODEL');}, status: async () => {throw new Error('NO_MODEL');},
      cancel: async () => {throw new Error('NO_MODEL');}}),
    admission: {max_pending_events: 2, max_pending_bytes: 8192, max_event_age_ms: 10000,
      poll_interval_ms: 5, native_idempotency_retention_ms: 10000, policy_version: 'test'},
    skill: 'controlled fixed skill', max_event_bytes: 4096, max_read_bytes: 4096,
    http: {internal_token: 'controlled-product-l3-test-key', max_request_bytes: 8192, request_timeout_ms: 1000}};
  const base = makePublicControl();
  let release!: () => void;
  const joined = new Promise<void>(resolve => {release = resolve;});
  const ports: Partial<WholeProductOwnerPorts> = {
    readPolicy: () => ({} as never), readPostgresPassword: () => 'controlled',
    readLiveKit: () => ({livekitApiKey: 'controlled', livekitApiSecret: 'controlled', proxyAttestationSecret: SECRET}),
    createPool: () => {calls.push('pool.create'); return pool;},
    inspectPostgres: async actual => {assert.equal(actual, pool); calls.push('pg.ready'); return true;},
    createPublicOwner: async input => {
      assert.equal(input.pool, pool); assert.equal(input.central?.l3, service); calls.push('lower.create');
      const execution = await createPersistentPublicExecutionOwner({executionOwner: 'hermes_text', central: input.central!,
        t03: {ownerContext: {resolve: async () => {throw new Error('NO_DEVICE');}}} as never,
        readCurrentBinding: async () => undefined, deviceId: 'controlled-device',
        participant: {roomPort: {on: () => undefined, removeListener: () => undefined}} as never,
        onError: error => assert.fail(String(error))});
      assert.equal(execution.executionOwner, 'hermes_text');
      if (execution.executionOwner !== 'hermes_text') throw new Error('OWNER');
      t.after(async()=>{await execution.bridge.close?.();});
      assert.ok(execution.assembly.runtime.toolSchemas().some(schema => schema.name === 'paios_l3_commit'));
      assert.equal(Reflect.get(Reflect.get(execution.assembly.runtime,'output'),'config').tts,tts);
      assert.equal(Reflect.get(Reflect.get(execution.assembly.runtime,'memory'),'config').l3,service);
      const bridge = {...execution.bridge, close: async () => {calls.push('join.enter'); await joined;
        await execution.bridge.close!(); calls.push('join.done');}};
      return {...base.handoff, centralTextAssembly: execution.assembly,
        composition: {...base.handoff.composition, assistantBridge: bridge}};
    },
  };
  const handoff = await createRayneoPersistentProductionHandoff({executionOwner: 'hermes_text', product_resources: resources.config, central,
    l3: {namespace: 'test_l3'}, inputReadiness: {owner: 'controlled', isReady: () => true}}, ports);
  assert.deepEqual(calls, ['pool.create', 'pg.ready', 'l3.open', 'lower.create']);
  assert.equal(central.l3, undefined);
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const handle = await startRayneoPersistentProduction(handoff.launcherInput,
    {executionOwner: 'hermes_text', publicControl: handoff.publicControl, centralListenPort: address.port});
  const response = await fetch(`http://127.0.0.1:${address.port}/internal/hermes/tool-contracts`,
    {headers: {Authorization: 'Bearer controlled-product-l3-test-key'}});
  assert.equal(response.status, 200);
  assert.ok((await response.json() as {name: string}[]).some(tool => tool.name === 'paios_l3_commit'));
  const closing = handle.close();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(calls.includes('join.enter')); assert.equal(calls.includes('pool.end'), false);
  release(); await Promise.all([closing, handle.close()]);
  assert.equal(calls.filter(call => call === 'pool.end').length, 1);
  assert.ok(calls.indexOf('join.done') < calls.indexOf('pool.end'));
});

test('L3 schema or readiness startup failure preserves its cause and releases only the allocated pool', async t => {
  const resources = makeMacProductResourceFixture();
  t.after(() => resources.cleanup());
  let ends = 0, opens = 0;
  const failure = new Error('L3_EXISTING_SCHEMA_REQUIRED');
  const pool = {end: async () => {ends++;}} as never;
  t.mock.method(L3Service, 'openExisting', async () => {opens++; throw failure;});
  const ports: Partial<WholeProductOwnerPorts> = {
    readPolicy: () => ({} as never), readPostgresPassword: () => 'controlled',
    readLiveKit: () => ({livekitApiKey: 'controlled', livekitApiSecret: 'controlled', proxyAttestationSecret: SECRET}),
    createPool: () => pool, inspectPostgres: async () => true,
    createPublicOwner: async () => {throw new Error('SHOULD_NOT_ALLOCATE');},
  };
  const selection = {executionOwner: 'hermes_text', product_resources: resources.config, central: {} as CentralTextResources,
    l3: {namespace: 'missing'}, inputReadiness: {owner: 'controlled', isReady: () => true}} as const;
  await assert.rejects(createRayneoPersistentProductionHandoff(selection, ports), error => error === failure);
  assert.equal(ends, 1); assert.equal(opens, 1);
  await assert.rejects(createRayneoPersistentProductionHandoff(selection,
    {...ports, inspectPostgres: async () => false}), /PERSISTENT_PRODUCTION_AUTHORITIES_NOT_READY/);
  assert.equal(ends, 2); assert.equal(opens, 1);
});

test('default Hermes handoff does not allocate L3 and retired legacy handoff rejects', async t => {
  const resources = makeMacProductResourceFixture();
  t.after(() => resources.cleanup());
  t.mock.method(L3Service, 'openExisting', async () => {throw new Error('DEFAULT_MUST_NOT_OPEN_L3');});
  const base = makePublicControl();
  let ends = 0;
  const pool = {end: async () => {ends++;}} as never;
  const ports: Partial<WholeProductOwnerPorts> = {
    readPolicy: () => ({} as never), readPostgresPassword: () => 'controlled',
    readLiveKit: () => ({livekitApiKey: 'controlled', livekitApiSecret: 'controlled', proxyAttestationSecret: SECRET}),
    createPool: () => pool, inspectPostgres: async () => true,
    createPublicOwner: async input => {assert.equal(input.central?.l3, undefined); return base.handoff;},
    createFinalTranscript: () => ({reader: {read: async () => undefined}} as never),
    createSourceMedia: () => ({inspectRuntime: async () => ({runtimeRootExists: true, casRootExists: true,
      metadataRootExists: true, catalogExists: true, runtimeRootNonReparse: true, casRootNonReparse: true,
      metadataRootNonReparse: true, catalogNonReparse: true}), close: async () => undefined}) as never,
    createQwenSupervisor: () => ({start: async () => undefined, close: async () => undefined}) as never,
    inspectQwen: async () => true,
  };
  const hermes = await createRayneoPersistentProductionHandoff({executionOwner: 'hermes_text', product_resources: resources.config,
    central: {} as CentralTextResources, inputReadiness: {owner: 'controlled', isReady: () => true}}, ports);
  await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'legacy'} as never, ports),/PUBLIC_EXECUTION_OWNER_INVALID/);
  await hermes.launcherInput.owner.close();
  await (pool as {end(): Promise<void>}).end(); assert.equal(ends, 1);
});
