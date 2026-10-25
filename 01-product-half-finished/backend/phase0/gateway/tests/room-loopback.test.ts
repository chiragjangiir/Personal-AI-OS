import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { startGateway } from '../src/main.ts';
import { Phase0SharedSessionOwner } from '../src/phase0-shared-session-owner.ts';

test('supervised startup keeps precontact admission and cannot reach legacy pipe machinery', () => {
  const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = (name: string) => {
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration?.body, `missing function body: ${name}`);
    return declaration.body;
  };
  const load = body('loadConfig').getText(source), entry = body('startGateway');
  const admission = load.indexOf('PAIOS_T15_PRECONTACT_ADMISSION');
  assert.ok(admission >= 0 && admission < load.indexOf('loadSupervisedControl(environment, runId)'));
  assert.equal(load.includes('loadGatewayNodePipeBootstrap('), false);
  for (const forbidden of [
    'gatewayNodePipe', 'createGatewayPublicationBuffer', 'createGatewayNamedPipeTransport',
    'runGatewayNodePipeSession', 'stageAbsenceProofs', 'GATEWAY_PIPE_CONFIG_REQUIRED',
    'GATEWAY_PIPE_PRECONTACT_REQUIRED', 'BROKER_FIN_ACK', 'GATEWAY_PIPE_FAILURE',
    'new Phase0SharedSessionOwner', 'new Phase0DemoSessionController',
  ]) assert.equal(entry.getText(source).includes(forbidden), false, forbidden);
  assert.ok(entry.getText(source).includes("config.precontactAdmission === 'CLOSED_PRECONTACT'"));
  assert.ok(entry.getText(source).includes("config.precontactAdmission === 'OPEN_NORMAL'"));
  assert.ok(entry.getText(source).includes('await adapter.prearmSupervisedSession()'));
  const serverCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createGatewayServer')
      serverCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(entry);
  assert.equal(serverCalls.length, 1);
  assert.deepEqual(serverCalls[0]!.arguments.slice(0, 5).map(arg => arg.getText(source)),
    ['config', 'adapter', 'precontactWitness', 'undefined', 'undefined']);
});

test('persistent startup forwards the explicit owner once without creating a fallback owner', async () => {
  const owner = new Phase0SharedSessionOwner();
  const received: unknown[][] = [];
  for (const supplied of [owner, undefined]) {
    await startGateway(supplied, {
      environment: { PAIOS_ROAMING_PERSISTENT_RUNTIME: '1' },
      startPersistentGateway: async (...args) => { received.push(args); },
    });
  }
  assert.deepEqual(received.map(args => args.length), [1, 1]);
  assert.equal(received[0]![0], owner);
  assert.equal(received[1]![0], undefined);
});

test('persistent and visual legacy startup without an explicit launcher cannot start a listener', async () => {
  for (const environment of [{ PAIOS_ROAMING_PERSISTENT_RUNTIME: '1' }, { PAIOS_RAYNEO_VISUAL_LOOP: '1' }]) {
    await assert.rejects(startGateway(undefined, { environment }), /LEGACY_RAYNEO_STARTUP_RETIRED/);
  }
});

for (const configured of [false, true]) test(`runtime record paths use ${configured ? 'configured' : 'deployment default'} Linux roots`, () => {
  const config = configured ? '/srv/config' : '/etc/paios';
  const data = configured ? '/srv/data' : '/var/lib/paios';
  const secrets = configured ? '/srv/secrets' : '/run/secrets';
  const modules = [
    ['rayneo-demo-owner-projection', 'RAYNEO_LOCAL_OWNER_POLICY_PATH'],
    ['rayneo-pairing-registry', 'RAYNEO_PAIRING_REGISTRY_PATH'],
    ['t03-apple-cycling-lease-authority', 'T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH'],
    ['t03-production-memory-lifecycle-authority', 'T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH'],
    ['realtime-public-control-persistent-bearer-authority', 'PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH'],
    ['realtime-public-control-persistent-public-ports', 'PERSISTENT_PUBLIC_SECRET_PATHS'],
  ];
  const script = modules.map(([module, name]) =>
    `import {${name}} from ${JSON.stringify(new URL(`../src/${module}.ts`, import.meta.url).href)};`).join('\n') +
    `console.log(JSON.stringify([${modules.map(([, name]) => name).join(',')}]));`;
  const environment = {...process.env};
  for (const [name, value] of Object.entries({PAIOS_CONFIG_ROOT: config, PAIOS_DATA_ROOT: data, PAIOS_SECRET_ROOT: secrets})) {
    if (configured) environment[name] = value;
    else delete environment[name];
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {env: environment, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    `${data}/resources/local-owner.v1.json`, `${data}/resources/pairing/paired-device.v1.json`,
    `${config}/apple-cycling-governance-authority.v1.json`, `${config}/t03-production-memory-lifecycle-authority.v1.json`,
    `${config}/realtime-public-control-bearer-authority.v1.json`,
    {livekitApiKey: `${secrets}/livekit-api-key`, livekitApiSecret: `${secrets}/livekit-api-secret`,
      proxyAttestation: `${secrets}/proxy-attestation`, e2eeRootKey: `${secrets}/e2ee-root-key`},
  ]);
});
