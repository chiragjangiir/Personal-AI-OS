import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import {
  request as sendHttpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts, { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  DataPacketKind,
  AudioSource,
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  Room as OfficialRoom,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoSource,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import {
  AccessToken,
  RoomServiceClient,
  TokenVerifier,
  TrackSource as ServerTrackSource,
  type VideoGrant,
} from 'livekit-server-sdk';
import {
  assertSupervisedRoomServiceSnapshot,
  assertDispatchRequest,
  assertEmptyOrdinaryMap,
  assertRtcPublisherBinding,
  deleteAndVerifyRoom,
  DeviceSessionAdapter,
  GatewayOutboundOwnership,
  gatewayPublisherIdentityBinding,
  isGatewayOwnedOutboundEnvelope,
  ModelCorrelationCache,
  OfficialPrimitiveState,
  primitiveScopedId,
  parseStrictJsonBytes,
  rtcEventTransportBinding,
  type GatewayConfig,
  type DeviceSessionAdapterDependencies,
  type SupervisedAbsenceProofDocuments,
  type SupervisedCleanupReceipt,
  type SupervisedDeviceLanBinding,
  type TimelineItem,
} from '../src/device-session-adapter.ts';
import {
  CONTRACT_SCHEMA_VERSION_V0_3,
  loadFrozenArtifacts,
  RELIABLE_EVENT_TOPIC,
  type EventEnvelope,
} from '../src/contract-consumer.ts';
import { renderDashboard } from '../src/dashboard.ts';
import {
  DirectLoopController,
  type DirectLoopAttempt,
} from '../src/direct-loop-controller.ts';
import {
  authorizeDeviceLanRequest,
  constantTimeProxyAttestationEqual,
  createGatewayPrecontactWitnessProducer,
  createGatewayPublicationBuffer,
  createGatewayServer,
  incrementPrecontactSafeInteger,
  loadConfig,
  startGateway,
  NoDevicePrecontactWitness,
  runGatewayNodePipeSession,
  type DeviceLanRequestMetadata,
  type DeviceLanSecurityConfig,
  type GatewayNodePipeBootstrap,
  type GatewayNodePipeTransport,
  type GatewayRuntimeConfig,
} from '../src/main.ts';

import { Phase0SharedSessionOwner } from '../src/phase0-shared-session-owner.ts';

const T15_SOURCE_TEST_ROOT =
  'D:\\AI\\personal ai os\\phase0\\evidence\\iphone-one-shot\\t15\\MG-T15-P0-BPRIME-IPHONE-ONE-SHOT-SOURCE-001\\work\\gateway';
const containedHarnessAvailable = process.platform === 'win32'
  && process.env.PAIOS_GATEWAY_TEST_HARNESS === 'R5_1'
  && process.env.PAIOS_GATEWAY_SOURCE_TEST_ROOT === T15_SOURCE_TEST_ROOT;

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

if (!containedHarnessAvailable) {
  test('room loopback requires the contained Windows R5_1 harness', {
    skip: 'Requires Windows, the R5_1 containment harness, and its exact T15 isolated source root; ordinary suite does not start servers or delete source roots',
  }, () => {});
} else {
test.after(() => {
  if (existsSync(T15_SOURCE_TEST_ROOT)) {
    rmSync(T15_SOURCE_TEST_ROOT, { recursive: true, force: true });
  }
});

function sha256File(path: string | URL): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('v0.2 alignment runs against frozen contracts, evidence, dependencies and interpreter', () => {
  const frozen = [
    [
      'package.json',
      new URL('../package.json', import.meta.url),
      '994df958ec1e2739c5d609eec8561343f00e56e45fec9dc5dd16b8db1f69b532',
    ],
    [
      'pnpm-workspace.yaml',
      new URL('../pnpm-workspace.yaml', import.meta.url),
      '77f27c149ee44fcea90f6ab8ac1b3cfd8b1c6504f5e5074b5f7cc506b83f86cc',
    ],
    [
      'pnpm-lock.yaml',
      new URL('../pnpm-lock.yaml', import.meta.url),
      'cfeaecc3e0dc205867abdd7cdbcec1d67aad9836af570f76b806256b49c8ba61',
    ],
    [
      'node_modules/.modules.yaml',
      new URL('../node_modules/.modules.yaml', import.meta.url),
      '34dcb45d3fcd9591e34512bd80a70628e1c7fb96c1ebfd2e2e10cb1eda577b3f',
    ],
    [
      'node_modules/.pnpm/lock.yaml',
      new URL('../node_modules/.pnpm/lock.yaml', import.meta.url),
      'cfeaecc3e0dc205867abdd7cdbcec1d67aad9836af570f76b806256b49c8ba61',
    ],
    [
      'T00_DEPENDENCY_GATE_R2.md',
      new URL(
        '../../evidence/gateway-room/thin-adapter/T00_DEPENDENCY_GATE_R2.md',
        import.meta.url,
      ),
      '3083d12589b115ab44d378debcd3a095e9b53becec6ef1faf13b3ef75be7e119',
    ],
    [
      'G_A1_SOURCE_RUNNER_REPAIR_R3.md',
      new URL(
        '../../evidence/gateway-room/thin-adapter/G_A1_SOURCE_RUNNER_REPAIR_R3.md',
        import.meta.url,
      ),
      'c632bfb7cf208424242ad2fe957d52a4b81a047932dedb5aa131630ab8931b3b',
    ],
    [
      'T01_RFC_DECISION_GA1_GATEWAY_IDENTITY_R1.md',
      new URL(
        '../../evidence/contracts/demo-v0.2/T01_RFC_DECISION_GA1_GATEWAY_IDENTITY_R1.md',
        import.meta.url,
      ),
      'af81422c1fb81a613f2cded9f965aa2a9751cd0b45727962eb6d8c20b9c0191f',
    ],
    [
      'INTERFACE_CHANGE_PACKET_PHASE0_DEMO_V0_2_R1.md',
      new URL(
        '../../evidence/contracts/demo-v0.2/INTERFACE_CHANGE_PACKET_PHASE0_DEMO_V0_2_R1.md',
        import.meta.url,
      ),
      '34fd2a461310805beaa49e6f3cc0f7feb9bbdaf42e5f3b511d506dca532b196a',
    ],
    ...(
      [
        [
          'PHASE0_DEMO_CONTRACT.md',
          '51483ba635bd9e24bd08da63108952b4f33611a8a0c69395a4b75ed626004e1f',
        ],
        [
          'session-event.schema.json',
          'f0db8c31a2244535e410c8afeb6f00d156934f3961377363b24999dc22b006cf',
        ],
        ['rtc-mapping.yaml', 'a1692d11693676c55d58e9c1f0af264ecf7cc1309c7585179b57d6c6159863f0'],
        [
          'examples/valid-events.json',
          'd307b7d17a4ce0bc93e10c4fed7a5d27478e43a2bb0d43623bf54c4a86cc831f',
        ],
        [
          'examples/invalid-events.json',
          '42e20fd3f537bc6caa49f4d24aa0b1581da123815b8968f17a84c468f2269707',
        ],
        [
          'tests/test_contract_compatibility.py',
          '3700a12a2904b44e95cba3c2e8530d5a29b10df00583eadd05d23733d319b912',
        ],
      ] as const
    ).map(
      ([path, hash]) =>
        [
          `demo_v0_2/${path}`,
          new URL(`../../contracts/demo_v0_2/${path}`, import.meta.url),
          hash,
        ] as const,
    ),
    ...(
      [
        [
          'PHASE0_DEMO_CONTRACT.md',
          'bd868eb69fa4c220792525dd3ee82f18c02799ce49f6e946f4db90ec3e46e881',
        ],
        [
          'session-event.schema.json',
          '4b39b41afb7e742b77e5b919f3c68e48bd3cf8187d30875a2c90de4f666d230d',
        ],
        ['rtc-mapping.yaml', 'bcedc98afdf78a585cde4c81d42fd77a3975332887d8fb3175f594ec7a6595d2'],
        [
          'examples/valid-events.json',
          '4cd6827663705fe7825635b2522c47baa5f632c99b14af2192d79ea20948cae8',
        ],
        [
          'examples/invalid-events.json',
          '12d52451ebea56c375755fac6cc60147d15054df4ad4b3ef01c1ca01b936c009',
        ],
        [
          'tests/test_contract_compatibility.py',
          '77047319a0dbf1be8139c4871c3f53ff76ba63a6eb81295df9fcef32cd604885',
        ],
      ] as const
    ).map(
      ([path, hash]) =>
        [
          `demo_v0/${path}`,
          new URL(`../../contracts/demo_v0/${path}`, import.meta.url),
          hash,
        ] as const,
    ),
    [
      'D:/.pnpm-store/v11/index.db',
      'D:/.pnpm-store/v11/index.db',
      'b4552390cd8430ca97e3b4de25d500b60f126bf6362aff4c7db8347978056c1a',
    ],
    [
      'C:/Program Files/nodejs/node.exe',
      'C:/Program Files/nodejs/node.exe',
      '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de',
    ],
  ] as const;
  for (const [label, path, expected] of frozen) {
    assert.equal(sha256File(path), expected, label);
    console.log(`FROZEN_SHA256 ${label} ${expected}`);
  }
});

const runtime = { id: 'phase0_session_test' } as any;
const directParticipant = {
  identity: 'web_device_test',
  attributes: {
    schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
    device_id: 'web_device_test',
    device_class: 'web_mobile',
    client_instance_id: 'web_client_test',
  },
} as any;
const directEvent = {
  schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
  event_type: 'paios.phase0.demo.device.status',
  session_id: runtime.id,
  origin: {
    device_id: 'web_device_test',
    device_class: 'web_mobile',
    client_instance_id: 'web_client_test',
  },
};

const mediaTemplate = (
  loadFrozenArtifacts(CONTRACT_SCHEMA_VERSION_V0_3).validFixture.events as EventEnvelope[]
).find((event) => event.event_type === 'paios.phase0.demo.media.referenced');
assert.ok(mediaTemplate, 'frozen fixture must contain media.referenced');

function temporaryMediaEvent(
  sessionId: string,
  now: number,
  transport: 'livekit_track' | 'ephemeral_object',
  locator: string,
  mediaId = 'source_runner_media_001',
): EventEnvelope {
  const event = structuredClone(mediaTemplate!);
  event.event_id = '20000000-0000-4000-8000-000000000001';
  event.session_id = sessionId;
  event.trace_id = '20000000-0000-4000-8000-000000000002';
  event.occurred_at = new Date(now).toISOString();
  event.expires_at = new Date(now + 3_600_000).toISOString();
  event.idempotency_key = 'source-runner-temporary-media-001';
  Object.assign(event.payload.media_ref, {
    media_id: mediaId,
    transport,
    locator,
    expires_at: new Date(now + 3_000_000).toISOString(),
  });
  if (transport === 'ephemeral_object') {
    event.payload.media_ref.byte_length = 128;
    event.payload.media_ref.sha256 = 'a'.repeat(64);
  } else {
    delete event.payload.media_ref.byte_length;
    delete event.payload.media_ref.sha256;
  }
  return event;
}

test('RTC event topic, reliability, room and publisher are jointly bound', () => {
  const canonicalGatewayBinding = gatewayPublisherIdentityBinding();
  assert.deepEqual(canonicalGatewayBinding, {
    identity: 'windows_gateway_01',
    attributes: {
      schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
      device_id: 'windows_gateway_01',
      device_class: 'windows_gateway',
      client_instance_id: 'gateway_client_01',
    },
    origin: {
      device_id: 'windows_gateway_01',
      device_class: 'windows_gateway',
      client_instance_id: 'gateway_client_01',
    },
  });
  assert.deepEqual(rtcEventTransportBinding(directEvent.event_type), {
    topic: RELIABLE_EVENT_TOPIC,
    kind: DataPacketKind.KIND_RELIABLE,
    reliable: true,
  });
  assert.deepEqual(rtcEventTransportBinding('paios.phase0.demo.device.telemetry'), {
    topic: RELIABLE_EVENT_TOPIC,
    kind: DataPacketKind.KIND_LOSSY,
    reliable: false,
  });
  assert.deepEqual(rtcEventTransportBinding('paios.phase0.demo.device.telemetry.extra'), {
    topic: RELIABLE_EVENT_TOPIC,
    kind: DataPacketKind.KIND_RELIABLE,
    reliable: true,
  });
  const gatewayEnvelope = {
    schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
    event_id: '10000000-0000-4000-8000-000000000001',
    origin: {
      device_id: 'windows_gateway_01',
      device_class: 'windows_gateway',
      client_instance_id: 'gateway_client_01',
    },
  } as EventEnvelope;
  assert.equal(isGatewayOwnedOutboundEnvelope(gatewayEnvelope), true);
  const outboundOwnership = new GatewayOutboundOwnership();
  assert.equal(
    outboundOwnership.owns(gatewayEnvelope),
    false,
    'matching origin is not local ownership',
  );
  outboundOwnership.record(gatewayEnvelope);
  assert.equal(outboundOwnership.owns(gatewayEnvelope), true);
  const mutatedLocal = structuredClone(gatewayEnvelope);
  mutatedLocal.payload = { drift: true };
  assert.equal(outboundOwnership.owns(mutatedLocal), false);

  const foreignOrigins = [
    {
      device_id: 'web_device_test',
      device_class: 'web_mobile',
      client_instance_id: 'web_client_test',
    },
    {
      device_id: 'iphone_01',
      device_class: 'iphone',
      client_instance_id: 'iphone_client_01',
    },
    {
      device_id: 'watch_01',
      device_class: 'apple_watch',
      client_instance_id: 'watch_client_01',
      relay: {
        relay_device_id: 'iphone_01',
        relay_device_class: 'iphone',
        transport: 'watch_connectivity',
      },
    },
    {
      device_id: 'rayneo_01',
      device_class: 'rayneo',
      client_instance_id: 'rayneo_client_01',
    },
    {
      device_id: 'agent_01',
      device_class: 'agent',
      client_instance_id: 'agent_client_01',
    },
  ];
  for (const [index, origin] of foreignOrigins.entries()) {
    const foreign = {
      ...gatewayEnvelope,
      event_id: `10000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
      origin,
    } as EventEnvelope;
    assert.equal(isGatewayOwnedOutboundEnvelope(foreign), false, origin.device_class);
    assert.throws(() => outboundOwnership.record(foreign), /LOCAL_GATEWAY_ENVELOPE_REQUIRED/);
  }
  for (const alias of ['windows-gateway', 'windows_gateway']) {
    const aliased = structuredClone(gatewayEnvelope);
    aliased.event_id = `alias-${alias}`;
    aliased.origin.device_id = alias;
    assert.equal(isGatewayOwnedOutboundEnvelope(aliased), false);
    assert.throws(() => outboundOwnership.record(aliased), /LOCAL_GATEWAY_ENVELOPE_REQUIRED/);
  }
  const v01GatewayEnvelope = structuredClone(gatewayEnvelope);
  v01GatewayEnvelope.schema_version = 'phase0-demo/0.1';
  assert.equal(isGatewayOwnedOutboundEnvelope(v01GatewayEnvelope), false);
  outboundOwnership.clear();
  assert.equal(outboundOwnership.isEmpty(), true);

  assert.doesNotThrow(() =>
    assertRtcPublisherBinding(
      runtime,
      directEvent,
      directParticipant,
      DataPacketKind.KIND_RELIABLE,
      RELIABLE_EVENT_TOPIC,
    ),
  );
  const telemetryEvent = {
    ...directEvent,
    event_type: 'paios.phase0.demo.device.telemetry',
  };
  assert.doesNotThrow(() =>
    assertRtcPublisherBinding(
      runtime,
      telemetryEvent,
      directParticipant,
      DataPacketKind.KIND_LOSSY,
      RELIABLE_EVENT_TOPIC,
    ),
  );
  const gatewayParticipant = {
    identity: canonicalGatewayBinding.identity,
    attributes: canonicalGatewayBinding.attributes,
  } as any;
  const fixtureGatewayEvents = (
    loadFrozenArtifacts(CONTRACT_SCHEMA_VERSION_V0_3).validFixture.events as EventEnvelope[]
  ).filter((event) => event.origin.device_class === 'windows_gateway');
  assert.ok(fixtureGatewayEvents.length > 0);
  const generatedRoundTripOwnership = new GatewayOutboundOwnership();
  for (const event of fixtureGatewayEvents) {
    const binding = rtcEventTransportBinding(event.event_type);
    assert.doesNotThrow(
      () =>
        assertRtcPublisherBinding(
          { id: event.session_id } as any,
          event,
          gatewayParticipant,
          binding.kind,
          binding.topic,
        ),
      event.event_type,
    );
    generatedRoundTripOwnership.record(event);
    assert.equal(generatedRoundTripOwnership.owns(event), true, event.event_type);
  }

  const watchEvent = (
    loadFrozenArtifacts(CONTRACT_SCHEMA_VERSION_V0_3).validFixture.events as EventEnvelope[]
  ).find(
    (event) => event.origin.device_class === 'apple_watch',
  );
  assert.ok(watchEvent);
  const watchRelayParticipant = {
    identity: 'iphone_01',
    attributes: {
      schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
      device_id: 'iphone_01',
      device_class: 'iphone',
      client_instance_id: 'iphone_client_01',
    },
  } as any;
  const watchBinding = rtcEventTransportBinding(watchEvent.event_type);
  assert.doesNotThrow(() =>
    assertRtcPublisherBinding(
      { id: watchEvent.session_id } as any,
      watchEvent,
      watchRelayParticipant,
      watchBinding.kind,
      watchBinding.topic,
    ),
  );
  const forbiddenGenericRelay = structuredClone(directEvent) as EventEnvelope;
  forbiddenGenericRelay.origin.relay = {
    relay_device_id: 'iphone_01',
    relay_device_class: 'iphone',
    transport: 'watch_connectivity',
  };
  assert.throws(
    () =>
      assertRtcPublisherBinding(
        runtime,
        forbiddenGenericRelay,
        directParticipant,
        DataPacketKind.KIND_RELIABLE,
        RELIABLE_EVENT_TOPIC,
      ),
    /RTC_GENERIC_RELAY_FORBIDDEN/,
  );

  for (const alias of ['windows-gateway', 'windows_gateway']) {
    const event = structuredClone(fixtureGatewayEvents[0]!);
    event.origin.device_id = alias;
    const participant = structuredClone(gatewayParticipant);
    participant.identity = alias;
    participant.attributes.device_id = alias;
    assert.throws(
      () =>
        assertRtcPublisherBinding(
          { id: event.session_id } as any,
          event,
          participant,
          DataPacketKind.KIND_RELIABLE,
          RELIABLE_EVENT_TOPIC,
        ),
      /GATEWAY_PUBLISHER_BINDING_MISMATCH/,
    );
  }
  for (const [attribute, value] of [
    ['device_id', 'windows_gateway_spoof'],
    ['device_class', 'web_mobile'],
    ['client_instance_id', 'gateway_client_spoof'],
    ['schema_version', 'phase0-demo/0.1'],
  ] as const) {
    const participant = structuredClone(gatewayParticipant);
    participant.attributes[attribute] = value;
    const event = fixtureGatewayEvents[0]!;
    assert.throws(
      () =>
        assertRtcPublisherBinding(
          { id: event.session_id } as any,
          event,
          participant,
          DataPacketKind.KIND_RELIABLE,
          RELIABLE_EVENT_TOPIC,
        ),
      /GATEWAY_PUBLISHER_BINDING_MISMATCH/,
      attribute,
    );
  }
  for (const origin of foreignOrigins) {
    const event = structuredClone(fixtureGatewayEvents[0]!);
    event.origin = origin;
    assert.throws(() =>
      assertRtcPublisherBinding(
        { id: event.session_id } as any,
        event,
        gatewayParticipant,
        DataPacketKind.KIND_RELIABLE,
        RELIABLE_EVENT_TOPIC,
      ),
    );
  }
  const mixedVersionEvent = structuredClone(fixtureGatewayEvents[0]!);
  mixedVersionEvent.schema_version = 'phase0-demo/0.1';
  assert.throws(
    () =>
      assertRtcPublisherBinding(
        { id: mixedVersionEvent.session_id } as any,
        mixedVersionEvent,
        gatewayParticipant,
        DataPacketKind.KIND_RELIABLE,
        RELIABLE_EVENT_TOPIC,
      ),
    /RTC_SCHEMA_VERSION_MISMATCH/,
  );

  const hostiles = [
    [
      { ...directEvent, session_id: 'phase0_session_other' },
      directParticipant,
      DataPacketKind.KIND_RELIABLE,
      RELIABLE_EVENT_TOPIC,
    ],
    [directEvent, undefined, DataPacketKind.KIND_RELIABLE, RELIABLE_EVENT_TOPIC],
    [
      directEvent,
      { ...directParticipant, identity: 'web_device_spoof' },
      DataPacketKind.KIND_RELIABLE,
      RELIABLE_EVENT_TOPIC,
    ],
    [directEvent, directParticipant, DataPacketKind.KIND_LOSSY, RELIABLE_EVENT_TOPIC],
    [directEvent, directParticipant, DataPacketKind.KIND_RELIABLE, 'paios.phase0.demo.telemetry'],
    [telemetryEvent, directParticipant, DataPacketKind.KIND_RELIABLE, RELIABLE_EVENT_TOPIC],
    [telemetryEvent, directParticipant, undefined, RELIABLE_EVENT_TOPIC],
    [telemetryEvent, directParticipant, DataPacketKind.KIND_LOSSY, undefined],
  ] as const;
  for (const [event, participant, kind, topic] of hostiles) {
    assert.throws(() => assertRtcPublisherBinding(runtime, event, participant as any, kind, topic));
  }
});

test('room deletion is verified across success, already-absent retry and failures', async () => {
  const exactQueries: Array<readonly string[] | undefined> = [];
  await assert.doesNotReject(
    deleteAndVerifyRoom(
      {
        deleteRoom: async () => {},
        listRooms: async (names) => {
          exactQueries.push(names);
          return [];
        },
      },
      runtime.id,
    ),
  );
  await assert.doesNotReject(
    deleteAndVerifyRoom(
      {
        deleteRoom: async () => {},
        listRooms: async () =>
          Object.freeze([]) as unknown as Array<{ name: string }>,
      },
      runtime.id,
    ),
  );
  await assert.doesNotReject(
    deleteAndVerifyRoom(
      {
        deleteRoom: async () => {
          const error = new Error('room not found');
          (error as any).status = 404;
          throw error;
        },
        listRooms: async () => [],
      },
      runtime.id,
    ),
  );
  await assert.rejects(
    deleteAndVerifyRoom(
      {
        deleteRoom: async () => {
          throw new Error('transport failed');
        },
        listRooms: async () => [],
      },
      runtime.id,
    ),
    /transport failed/,
  );
  await assert.rejects(
    deleteAndVerifyRoom(
      {
        deleteRoom: async () => {},
        listRooms: async () => {
          throw new Error('verify failed');
        },
      },
      runtime.id,
    ),
    /verify failed/,
  );
  await assert.rejects(
    deleteAndVerifyRoom(
      {
        deleteRoom: async () => {},
        listRooms: async () => [{ name: runtime.id }],
      },
      runtime.id,
    ),
    /ROOM_DELETE_NOT_VERIFIED/,
  );
  const inheritedRoom = [] as Array<{ name: string }>;
  Object.setPrototypeOf(inheritedRoom, { 0: { name: runtime.id } });
  const lengthTrap = new Proxy([] as Array<{ name: string }>, {
    get(target, property, receiver) {
      if (property === 'length') throw new Error('hostile length getter');
      return Reflect.get(target, property, receiver);
    },
  });
  const ownKeysTrap = new Proxy([] as Array<{ name: string }>, {
    ownKeys() {
      throw new Error('hostile ownKeys trap');
    },
  });
  const stealthTarget = [{ name: runtime.id }];
  const stealthProxy = new Proxy(stealthTarget, {
    get(target, property, receiver) {
      if (property === 'length') return 0;
      return Reflect.get(target, property, receiver);
    },
    ownKeys() {
      return ['length'];
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === 'length') {
        return {
          value: 0,
          writable: true,
          enumerable: false,
          configurable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const hostileListResponses: unknown[] = [
    undefined,
    null,
    {},
    '[]',
    { length: 0 },
    [{ name: 'wrong_room_name' }],
    [{ name: runtime.id }, { name: runtime.id }],
    [{}],
    Object.setPrototypeOf([], null),
    inheritedRoom,
    lengthTrap,
    ownKeysTrap,
    stealthProxy,
  ];
  for (const hostile of hostileListResponses) {
    await assert.rejects(
      deleteAndVerifyRoom(
        {
          deleteRoom: async () => {},
          listRooms: async () => hostile as never,
        },
        runtime.id,
      ),
      /ROOM_DELETE_NOT_VERIFIED/,
    );
  }
  assert.deepEqual(exactQueries, [[runtime.id]]);
});

test('LiveKit cleanup counts only exact claimed and officially observed room publisher SID tuples', async () => {
  let now = Date.parse('2026-07-22T00:30:00.000Z');
  let roomPresent = true;
  let roomDeleteFails = true;
  let retry: (() => Promise<any>) | undefined;
  let observe: ((sessionId: string, participant: any, publication: any) => void) | undefined;
  const timeline: TimelineItem[] = [];
  const adapter = new DeviceSessionAdapter(
    {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret-with-sufficient-length-0123456789',
      agentName: 'my-agent',
      sessionTtlSeconds: 600,
      tokenTtlSeconds: 300,
    },
    {
      roomService: {
        async createRoom() {
          roomPresent = true;
          return {};
        },
        async listParticipants() {
          return [];
        },
        async deleteRoom() {
          if (roomDeleteFails) throw new Error('room deletion failed');
          roomPresent = false;
        },
        async listRooms(names?: string[]) {
          return roomPresent && names?.[0] ? [{ name: names[0] }] : [];
        },
      },
      now: () => now,
      enableGatewayJoin: false,
      scheduleCleanupRetry: (callback) => {
        retry = callback;
        return { unref() {} };
      },
      bindLiveKitObservationTestSeam: (observer) => {
        observe = observer;
      },
    },
  );
  const sessionId = (await adapter.createConnectionDetails({})).roomName;
  adapter.subscribe(sessionId, (item) => timeline.push(item));
  assert.ok(observe);

  const claim = (
    index: number,
    sid: string,
    publisher: string,
    origin?: EventEnvelope['origin'],
  ): EventEnvelope => {
    const event = temporaryMediaEvent(
      sessionId,
      now + index,
      'livekit_track',
      `livekit://${sessionId}/${publisher}/${sid}`,
      sid,
    );
    event.event_id = `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    event.idempotency_key = `livekit-claim-${index}`;
    event.sequence = { stream_id: `vision_${index}`, number: 1 };
    if (origin) event.origin = origin;
    return event;
  };

  observe(sessionId, { identity: 'rayneo_01' }, { sid: 'TR_observation_only' });
  const native = claim(1, 'TR_native_001', 'rayneo_01');
  observe(sessionId, { identity: 'rayneo_01' }, { sid: 'TR_native_001' });
  const nativeResult = adapter.ingest(sessionId, native, 'rayneo_01');
  assert.equal(nativeResult.accepted, true, JSON.stringify(nativeResult));
  observe('phase0_session_wrong', { identity: 'rayneo_01' }, { sid: 'TR_native_001' });
  observe(sessionId, { identity: 'rayneo_wrong' }, { sid: 'TR_native_001' });
  observe(sessionId, { identity: 'rayneo_01' }, { sid: 'TR_wrong_sid' });
  observe(sessionId, { identity: 'rayneo_01' }, { sid: undefined });
  observe(sessionId, { identity: 'rayneo_01' }, { sid: 'TR_native_001' });
  observe(sessionId, { identity: 'rayneo_01' }, { sid: 'TR_native_001' });

  const watch = claim(2, 'TR_watch_001', 'iphone_relay_01', {
    device_id: 'watch_01',
    device_class: 'apple_watch',
    client_instance_id: 'watch_client_01',
    relay: {
      relay_device_id: 'iphone_relay_01',
      relay_device_class: 'iphone',
      transport: 'watch_connectivity',
    },
  });
  observe(sessionId, { identity: 'iphone_relay_01' }, { sid: 'TR_watch_001' });
  assert.equal(adapter.ingest(sessionId, watch, 'iphone_relay_01').accepted, true);

  const phantom = claim(3, 'TR_phantom_001', 'rayneo_01');
  assert.deepEqual(adapter.ingest(sessionId, phantom, 'rayneo_01').errors, [
    'LIVEKIT_PUBLICATION_NOT_OBSERVED',
  ]);
  const contradicted = claim(4, 'TR_context_001', 'rayneo_01');
  observe(sessionId, { identity: 'rayneo_01' }, { sid: 'TR_context_001' });
  const contradictedResult = adapter.ingest(sessionId, contradicted, 'foreign_publisher');
  assert.equal(contradictedResult.accepted, false);
  assert.deepEqual(contradictedResult.errors, ['LIVEKIT_MEDIA_ROOM_BINDING_MISMATCH']);

  await assert.rejects(adapter.stopSession(sessionId), /room deletion failed/);
  assert.equal(
    timeline.some((item) => item.verifiedCleanup === true),
    false,
  );
  roomDeleteFails = false;
  const receipt = await retry?.();
  assert.ok(receipt);
  assert.equal(receipt.payload.removed.media_objects, 2);
  assert.equal(roomPresent, false);
});

test('connection request remains exact empty closed-map with no dispatch surface', () => {
  for (const agent of [null, 1, 'my-agent', true]) {
    assert.throws(
      () => assertDispatchRequest({ room_config: { agents: [agent] } }, 'my-agent'),
      /CONNECTION_REQUEST_CLOSED_MAP/,
    );
  }
  assert.throws(
    () => assertDispatchRequest({ room_config: { agents: [{ agent_name: 'my-agent' }] } }),
    /CONNECTION_REQUEST_CLOSED_MAP/,
  );
  assert.doesNotThrow(() => assertDispatchRequest({}));
});

test('official primitive state is one-flight, stable-id deduped, and text-independent', () => {
  const state = new OfficialPrimitiveState();
  const agentIdentity = 'agent-AJ_ONE';
  assert.throws(() => state.inspectPrompt('prompt-before-greeting'), /AGENT_GREETING_NOT_OBSERVED/);
  assert.deepEqual(state.inspectFinal('greeting-final-1', agentIdentity), {
    kind: 'greeting',
  });
  state.commitGreeting('greeting-final-1', agentIdentity);
  assert.equal(state.inspectPrompt('prompt-before-greeting'), 'new');
  state.commitPrompt('prompt-before-greeting', '00000000-0000-4000-8000-000000000101', 1000);
  assert.throws(() => state.inspectPrompt('prompt-id-2-fast'), /MODEL_REQUEST_ALREADY_IN_FLIGHT/);
  assert.throws(
    () => state.inspectFinal('result-spoof', 'agent-AJ_TWO'),
    /OFFICIAL_AGENT_IDENTITY_DRIFT/,
  );
  const result = state.inspectFinal('result-final-1', agentIdentity);
  assert.equal(result.kind, 'result');
  if (result.kind === 'result') {
    state.commitResult('result-final-1', agentIdentity, result.pending.requestEventId);
  }
  assert.equal(state.inspectPrompt('prompt-id-2-fast'), 'new');
  state.commitPrompt('prompt-id-2-same-text-new-id', '00000000-0000-4000-8000-000000000102', 2000);
  assert.equal(state.inspectPrompt('prompt-id-2-same-text-new-id'), 'duplicate');
  assert.deepEqual(state.inspectFinal('result-final-2', agentIdentity), {
    kind: 'result',
    pending: {
      requestEventId: '00000000-0000-4000-8000-000000000102',
      requestedAt: 2000,
    },
  });
  state.commitResult('result-final-2', agentIdentity, '00000000-0000-4000-8000-000000000102');
  assert.deepEqual(state.inspectFinal('result-final-2', agentIdentity), {
    kind: 'duplicate',
  });

  assert.throws(
    () => state.inspectFinal('unsolicited-final', agentIdentity),
    /UNSOLICITED_AGENT_FINAL/,
  );
  assert.equal(state.inspectPrompt('prompt-after-unsolicited-final'), 'new');
  state.commitPrompt(
    'prompt-after-unsolicited-final',
    '00000000-0000-4000-8000-000000000103',
    3000,
  );
  assert.deepEqual(state.inspectFinal('unsolicited-final', agentIdentity), {
    kind: 'result',
    pending: {
      requestEventId: '00000000-0000-4000-8000-000000000103',
      requestedAt: 3000,
    },
  });

  const cache = new ModelCorrelationCache();
  const requestEntry = cache.recordRequest('00000000-0000-4000-8000-000000000201');
  const resultEntry = cache.recordResult(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
  );
  assert.equal(resultEntry, requestEntry, 'request/result must share one correlation entry');
  assert.equal(cache.size, 1);
  assert.equal(resultEntry.resultEventId, '00000000-0000-4000-8000-000000000202');
  assert.throws(
    () =>
      cache.recordResult(
        '00000000-0000-4000-8000-000000000299',
        '00000000-0000-4000-8000-000000000203',
      ),
    /MODEL_CACHE_REQUEST_NOT_FOUND/,
  );
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.isEmpty(), true);
});

test('primitive-scoped IDs are deterministic, bounded, and collision-resistant for hostile punctuation and tails', () => {
  const punctuationA = primitiveScopedId('chat_message', 'a.b');
  const punctuationB = primitiveScopedId('chat_message', 'a?b');
  const longA = primitiveScopedId('transcription', `${'x'.repeat(256)}A`);
  const longB = primitiveScopedId('transcription', `${'x'.repeat(256)}B`);
  assert.notEqual(punctuationA, punctuationB);
  assert.notEqual(longA, longB);
  assert.equal(primitiveScopedId('chat_message', 'a.b'), punctuationA);
  for (const value of [punctuationA, punctuationB, longA, longB]) {
    assert.match(value, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(value.length <= 64);
  }
});

test('cleanup failure retains state and bounded retry emits one truthful receipt before tombstone TTL', async () => {
  let now = Date.parse('2026-07-22T00:00:00.000Z');
  let roomPresent = true;
  let deleteFails = true;
  let deleteCalls = 0;
  let activeRoomName: string | undefined;
  const roomVerificationQueries: string[][] = [];
  let retryDelayMs: number | undefined;
  let scheduledRetry: (() => Promise<any>) | undefined;
  const roomService = {
    async createRoom(options: { name?: string }) {
      activeRoomName = options.name;
      return {};
    },
    async listParticipants(_room: string) {
      return [];
    },
    async deleteRoom(_room: string) {
      deleteCalls += 1;
      if (deleteFails) throw new Error('transport failed');
      roomPresent = false;
    },
    async listRooms(names?: string[]) {
      assert.deepEqual(names, [activeRoomName]);
      roomVerificationQueries.push([...(names ?? [])]);
      return roomPresent && activeRoomName ? [{ name: activeRoomName }] : [];
    },
  };
  const adapter = new DeviceSessionAdapter(
    {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret-with-sufficient-length-0123456789',
      agentName: 'my-agent',
      sessionTtlSeconds: 600,
      tokenTtlSeconds: 300,
    },
    {
      roomService,
      now: () => now,
      enableGatewayJoin: false,
      scheduleCleanupRetry: (callback, delayMs) => {
        scheduledRetry = callback;
        retryDelayMs = delayMs;
        return { unref() {} };
      },
      cancelCleanupRetry: () => {
        scheduledRetry = undefined;
      },
    },
  );
  const details = await adapter.createConnectionDetails({});
  const sessionId = details.roomName;
  const timeline: TimelineItem[] = [];
  let staleSubscriberThrows = 0;
  let sessionExistedAtReceipt: boolean | undefined;
  adapter.subscribe(sessionId, (item) => {
    if (item.eventType === 'paios.phase0.demo.session.ended') {
      staleSubscriberThrows += 1;
      throw new Error('stale subscriber');
    }
  });

  const validExternalCleanup = (
    loadFrozenArtifacts(CONTRACT_SCHEMA_VERSION_V0_3).validFixture.events as EventEnvelope[]
  ).find((event) => event.event_type === 'paios.phase0.demo.session.cleanup.completed');
  assert.ok(
    validExternalCleanup,
    'frozen valid fixture must include a schema-valid cleanup receipt',
  );
  const externalCleanupResult = adapter.ingest(sessionId, structuredClone(validExternalCleanup));
  assert.equal(externalCleanupResult.accepted, false);
  assert.deepEqual(externalCleanupResult.errors, ['CLEANUP_RECEIPT_INTERNAL_ONLY']);
  assert.equal(
    timeline.some((item) => item.verifiedCleanup === true),
    false,
  );
  adapter.subscribe(sessionId, (item) => {
    timeline.push(item);
    if (item.eventType === 'paios.phase0.demo.session.cleanup.completed') {
      sessionExistedAtReceipt = adapter.sessionExists(sessionId);
    }
  });

  const firstStop = adapter.stopSession(sessionId);
  const concurrentStop = adapter.stopSession(sessionId, 'error');
  assert.equal(concurrentStop, firstStop);
  await assert.rejects(firstStop, /transport failed/);
  assert.equal(staleSubscriberThrows, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(adapter.sessionExists(sessionId), true);
  assert.equal(
    timeline.some((item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed'),
    false,
  );
  assert.equal(
    timeline.some((item) => item.displayText === 'cleanup complete'),
    false,
  );
  assert.ok(retryDelayMs !== undefined && retryDelayMs > 0 && retryDelayMs <= 1_000);
  const retry = scheduledRetry;
  assert.ok(retry);

  deleteFails = false;
  const receipt = await retry();
  assert.ok(receipt);
  assert.equal(receipt.event_type, 'paios.phase0.demo.session.cleanup.completed');
  assert.equal(receipt.payload.removed.events, 2);
  assert.equal(receipt.payload.removed.session_rows, 1);
  assert.equal(deleteCalls, 2);
  assert.deepEqual(roomVerificationQueries, [[sessionId]]);
  assert.equal(staleSubscriberThrows, 1);
  assert.equal(adapter.sessionExists(sessionId), false);
  assert.equal(sessionExistedAtReceipt, false);
  assert.equal(
    timeline.filter((item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed')
      .length,
    1,
  );
  assert.equal(timeline.filter((item) => item.verifiedCleanup === true).length, 1);
  assert.equal(timeline.filter((item) => item.displayText === 'cleanup complete').length, 1);

  const exactRetry = adapter.ingest(sessionId, structuredClone(receipt));
  assert.equal(exactRetry.accepted, true);
  assert.equal(exactRetry.retry, true);
  assert.equal(exactRetry.acceptedEffectCount, 3);
  assert.throws(() => adapter.ingest(sessionId, {}), /EVENT_AFTER_CLEANUP/);
  now += 3_600_000;
  assert.throws(() => adapter.ingest(sessionId, receipt), /SESSION_NOT_FOUND/);

  let noOwnerNow = Date.parse('2026-07-22T02:00:00.000Z');
  const noOwnerRooms = new Set<string>();
  const noOwnerAdapter = new DeviceSessionAdapter(
    {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret-with-sufficient-length-0123456789',
      agentName: 'my-agent',
      sessionTtlSeconds: 600,
      tokenTtlSeconds: 300,
    },
    {
      roomService: {
        async createRoom(options: { name: string }) {
          noOwnerRooms.add(options.name);
          return {};
        },
        async listParticipants(_room: string) {
          return [];
        },
        async deleteRoom(room: string) {
          noOwnerRooms.delete(room);
        },
        async listRooms(names?: string[]) {
          assert.equal(names?.length, 1);
          return names?.filter((name) => noOwnerRooms.has(name)).map((name) => ({ name })) ?? [];
        },
      },
      now: () => noOwnerNow,
      enableGatewayJoin: false,
    },
  );
  const noOwnerDetails = await noOwnerAdapter.createConnectionDetails({});
  const noOwnerEvent = temporaryMediaEvent(
    noOwnerDetails.roomName,
    noOwnerNow,
    'ephemeral_object',
    `ephemeral://session/${noOwnerDetails.roomName}/object/source_runner_media_001`,
  );
  const noOwnerResult = noOwnerAdapter.ingest(noOwnerDetails.roomName, noOwnerEvent);
  assert.equal(noOwnerResult.accepted, false);
  assert.deepEqual(noOwnerResult.errors, ['EPHEMERAL_RESOURCE_OWNER_REQUIRED']);
  assert.equal(noOwnerResult.acceptedEffectCount, 1);
  const noOwnerReceipt = await noOwnerAdapter.stopSession(noOwnerDetails.roomName);
  assert.equal(noOwnerReceipt.payload.removed.events, 2);
  assert.equal(noOwnerReceipt.payload.removed.media_objects, 0);
  assert.equal(noOwnerReceipt.payload.removed.model_cache_entries, 0);

  let ownedNow = Date.parse('2026-07-22T03:00:00.000Z');
  const ownedRooms = new Set<string>();
  const ownedDeletedRooms: string[] = [];
  const ownedRoomVerificationQueries: string[][] = [];
  let objectMode: 'delete_failure' | 'verify_failure' | 'success' = 'delete_failure';
  let ownedScheduledRetry: (() => Promise<any>) | undefined;
  let objectPresent = true;
  let handleSequence = 0;
  let observeOwnedLiveKit:
    | ((sessionId: string, participant: any, publication: any) => void)
    | undefined;
  const boundHandles: object[] = [];
  const bindInputs: Array<{
    sessionId: string;
    mediaRef: Readonly<Record<string, any>>;
  }> = [];
  const retryStateSnapshots: Array<
    readonly Readonly<{
      resourceKey: string;
      mediaRefDigest: string;
    }>[]
  > = [];
  const ownedAdapter = new DeviceSessionAdapter(
    {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret-with-sufficient-length-0123456789',
      agentName: 'my-agent',
      sessionTtlSeconds: 600,
      tokenTtlSeconds: 300,
    },
    {
      roomService: {
        async createRoom(options: { name: string }) {
          ownedRooms.add(options.name);
          return {};
        },
        async listParticipants(_room: string) {
          return [];
        },
        async deleteRoom(room: string) {
          ownedDeletedRooms.push(room);
          ownedRooms.delete(room);
        },
        async listRooms(names?: string[]) {
          assert.equal(names?.length, 1);
          ownedRoomVerificationQueries.push([...(names ?? [])]);
          return names?.filter((name) => ownedRooms.has(name)).map((name) => ({ name })) ?? [];
        },
      },
      now: () => ownedNow,
      enableGatewayJoin: false,
      scheduleCleanupRetry: (callback) => {
        ownedScheduledRetry = callback;
        return { unref() {} };
      },
      bindLiveKitObservationTestSeam: (observe) => {
        observeOwnedLiveKit = observe;
      },
      retryStateProbe: (state) => retryStateSnapshots.push(state),
      ephemeralObjectOwner: {
        bind(boundSessionId, mediaRef) {
          bindInputs.push({ sessionId: boundSessionId, mediaRef });
          const mediaId = mediaRef.media_id;
          const expectedLocator = `ephemeral://session/${boundSessionId}/object/${mediaId}`;
          if (
            (mediaId === 'source_runner_media_001' || mediaId === 'source_runner_media_002') &&
            mediaRef.locator === expectedLocator &&
            mediaRef.byte_length === 128 &&
            typeof mediaRef.sha256 === 'string'
          ) {
            const handle = Object.freeze({ opaque: ++handleSequence });
            boundHandles.push(handle);
            return { resourceKey: 'ephemeral:source-runner:001', handle };
          }
          return undefined;
        },
        async deleteObject(handle) {
          assert.ok(boundHandles.includes(handle));
          if (objectMode === 'delete_failure') throw new Error('ephemeral delete failed');
          if (objectMode === 'success') objectPresent = false;
        },
        async objectIsAbsent(_handle) {
          return !objectPresent;
        },
      },
    },
  );
  const ownedDetails = await ownedAdapter.createConnectionDetails({});
  const ownedSessionId = ownedDetails.roomName;
  const crossSessionEvent = temporaryMediaEvent(
    ownedSessionId,
    ownedNow,
    'ephemeral_object',
    'ephemeral://session/phase0_session_other/object/source_runner_media_001',
  );
  const crossSessionResult = ownedAdapter.ingest(ownedSessionId, crossSessionEvent);
  assert.equal(crossSessionResult.accepted, false);
  assert.deepEqual(crossSessionResult.errors, ['EPHEMERAL_RESOURCE_NOT_OWNED']);
  const foreignRoomEvent = temporaryMediaEvent(
    ownedSessionId,
    ownedNow,
    'livekit_track',
    'livekit://phase0_session_other/rayneo_01/TR_source_runner_media_001',
    'TR_source_runner_media_001',
  );
  const foreignRoomResult = ownedAdapter.ingest(ownedSessionId, foreignRoomEvent, 'rayneo_01');
  assert.equal(foreignRoomResult.accepted, false);
  assert.deepEqual(foreignRoomResult.errors, [
    'LIVEKIT_SESSION_MISMATCH',
    'LIVEKIT_PUBLICATION_NOT_OBSERVED',
  ]);

  const ownedEvent = temporaryMediaEvent(
    ownedSessionId,
    ownedNow,
    'ephemeral_object',
    `ephemeral://session/${ownedSessionId}/object/source_runner_media_001`,
  );
  assert.equal(ownedAdapter.ingest(ownedSessionId, ownedEvent).accepted, true);

  const secondDetails = await ownedAdapter.createConnectionDetails({});
  const secondSessionEvent = temporaryMediaEvent(
    secondDetails.roomName,
    ownedNow,
    'ephemeral_object',
    `ephemeral://session/${secondDetails.roomName}/object/source_runner_media_001`,
  );
  const secondSessionResult = ownedAdapter.ingest(secondDetails.roomName, secondSessionEvent);
  assert.equal(secondSessionResult.accepted, false);
  assert.deepEqual(secondSessionResult.errors, ['EPHEMERAL_RESOURCE_CROSS_SESSION']);
  await ownedAdapter.stopSession(secondDetails.roomName);

  const driftingResourceEvent = temporaryMediaEvent(
    ownedSessionId,
    ownedNow,
    'ephemeral_object',
    `ephemeral://session/${ownedSessionId}/object/source_runner_media_002`,
    'source_runner_media_002',
  );
  driftingResourceEvent.event_id = '20000000-0000-4000-8000-000000000005';
  driftingResourceEvent.idempotency_key = 'source-runner-temporary-media-drift';
  driftingResourceEvent.sequence = {
    ...driftingResourceEvent.sequence,
    number: 2,
    previous_event_id: ownedEvent.event_id,
  };
  const driftResult = ownedAdapter.ingest(ownedSessionId, driftingResourceEvent);
  assert.equal(driftResult.accepted, false);
  assert.deepEqual(driftResult.errors, ['EPHEMERAL_RESOURCE_BINDING_DRIFT']);
  assert.equal(driftResult.acceptedEffectCount, 2);

  const duplicateResourceEvent = structuredClone(ownedEvent);
  duplicateResourceEvent.event_id = '20000000-0000-4000-8000-000000000003';
  duplicateResourceEvent.idempotency_key = 'source-runner-temporary-media-duplicate';
  duplicateResourceEvent.sequence = {
    ...duplicateResourceEvent.sequence,
    number: 2,
    previous_event_id: ownedEvent.event_id,
  };
  assert.equal(ownedAdapter.ingest(ownedSessionId, duplicateResourceEvent).accepted, true);
  const ownedLiveKitEvent = temporaryMediaEvent(
    ownedSessionId,
    ownedNow,
    'livekit_track',
    `livekit://${ownedSessionId}/rayneo_01/TR_source_runner_media_001`,
    'TR_source_runner_media_001',
  );
  ownedLiveKitEvent.event_id = '20000000-0000-4000-8000-000000000004';
  ownedLiveKitEvent.idempotency_key = 'source-runner-livekit-media';
  ownedLiveKitEvent.sequence = {
    ...ownedLiveKitEvent.sequence,
    number: 3,
    previous_event_id: duplicateResourceEvent.event_id,
  };
  assert.ok(observeOwnedLiveKit);
  observeOwnedLiveKit(
    ownedSessionId,
    { identity: 'rayneo_01' },
    { sid: 'TR_source_runner_media_001' },
  );
  assert.equal(ownedAdapter.ingest(ownedSessionId, ownedLiveKitEvent, 'rayneo_01').accepted, true);
  const duplicateLiveKitEvent = structuredClone(ownedLiveKitEvent);
  duplicateLiveKitEvent.event_id = '20000000-0000-4000-8000-000000000006';
  duplicateLiveKitEvent.idempotency_key = 'source-runner-livekit-media-duplicate';
  duplicateLiveKitEvent.sequence = {
    ...duplicateLiveKitEvent.sequence,
    number: 4,
    previous_event_id: ownedLiveKitEvent.event_id,
  };
  assert.equal(
    ownedAdapter.ingest(ownedSessionId, duplicateLiveKitEvent, 'rayneo_01').accepted,
    true,
  );
  assert.equal(bindInputs.at(-1)?.sessionId, ownedSessionId);
  assert.equal(Object.isFrozen(bindInputs.at(-1)?.mediaRef), true);

  const ownedTimeline: TimelineItem[] = [];
  ownedAdapter.subscribe(ownedSessionId, (item) => ownedTimeline.push(item));
  await assert.rejects(ownedAdapter.stopSession(ownedSessionId), /ephemeral delete failed/);
  const retainedRetryState = retryStateSnapshots.at(-1);
  assert.ok(retainedRetryState);
  assert.equal(retainedRetryState.length, 1);
  assert.match(retainedRetryState[0]!.mediaRefDigest, /^[a-f0-9]{64}$/);
  const retainedRetryText = JSON.stringify(retainedRetryState);
  for (const personalValue of [
    `ephemeral://session/${ownedSessionId}/object/source_runner_media_001`,
    'image/jpeg',
    'capture_mode',
    'expires_at',
    'media_id',
  ])
    assert.equal(retainedRetryText.includes(personalValue), false, personalValue);
  assert.equal(ownedDeletedRooms.filter((room) => room === ownedSessionId).length, 0);
  assert.equal(ownedAdapter.sessionExists(ownedSessionId), true);
  assert.equal(
    ownedTimeline.some((item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed'),
    false,
  );
  objectMode = 'verify_failure';
  const verifyRetry = ownedScheduledRetry;
  assert.ok(verifyRetry);
  assert.equal(await verifyRetry(), undefined);
  assert.equal(ownedDeletedRooms.filter((room) => room === ownedSessionId).length, 0);
  assert.equal(ownedAdapter.sessionExists(ownedSessionId), true);
  assert.equal(
    ownedTimeline.some((item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed'),
    false,
  );
  objectMode = 'success';
  const successRetry = ownedScheduledRetry;
  assert.ok(successRetry);
  const ownedReceipt = await successRetry();
  assert.ok(ownedReceipt);
  assert.equal(ownedReceipt.payload.removed.events, 6);
  assert.equal(ownedReceipt.payload.removed.media_objects, 2);
  assert.equal(ownedReceipt.payload.removed.session_rows, 1);
  assert.equal(ownedReceipt.payload.removed.model_cache_entries, 0);
  assert.equal(ownedDeletedRooms.filter((room) => room === ownedSessionId).length, 1);
  assert.ok(
    ownedRoomVerificationQueries.some((names) => names.length === 1 && names[0] === ownedSessionId),
  );
  assert.equal(objectPresent, false);
  assert.deepEqual(retryStateSnapshots.at(-1), []);
  assert.ok(boundHandles.length >= 2, 'owner may return fresh handles for one stable resource key');
  assert.equal(
    ownedTimeline.filter((item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed')
      .length,
    1,
  );
  const ownedExactRetry = ownedAdapter.ingest(ownedSessionId, structuredClone(ownedReceipt));
  assert.equal(ownedExactRetry.retry, true);
  assert.equal(ownedExactRetry.acceptedEffectCount, 7);

  let delayedNow = Date.parse('2026-07-22T04:00:00.000Z');
  let delayedRoomPresent = true;
  let delayedRoomDeleteFails = true;
  let delayedRetry: (() => Promise<any>) | undefined;
  let delayedRetryDelayMs: number | undefined;
  const delayedTimeline: TimelineItem[] = [];
  const delayedAdapter = new DeviceSessionAdapter(
    {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret-with-sufficient-length-0123456789',
      agentName: 'my-agent',
      sessionTtlSeconds: 600,
      tokenTtlSeconds: 300,
    },
    {
      roomService: {
        async createRoom() {
          return {};
        },
        async listParticipants(_room: string) {
          return [];
        },
        async deleteRoom(_room: string) {
          if (delayedRoomDeleteFails) throw new Error('delayed room failure');
          delayedRoomPresent = false;
        },
        async listRooms(names?: string[]) {
          return delayedRoomPresent && names?.[0] ? [{ name: names[0] }] : [];
        },
      },
      now: () => delayedNow,
      enableGatewayJoin: false,
      scheduleCleanupRetry: (callback, delayMs) => {
        delayedRetry = callback;
        delayedRetryDelayMs = delayMs;
        return { unref() {} };
      },
    },
  );
  const delayedDetails = await delayedAdapter.createConnectionDetails({});
  delayedAdapter.subscribe(delayedDetails.roomName, (item) => delayedTimeline.push(item));
  await assert.rejects(delayedAdapter.stopSession(delayedDetails.roomName), /delayed room failure/);
  delayedNow += 300_000;
  const deadlineRetry = delayedRetry;
  assert.ok(deadlineRetry);
  assert.equal(await deadlineRetry(), undefined);
  const postDeadlineRetry = delayedRetry;
  assert.ok(postDeadlineRetry);
  assert.notEqual(postDeadlineRetry, deadlineRetry);
  assert.equal(delayedRetryDelayMs, 1_000);
  delayedNow += 1_000;
  delayedRoomDeleteFails = false;
  assert.equal(await postDeadlineRetry(), undefined);
  assert.equal(delayedRoomPresent, false);
  assert.equal(delayedAdapter.sessionExists(delayedDetails.roomName), false);
  assert.equal(delayedAdapter.terminalFailureCode(delayedDetails.roomName), 'CLEANUP_SLA_MISSED');
  assert.equal(
    delayedTimeline.some(
      (item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed',
    ),
    false,
  );
  assert.ok(delayedTimeline.some((item) => item.errors?.includes('CLEANUP_SLA_MISSED')));
  assert.throws(
    () => delayedAdapter.ingest(delayedDetails.roomName, {}),
    /CLEANUP_TERMINAL_FAILURE:CLEANUP_SLA_MISSED/,
  );
  await assert.rejects(
    delayedAdapter.stopSession(delayedDetails.roomName),
    /CLEANUP_TERMINAL_FAILURE:CLEANUP_SLA_MISSED/,
  );
  delayedNow += 3_600_000;
  assert.equal(delayedAdapter.terminalFailureCode(delayedDetails.roomName), undefined);
  assert.throws(() => delayedAdapter.ingest(delayedDetails.roomName, {}), /SESSION_NOT_FOUND/);

  let sleptNow = Date.parse('2026-07-22T05:00:00.000Z');
  let sleptRoomPresent = true;
  const sleptTimeline: TimelineItem[] = [];
  const sleptAdapter = new DeviceSessionAdapter(
    {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret-with-sufficient-length-0123456789',
      agentName: 'my-agent',
      sessionTtlSeconds: 600,
      tokenTtlSeconds: 300,
    },
    {
      roomService: {
        async createRoom() {
          return {};
        },
        async listParticipants(_room: string) {
          return [];
        },
        async deleteRoom(_room: string) {
          sleptRoomPresent = false;
        },
        async listRooms(names?: string[]) {
          return sleptRoomPresent && names?.[0] ? [{ name: names[0] }] : [];
        },
      },
      now: () => sleptNow,
      enableGatewayJoin: false,
    },
  );
  const sleptDetails = await sleptAdapter.createConnectionDetails({});
  sleptAdapter.subscribe(sleptDetails.roomName, (item) => sleptTimeline.push(item));
  sleptNow += 900_001;
  await assert.rejects(
    sleptAdapter.stopSession(sleptDetails.roomName),
    /CLEANUP_TERMINAL_FAILURE:CLEANUP_SLA_MISSED/,
  );
  assert.equal(sleptRoomPresent, false);
  assert.equal(sleptAdapter.sessionExists(sleptDetails.roomName), false);
  assert.equal(sleptAdapter.terminalFailureCode(sleptDetails.roomName), 'CLEANUP_SLA_MISSED');
  assert.equal(
    sleptTimeline.some((item) => item.eventType === 'paios.phase0.demo.session.ended'),
    false,
  );
  assert.equal(
    sleptTimeline.some((item) => item.eventType === 'paios.phase0.demo.session.cleanup.completed'),
    false,
  );
});

test('dashboard reconciles cleanup receipts and vanished active sessions without false stream errors', () => {
  const html = renderDashboard('source-repair-nonce');
  assert.ok(html.includes('paios.phase0.demo.session.cleanup.completed'));
  assert.equal(html.includes("markCleaned(id, 'cleaned externally')"), false);
  assert.ok(html.includes("markUnavailable(id, 'cleanup unverified')"));
  assert.ok(html.includes("wrapper.dataset.state = 'unavailable'"));
  assert.ok(html.includes("stop.textContent = 'Unavailable'"));
  assert.ok(html.includes('const active = new Set(state.activeSessions)'));
  assert.ok(html.includes("state.textContent = 'reconciling'"));
  assert.equal(html.includes("item.displayText === 'cleanup complete'"), false);
  assert.ok(html.includes('item.verifiedCleanup === true'));
  assert.equal(
    html.includes(
      "if (item.eventType === 'paios.phase0.demo.session.cleanup.completed') markCleaned(id);",
    ),
    false,
  );
  assert.equal(html.match(/markCleaned\(id\);/g)?.length, 2);
  assert.equal(html.includes('EVENT_STREAM_CLOSED'), false);
  assert.ok(html.includes('textContent'));
  assert.ok(html.includes('nonce="source-repair-nonce"'));
});

test('v0.2 consumer postimage SHA-256 values are emitted for the evidence receipt', () => {
  for (const path of [
    '../src/contract-consumer.ts',
    '../src/device-session-adapter.ts',
    '../src/dashboard.ts',
    './contract-consumer.test.ts',
    './room-loopback.test.ts',
    '../demo-loopback.ps1',
    '../README.md',
    '../../evidence/gateway-room/thin-adapter/CONTRACT_CHANGE_RFC_GA1_GATEWAY_IDENTITY_R1.md',
    '../../evidence/gateway-room/thin-adapter/G_A1_SOURCE_RUNNER_REPAIR_R3.md',
    '../../evidence/gateway-room/thin-adapter/G_A1_V0_2_CONSUMER_ALIGNMENT_R1.md',
  ]) {
    const url = new URL(path, import.meta.url);
    console.log(`SOURCE_SHA256 ${path} ${sha256File(url)}`);
  }
});

test(
  'official direct loop has one outbound chat path and no remote chat command path',
  {
    timeout: process.env.G_A1_R5_1_503_STRESS === '1' ? 200_000 : 180_000,
  },
  async () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/device-session-adapter.ts', import.meta.url)),
      'utf8',
    );
    assert.equal(source.includes('RoomEvent.ChatMessage'), false);
    assert.equal(source.includes("registerTextStreamHandler('lk.chat'"), false);
    assert.equal(source.match(/sendChatMessage\(/g)?.length, 1);

    const runner = readFileSync(
      fileURLToPath(new URL('../demo-loopback.ps1', import.meta.url)),
      'utf8',
    );
    assert.equal(runner.includes('RandomNumberGenerator]::Fill'), false);
    assert.equal(runner.includes('.ArgumentList'), false);
    assert.equal(runner.includes('.Kill($true)'), false);
    assert.ok(runner.includes('ConvertTo-WindowsCommandLineArgument'));
    assert.ok(runner.includes('.EnvironmentVariables'));
    assert.ok(runner.includes("'Run', 'Stop', 'Preflight', 'SelfTest'"));
    assert.ok(runner.includes('GetActiveTcpListeners'));
    assert.ok(runner.includes('GetActiveUdpListeners'));
    for (const port of ['3000', '6567', '7880', '7881', '8787', '11434', '7882']) {
      assert.ok(runner.includes(port), port);
    }
    assert.ok(runner.includes("NEXT_TELEMETRY_DISABLED = '1'"));
    assert.ok(runner.includes('StartTicks'));
    assert.ok(runner.includes('CreateProcessW'));
    assert.ok(runner.includes('AssignProcessToJobObject'));
    assert.ok(runner.includes('ResumeThread'));
    assert.ok(runner.includes('JOBOBJECT_EXTENDED_LIMIT_INFORMATION'));
    assert.ok(runner.includes('CONTROL_STOP_ALREADY_CLAIMED'));
    assert.ok(runner.includes('Wait-AgentRegistrationReadiness'));
    assert.ok(runner.includes('request.Proxy = $null'));
    assert.ok(runner.includes('request.AllowAutoRedirect = $false'));
    assert.ok(runner.includes("'application/json'"));
    assert.ok(runner.includes("'JT_ROOM'"));
    assert.equal(runner.includes('Stop-OwnedProcessTree'), false);
    assert.equal(runner.includes("'System32\\taskkill.exe'"), false);

    const runReadiness503Vector = async (iteration: number) => {
      const sentinel = startForeignSentinel();
      try {
        const result = runPowerShell([
          '-Action',
          'SelfTest',
          '-SelfTestMode',
          'AgentReadinessFixture',
          '-FixtureAgentMode',
          '503',
        ]);
        assert.notEqual(
          result.status,
          0,
          `503 iteration ${iteration}: ${result.stdout}\n${result.stderr}`,
        );
        assert.equal(result.stdout.includes('RUNNER_READY'), false, `503 iteration ${iteration}`);
        assert.match(
          `${result.stdout}${result.stderr}`,
          /AGENT_REGISTRATION_READINESS_TIMEOUT last_error=AGENT_HEALTH_STATUS_503/,
        );
        const control = /RUNNER_CONTROL_READY control_id=([0-9a-f]{24})/.exec(result.stdout)?.[1];
        const ownedPid = Number(/AGENT_FIXTURE_STARTED owned_pid=(\d+)/.exec(result.stdout)?.[1]);
        const descendantPid = Number(/AGENT_FIXTURE_DESCENDANT_PID=(\d+)/.exec(result.stdout)?.[1]);
        assert.ok(control);
        assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
        assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
        assert.equal(pidExists(ownedPid), false);
        assert.equal(pidExists(descendantPid), false);
        assert.equal(await portIsFree(6567), true, `503 iteration ${iteration}`);
        const late = runPowerShell(['-Action', 'Stop', '-ControlId', control!], 10_000);
        assert.notEqual(late.status, 0);
        assert.match(`${late.stdout}${late.stderr}`, /CONTROL_NOT_ACTIVE/);
        assert.equal(pidExists(sentinel.pid!), true, `foreign sentinel ${iteration}`);
        console.log(
          `R5_1_503_ITERATION iteration=${String(iteration + 1).padStart(2, '0')} runner_nonzero=1 ready_absent=1 owned=0 descendant=0 port6567_free=1 control_disposed=1 foreign_alive=1`,
        );
      } finally {
        await stopForeignSentinel(sentinel);
      }
    };

    if (process.env.G_A1_R5_1_503_STRESS === '1') {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        await runReadiness503Vector(iteration);
      }
      console.log('R5_1_503_STRESS iterations=20 consecutive_pass=20 cleanup_bound_seconds=15');
      return;
    }

    const selfTest = runPowerShell(['-Action', 'SelfTest']);
    assert.equal(selfTest.status, 0, `${selfTest.stdout}\n${selfTest.stderr}`);
    assert.equal(selfTest.stderr, '');
    assert.match(selfTest.stdout, /SELFTEST_OK services_started=0 .* cases=10 critical=0/);

    for (const arguments_ of [
      ['-Action', 'Stop'],
      ['-Action', 'Stop', '-ControlId', 'ABC'],
      ['-Action', 'Stop', '-ControlId', 'f'.repeat(25)],
    ]) {
      const result = runPowerShell(arguments_);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /INVALID_OR_MISSING_CONTROL_ID/);
    }

    for (const [index, stage] of ['startup', 'readiness', 'steady'].entries()) {
      const port = await findFixturePort(45200 + index * 50);
      const fixture = await startLifecycleFixture(stage, port);
      const first = runPowerShell(['-Action', 'Stop', '-ControlId', fixture.control!]);
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.match(first.stdout, /STOP_SIGNALLED/);
      const repeated = runPowerShell(['-Action', 'Stop', '-ControlId', fixture.control!]);
      assert.notEqual(repeated.status, 0);
      const exitCode = await waitForExit(fixture.child);
      assert.equal(exitCode, 0, `${fixture.stdout()}\n${fixture.stderr()}`);
      await waitUntil(() => !pidExists(fixture.ownedPid) && portIsFree(port));
      const late = runPowerShell(['-Action', 'Stop', '-ControlId', fixture.control!]);
      assert.notEqual(late.status, 0);
      assert.match(`${late.stdout}${late.stderr}`, /CONTROL_NOT_ACTIVE/);
    }

    for (const [index, stage] of ['startup', 'readiness', 'steady'].entries()) {
      const port = await findFixturePort(45400 + index * 50);
      const fixture = await startLifecycleFixture(stage, port);
      const killed = spawnSync(taskkillExe, ['/PID', String(fixture.child.pid), '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      });
      if (killed.error) throw killed.error;
      assert.equal(killed.status, 0, `${killed.stdout}\n${killed.stderr}`);
      await waitForExit(fixture.child);
      await waitUntil(() => !pidExists(fixture.ownedPid) && portIsFree(port));
      const late = runPowerShell(['-Action', 'Stop', '-ControlId', fixture.control!]);
      assert.notEqual(late.status, 0);
      assert.match(`${late.stdout}${late.stderr}`, /CONTROL_NOT_ACTIVE/);
    }

    for (const [index, stage] of ['exit-zero', 'exit-nonzero'].entries()) {
      const port = await findFixturePort(45600 + index * 50);
      const fixture = await startLifecycleFixture(stage, port);
      const exitCode = await waitForExit(fixture.child);
      assert.notEqual(exitCode, 0);
      assert.match(`${fixture.stdout()}${fixture.stderr()}`, /FIXTURE_CHILD_EXITED/);
      await waitUntil(() => !pidExists(fixture.ownedPid) && portIsFree(port));
      const late = runPowerShell(['-Action', 'Stop', '-ControlId', fixture.control!]);
      assert.notEqual(late.status, 0);
    }

    await runReadiness503Vector(0);

    for (const mode of [
      'wrong-agent',
      'wrong-worker-type',
      'invalid-json',
      'wrong-content-type',
      'timeout',
      'non-loopback',
    ]) {
      const result = runPowerShell([
        '-Action',
        'SelfTest',
        '-SelfTestMode',
        'AgentReadinessFixture',
        '-FixtureAgentMode',
        mode,
      ]);
      assert.notEqual(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout.includes('RUNNER_READY'), false, mode);
      assert.equal(await portIsFree(6567), true, mode);
    }

    assert.equal(runner.includes("Get-ProcessInput 'FixtureNativeFault'"), false);
    for (const action of ['Run', 'Stop', 'Preflight']) {
      const denied = runPowerShell(['-Action', action, '-FixtureNativeFault', 'CreateProcessW']);
      assert.notEqual(denied.status, 0);
      assert.match(
        `${denied.stdout}${denied.stderr}`,
        /FixtureNativeFault is valid only with -Action SelfTest/,
      );
      assert.equal(denied.stdout.includes('NATIVE_FAULT_CLEANUP'), false);
    }

    for (const [index, fault] of [
      'CreateProcessW',
      'AssignProcessToJobObject',
      'ResumeThread',
    ].entries()) {
      const sentinel = startForeignSentinel();
      const port = await findFixturePort(45800 + index * 50);
      try {
        const result = runPowerShell([
          '-Action',
          'SelfTest',
          '-SelfTestMode',
          'NativeFaultFixture',
          '-FixtureNativeFault',
          fault,
          '-FixturePort',
          String(port),
        ]);
        assert.notEqual(result.status, 0, `${fault}: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /NATIVE_FAULT_WITNESS positive_control=1 exact_nonce=1/);
        assert.match(result.stdout, new RegExp(`NATIVE_FAULT_WITNESS fault=${fault} observed=0`));
        assert.match(result.stdout, new RegExp(`NATIVE_FAULT_CLEANUP fault=${fault}`));
        assert.match(result.stdout, new RegExp(`NATIVE_FAULT_FIXTURE_CLEAN fault=${fault}`));
        const expectedError =
          fault === 'CreateProcessW'
            ? 'FAULT_INJECT_CREATEPROCESSW'
            : fault === 'AssignProcessToJobObject'
              ? 'FAULT_INJECT_ASSIGNPROCESSTOJOBOBJECT'
              : 'FAULT_INJECT_RESUMETHREAD';
        assert.ok(`${result.stdout}${result.stderr}`.includes(expectedError));
        const cleanup = new RegExp(
          `NATIVE_FAULT_CLEANUP fault=${fault} pid=(\\d+) created=(\\d) in_job=(\\d) resumed=(\\d)`,
        ).exec(result.stdout);
        assert.ok(cleanup);
        const faultPid = Number(cleanup![1]);
        assert.equal(Number(cleanup![4]), 0);
        if (fault === 'CreateProcessW') {
          assert.equal(faultPid, 0);
          assert.equal(Number(cleanup![2]), 0);
          assert.equal(Number(cleanup![3]), 0);
        } else {
          assert.ok(faultPid > 0);
          assert.equal(Number(cleanup![2]), 1);
          assert.equal(Number(cleanup![3]), fault === 'ResumeThread' ? 1 : 0);
          assert.equal(pidExists(faultPid), false);
        }
        assert.equal(await portIsFree(port), true, fault);
        const control = /RUNNER_CONTROL_READY control_id=([0-9a-f]{24})/.exec(result.stdout)?.[1];
        assert.ok(control);
        const late = runPowerShell(['-Action', 'Stop', '-ControlId', control!]);
        assert.notEqual(late.status, 0);
        assert.match(`${late.stdout}${late.stderr}`, /CONTROL_NOT_ACTIVE/);
        assert.equal(pidExists(sentinel.pid!), true, fault);
        console.log(
          `R5_1_NATIVE_FAULT fault=${fault} positive=1 exact_nonce=1 created=${cleanup![2]} in_job=${cleanup![3]} resumed=${cleanup![4]} observed=0 residue=0 foreign_alive=1`,
        );
      } finally {
        await stopForeignSentinel(sentinel);
      }
    }

    const validAgent = runPowerShell([
      '-Action',
      'SelfTest',
      '-SelfTestMode',
      'AgentReadinessFixture',
      '-FixtureAgentMode',
      'valid',
    ]);
    assert.equal(validAgent.status, 0, `${validAgent.stdout}\n${validAgent.stderr}`);
    assert.equal(validAgent.stderr, '');
    assert.match(validAgent.stdout, /RUNNER_READY services=1 agent_registered=1/);
    assert.equal(await portIsFree(6567), true);
  },
);

const windowsPowerShell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const taskkillExe = `${process.env.SystemRoot}\\System32\\taskkill.exe`;
const runnerPath = fileURLToPath(new URL('../demo-loopback.ps1', import.meta.url));

function runnerEnvironment() {
  const environment = { ...process.env };
  delete environment.PAIOS_GATEWAY_TEST_HARNESS;
  delete environment.G_A1_R5_1_503_STRESS;
  return environment;
}

function runPowerShell(arguments_: string[], timeout = 30_000) {
  const result = spawnSync(
    windowsPowerShell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runnerPath,
      ...arguments_,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      env: runnerEnvironment(),
    },
  );
  if (result.error) throw result.error;
  return result;
}

async function findFixturePort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('NO_FREE_FIXTURE_PORT');
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('RUNNER_LIFECYCLE_WAIT_TIMEOUT');
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startForeignSentinel() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    env: runnerEnvironment(),
  });
  assert.ok(child.pid);
  assert.equal(pidExists(child.pid!), true);
  return child;
}

async function stopForeignSentinel(child: any): Promise<void> {
  if (!pidExists(child.pid)) return;
  const killed = spawnSync(taskkillExe, ['/PID', String(child.pid), '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  if (killed.error) throw killed.error;
  assert.equal(killed.status, 0, `${killed.stdout}\n${killed.stderr}`);
  await waitUntil(() => !pidExists(child.pid));
}

async function waitForExit(child: any, timeoutMs = 15_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RUNNER_PARENT_EXIT_TIMEOUT')), timeoutMs);
    child.once('exit', (code: number | null) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function startLifecycleFixture(stage: string, port: number) {
  const child = spawn(
    windowsPowerShell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runnerPath,
      '-Action',
      'SelfTest',
      '-SelfTestMode',
      'LifecycleFixture',
      '-FixtureStage',
      stage,
      '-FixturePort',
      String(port),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: runnerEnvironment(),
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  await waitUntil(() => stdout.includes(`FIXTURE_STAGE stage=${stage}`) || child.exitCode !== null);
  assert.equal(child.exitCode, null, `fixture exited early: ${stdout}\n${stderr}`);
  const control = /RUNNER_CONTROL_READY control_id=([0-9a-f]{24})/.exec(stdout)?.[1];
  const ownedPid = Number(/owned_pid=(\d+)/.exec(stdout)?.[1]);
  assert.ok(control);
  assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
  return {
    child,
    control,
    ownedPid,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test('inbound validation and outbound replay are statically bound to the same RTC helper', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/device-session-adapter.ts', import.meta.url)),
    'utf8',
  );
  assert.equal(
    source.match(/const binding = rtcEventTransportBinding\(event\.event_type\);/g)?.length,
    2,
  );
  const publishDataIndex = source.indexOf(
    'publishData(new TextEncoder().encode(JSON.stringify(event))',
  );
  assert.ok(publishDataIndex >= 0);
  const publishDataBinding = source.slice(
    Math.max(0, publishDataIndex - 800),
    publishDataIndex + 300,
  );
  assert.ok(publishDataBinding.includes('rtcEventTransportBinding(event.event_type)'));
  assert.ok(source.includes('runtime.gatewayOutboundOwnership.owns(event)'));
  assert.ok(source.includes('await this.#publishLocallyOwnedReplay(runtime);'));
  assert.ok(
    source.includes('void this.#publishLocallyOwnedReplay(runtime).catch(reportPrimitiveError);'),
  );
  assert.ok(source.includes('identity: gatewayBinding.identity'));
  assert.ok(source.includes('attributes: gatewayBinding.attributes'));
  assert.ok(source.includes('origin: gatewayBinding.origin'));
  assert.ok(source.includes('participant as unknown as RemoteParticipant'));
  assert.equal(source.includes('const GATEWAY_IDENTITY ='), false);
  assert.ok(publishDataBinding.includes('reliable: binding.reliable'));
  assert.ok(publishDataBinding.includes('topic: binding.topic'));
  assert.equal(publishDataBinding.includes('reliable: true'), false);
  assert.ok(source.includes('runtime.modelCache.clone()'));
  assert.ok(source.includes('modelCache.recordResult(requestEventId, event.event_id)'));
  assert.ok(source.includes('runtime.modelCache.replaceWith(admission.modelCache)'));
  assert.ok(source.includes('runtime.modelCache.clear()'));
  assert.ok(source.includes("throw new Error('MODEL_CACHE_REQUEST_NOT_FOUND')"));
  assert.ok(source.includes('runtime.consumer.acceptedEvents().length !== 0'));
});

const B1_PROXY_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
  'base64url',
);
const B1_RUN_ID = 'g5_iphone_run_001';
const T15_FIREWALL_RUN_ID = '12345678-1234-4234-9234-123456789abc';
const T15_ACTIVATION_ATTEMPT_ID = '1234567890abcdef1234567890abcdef';
const T15_SESSION_ID = 'phase0_session_1234567890abcdef1234';
const T15_DEVICE_ID = 'web_device_1234567890abcdef1234';
const T15_CLIENT_ID = 'web_client_1234567890abcdef1234';
const T15_DEVICE_LAN_RUN_ID = 'p0_12345678123442349234123456789abc';
const T15_CONTROL_ROOT =
  `D:\\AI\\personal ai os\\.runtime\\phase0-iphone-one-shot\\runs\\${T15_FIREWALL_RUN_ID}\\${T15_ACTIVATION_ATTEMPT_ID}`;
const T15_NONCE = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33)).toString(
  'base64url',
);
const T15_BINDING: SupervisedDeviceLanBinding = {
  firewallRunId: T15_FIREWALL_RUN_ID,
  activationAttemptId: T15_ACTIVATION_ATTEMPT_ID,
  sessionId: T15_SESSION_ID,
  roomName: T15_SESSION_ID,
  deviceId: T15_DEVICE_ID,
  participantIdentity: T15_DEVICE_ID,
  clientInstanceId: T15_CLIENT_ID,
  controlRoot: T15_CONTROL_ROOT,
};
const B1_FORBIDDEN_VIDEO_GRANTS = [
  'roomCreate',
  'roomList',
  'roomRecord',
  'roomAdmin',
  'ingressAdmin',
  'canUpdateOwnMetadata',
  'hidden',
  'recorder',
  'agent',
  'canSubscribeMetrics',
  'destinationRoom',
] as const;
const B1_FORBIDDEN_ROOT_GRANTS = [
  'sip',
  'inference',
  'kind',
  'metadata',
  'sha256',
  'roomPreset',
  'roomConfig',
] as const;
const B1_SECURITY: DeviceLanSecurityConfig = {
  publicOrigin: 'https://192.168.50.14',
  publicHost: '192.168.50.14',
  hostIpv4: '192.168.50.14',
  hostIpv4Cidr: '192.168.50.14/24',
  subnetPrefixLength: 24,
  iphoneIpv4: '192.168.50.23',
  proxyAttestationSecret: B1_PROXY_SECRET,
};

function b1GatewayConfig(): GatewayConfig {
  return {
    livekitUrl: 'ws://127.0.0.1:7880',
    apiKey: 'b1-test-api-key-001',
    apiSecret: 'b1-test-api-secret-with-sufficient-length-0123456789',
    sessionTtlSeconds: 120,
    tokenTtlSeconds: 120,
    deviceLan: {
      clientLivekitUrl: 'wss://192.168.50.14',
      runId: B1_RUN_ID,
      roomAutoCreateDisabled: true,
    },
  };
}

function assertNoExcessLiveKitGrants(claims: object): void {
  const root = claims as Record<string, unknown>;
  const video = root.video;
  assert.ok(video && typeof video === 'object' && !Array.isArray(video));
  for (const capability of B1_FORBIDDEN_VIDEO_GRANTS) {
    assert.equal(Object.hasOwn(video, capability), false, capability);
  }
  for (const capability of B1_FORBIDDEN_ROOT_GRANTS) {
    assert.equal(Object.hasOwn(root, capability), false, capability);
  }
}

function b1RuntimeConfig(): GatewayRuntimeConfig {
  return {
    gateway: b1GatewayConfig(),
    deviceLanSecurity: B1_SECURITY,
    precontactAdmission: 'OPEN_NORMAL',
  };
}

function bPrimeRuntimeConfig(
  precontactAdmission: 'CLOSED_PRECONTACT' | 'OPEN_NORMAL',
): GatewayRuntimeConfig {
  return {
    gateway: {
      ...b1GatewayConfig(),
      deviceLan: {
        clientLivekitUrl: B1_SECURITY.publicOrigin.replace('https:', 'wss:'),
        runId: T15_DEVICE_LAN_RUN_ID,
        roomAutoCreateDisabled: true,
        supervised: T15_BINDING,
      },
    },
    deviceLanSecurity: B1_SECURITY,
    supervisorControl: { nonce: T15_NONCE, binding: T15_BINDING },
    precontactAdmission,
  };
}

function bPrimeEnvironment(
  precontactAdmission: 'CLOSED_PRECONTACT' | 'OPEN_NORMAL' | 'HOSTILE',
): NodeJS.ProcessEnv {
  return {
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'bprime-api-key-001',
    LIVEKIT_API_SECRET: 'bprime-api-secret-with-sufficient-length-0123456789',
    LIVEKIT_ROOM_AUTO_CREATE: 'false',
    STT_ENDPOINT_PORT: '8000',
    STT_ENDPOINT_URL: 'http://127.0.0.1:8000/v1/audio/transcriptions',
    STT_MODEL: 'deepdml/faster-whisper-large-v3-turbo-ct2',
    STT_DEADLINE_MS: '120000',
    OLLAMA_MODEL: 'qwen3:8b',
    DEVICE_LAN_PUBLIC_ORIGIN: B1_SECURITY.publicOrigin,
    DEVICE_LAN_PUBLIC_HOST: B1_SECURITY.publicHost,
    DEVICE_LAN_HOST_IPV4_CIDR: B1_SECURITY.hostIpv4Cidr,
    DEVICE_LAN_IPHONE_IPV4: B1_SECURITY.iphoneIpv4,
    DEVICE_LAN_PROXY_ATTESTATION_SECRET: B1_PROXY_SECRET,
    DEVICE_LAN_RUN_ID: T15_DEVICE_LAN_RUN_ID,
    PAIOS_T15_FIREWALL_RUN_ID: T15_FIREWALL_RUN_ID,
    PAIOS_T15_ACTIVATION_ATTEMPT_ID: T15_ACTIVATION_ATTEMPT_ID,
    PAIOS_T15_SESSION_ID: T15_SESSION_ID,
    PAIOS_T15_ROOM_NAME: T15_SESSION_ID,
    PAIOS_T15_DEVICE_ID: T15_DEVICE_ID,
    PAIOS_T15_PARTICIPANT_IDENTITY: T15_DEVICE_ID,
    PAIOS_T15_CLIENT_INSTANCE_ID: T15_CLIENT_ID,
    PAIOS_T15_CONTROL_ROOT: T15_CONTROL_ROOT,
    PAIOS_T15_GATEWAY_CONTROL_NONCE: T15_NONCE,
    PAIOS_T15_PRECONTACT_ADMISSION: precontactAdmission,
    PAIOS_T15_GATEWAY_PIPE_CONFIG_PATH: 'Z:\\must-not-be-read\\gateway-pipe.json',
  };
}

function b1Headers(includeContentType = true): string[] {
  return [
    'Host',
    B1_SECURITY.publicHost,
    'Origin',
    B1_SECURITY.publicOrigin,
    'X-Forwarded-For',
    B1_SECURITY.iphoneIpv4,
    'X-Forwarded-Host',
    B1_SECURITY.publicHost,
    'X-Forwarded-Proto',
    'https',
    'X-PAIOS-Proxy-Attestation',
    B1_SECURITY.proxyAttestationSecret,
    ...(includeContentType ? ['Content-Type', 'application/json'] : []),
  ];
}

function b1Request(overrides: Partial<DeviceLanRequestMetadata> = {}): DeviceLanRequestMetadata {
  return {
    method: 'POST',
    url: '/connection-details',
    remoteAddress: '127.0.0.1',
    rawHeaders: b1Headers(),
    ...overrides,
  };
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test('B1 strict JSON accepts controls through depth 32 and rejects 28 bounded grammar/key hostiles', () => {
  const depth32 = `${'['.repeat(32)}0${']'.repeat(32)}`;
  const validControls = [
    '{}',
    ' [ null, true, false, -0, 12.5e1 ] ',
    '{"value":"escaped\\nvalue and \\uD83D\\uDE00","nested":{"ok":true}}',
    depth32,
  ];
  for (const control of validControls) {
    assert.doesNotThrow(() => parseStrictJsonBytes(utf8(control), 16_384), control);
  }

  const invalidText = [
    '{"a":1,"a":2}',
    '{"nested":{"a":1,"a":2}}',
    String.raw`{"iss":1,"\u0069ss":2}`,
    String.raw`{"\u0061":1}`,
    '{"__proto__":{}}',
    '{"constructor":{}}',
    '{"nested":{"prototype":{}}}',
    '{} trailing',
    `${'['.repeat(33)}0${']'.repeat(33)}`,
    '01',
    '+1',
    '1.',
    '1e',
    '1e400',
    'NaN',
    'tru',
    '{"a":1,}',
    '[1,]',
    "{'a':1}",
    '{"a":"line\nbreak"}',
    String.raw`{"a":"\x20"}`,
    String.raw`{"a":"\uD800"}`,
    String.raw`{"a":"\uDC00"}`,
    String.raw`{"a":"\u12X4"}`,
  ];
  const invalidBytes = [
    new Uint8Array(),
    new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    new Uint8Array([0xc3, 0x28]),
  ];
  for (const hostile of invalidText.map(utf8).concat(invalidBytes)) {
    assert.throws(
      () => parseStrictJsonBytes(hostile, 16_384),
      /^Error: STRICT_JSON_REJECTED$/,
    );
  }
  assert.throws(
    () => parseStrictJsonBytes(utf8('{}'), 1),
    /^Error: STRICT_JSON_REJECTED$/,
  );
  assert.equal(invalidText.length + invalidBytes.length + 1, 28);
});

function replaceRawHeader(
  rawHeaders: readonly string[],
  name: string,
  values: readonly string[],
): string[] {
  const replaced: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() !== name) {
      replaced.push(rawHeaders[index]!, rawHeaders[index + 1]!);
    }
  }
  for (const value of values) replaced.push(name, value);
  return replaced;
}

function assertB1Denied(request: DeviceLanRequestMetadata): void {
  assert.throws(
    () => authorizeDeviceLanRequest(request, B1_SECURITY),
    (error: unknown) => error instanceof Error && error.message === 'DEVICE_LAN_REQUEST_DENIED',
  );
}

interface B1HttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function b1HttpRequest(
  url: string,
  options: {
    readonly method: string;
    readonly headers: OutgoingHttpHeaders;
    readonly body?: string;
  },
): Promise<B1HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      url,
      {
        method: options.method,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.once('error', reject);
    if (options.body !== undefined) request.end(options.body);
    else request.end();
  });
}

test('B-prime loadConfig accepts both fresh modes without any broker-pipe input', () => {
  const hostInterfaces = {
    exact: [{
      address: B1_SECURITY.hostIpv4,
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:11:22:33:44:55',
      internal: false,
      cidr: B1_SECURITY.hostIpv4Cidr,
    }],
  };
  for (const mode of ['CLOSED_PRECONTACT', 'OPEN_NORMAL'] as const) {
    const config = loadConfig(bPrimeEnvironment(mode), hostInterfaces);
    assert.equal(config.precontactAdmission, mode);
    assert.deepEqual(config.supervisorControl?.binding, T15_BINDING);
    assert.equal(config.gatewayNodePipe, undefined);
  }
  assert.throws(
    () => loadConfig(bPrimeEnvironment('HOSTILE'), hostInterfaces),
    /^Error: INVALID_PROCESS_ENV:PAIOS_T15_PRECONTACT_ADMISSION$/,
  );
});

test('B1 request authorization is exact, single-occurrence and generic for every hostile header', () => {
  assert.deepEqual(authorizeDeviceLanRequest(b1Request(), B1_SECURITY), {
    kind: 'connection-details',
  });
  assert.deepEqual(
    authorizeDeviceLanRequest(
      b1Request({ url: `/sessions/${T15_SESSION_ID}/stop`, rawHeaders: b1Headers(false) }),
      B1_SECURITY,
    ),
    { kind: 'stop-session', roomName: T15_SESSION_ID },
  );

  const exactValues = new Map([
    ['host', B1_SECURITY.publicHost],
    ['origin', B1_SECURITY.publicOrigin],
    ['x-forwarded-for', B1_SECURITY.iphoneIpv4],
    ['x-forwarded-host', B1_SECURITY.publicHost],
    ['x-forwarded-proto', 'https'],
    ['x-paios-proxy-attestation', B1_SECURITY.proxyAttestationSecret],
  ]);
  for (const [name, exact] of exactValues) {
    assertB1Denied(
      b1Request({
        rawHeaders: replaceRawHeader(b1Headers(), name, []),
      }),
    );
    assertB1Denied(
      b1Request({
        rawHeaders: replaceRawHeader(b1Headers(), name, [exact, exact]),
      }),
    );
    assertB1Denied(
      b1Request({
        rawHeaders: replaceRawHeader(b1Headers(), name, [`${exact},spoof`]),
      }),
    );
  }

  for (const [name, value] of [
    ['host', 'wrong.paios.test'],
    ['origin', 'https://wrong.paios.test'],
    ['x-forwarded-for', '192.168.50.24'],
    ['x-forwarded-host', 'wrong.paios.test'],
    ['x-forwarded-proto', 'http'],
    ['x-paios-proxy-attestation', 'wrong'],
  ] as const) {
    assertB1Denied(
      b1Request({
        rawHeaders: replaceRawHeader(b1Headers(), name, [value]),
      }),
    );
  }

  for (const forbidden of ['forwarded', 'x-real-ip', 'x-sandbox-id', 'x-original-url']) {
    assertB1Denied(
      b1Request({
        rawHeaders: [...b1Headers(), forbidden, 'spoof'],
      }),
    );
  }
  for (const request of [
    b1Request({ method: 'GET' }),
    b1Request({ url: '/connection-details/' }),
    b1Request({ url: '/connection-details?reload=1' }),
    b1Request({ url: '/sessions/phase0_session_b1/stop?x=1' }),
    b1Request({ url: '/sessions/../stop' }),
    b1Request({ remoteAddress: '::ffff:127.0.0.1' }),
  ]) {
    assertB1Denied(request);
  }

  assert.equal(constantTimeProxyAttestationEqual(B1_PROXY_SECRET, B1_PROXY_SECRET), true);
  assert.equal(
    constantTimeProxyAttestationEqual(
      `${B1_PROXY_SECRET[0] === 'A' ? 'B' : 'A'}${B1_PROXY_SECRET.slice(1)}`,
      B1_PROXY_SECRET,
    ),
    false,
  );
  assert.equal(constantTimeProxyAttestationEqual('short', B1_PROXY_SECRET), false);
});

test('no-device witness is immutable CLOSED, monotonic and synchronously blocks participant signing', () => {
  const witness = new NoDevicePrecontactWitness();
  assert.deepEqual(witness.snapshot(), {
    admission: 'CLOSED_PRECONTACT',
    never_opened: true,
    stop_fenced: false,
    route_attempt_count: 0,
    adapter_call_count: 0,
    adapter_call_in_flight: 0,
    signer_call_count: 0,
    signer_call_in_flight: 0,
    materialized_success_count: 0,
    response_count: 0,
    gateway_internal_prearm_success_count: 0,
    observation_generation: 0,
  });
  let toJwtCalls = 0;
  assert.throws(
    () => witness.signParticipantToken({
      async toJwt() {
        toJwtCalls += 1;
        return 'must-not-materialize';
      },
    }),
    /^Error: DEVICE_LAN_PRECONTACT_CLOSED$/,
  );
  assert.equal(toJwtCalls, 0);
  witness.recordGatewayInternalPrearmSuccess();
  const afterInternalPrearm = witness.snapshot();
  assert.equal(afterInternalPrearm.gateway_internal_prearm_success_count, 1);
  assert.equal(afterInternalPrearm.signer_call_count, 0);
  assert.equal(afterInternalPrearm.materialized_success_count, 0);
  assert.throws(
    () => witness.recordGatewayInternalPrearmSuccess(),
    /^Error: PRECONTACT_INTERNAL_PREARM_DUPLICATE$/,
  );
  witness.fenceForStop();
  const fencedGeneration = witness.snapshot().observation_generation;
  witness.fenceForStop();
  assert.equal(witness.snapshot().observation_generation, fencedGeneration);
  assert.equal(witness.snapshot().stop_fenced, true);
  for (const hostile of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => incrementPrecontactSafeInteger(hostile),
      /^Error: PRECONTACT_WITNESS_OVERFLOW$/,
    );
  }
  assert.equal(incrementPrecontactSafeInteger(0), 1);

  const attempted = new NoDevicePrecontactWitness();
  attempted.recordRouteAttempt();
  assert.throws(() => attempted.denyAtRouteBoundary(), /^Error: DEVICE_LAN_PRECONTACT_CLOSED$/);
  assert.equal(attempted.snapshot().route_attempt_count, 1);
  assert.equal(attempted.snapshot().adapter_call_count, 0);
  assert.equal(attempted.snapshot().signer_call_count, 0);
  assert.equal(attempted.snapshot().materialized_success_count, 0);
  assert.equal(attempted.snapshot().response_count, 0);
  assert.throws(
    () => attempted.assertZeroDeviceParticipantActivity(),
    /^Error: PRECONTACT_DEVICE_PARTICIPANT_ACTIVITY$/,
  );
});

test('no-device HTTP counts every candidate before authorization and never calls adapter or signer', async () => {
  let adapterCalls = 0;
  const adapter = {
    async createConnectionDetails() {
      adapterCalls += 1;
      throw new Error('ADAPTER_MUST_NOT_BE_REACHED');
    },
  } as unknown as DeviceSessionAdapter;
  const witness = new NoDevicePrecontactWitness();
  const server = createGatewayServer(
    bPrimeRuntimeConfig('CLOSED_PRECONTACT'),
    adapter,
    witness,
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const exactHeaders = {
    Host: B1_SECURITY.publicHost,
    Origin: B1_SECURITY.publicOrigin,
    'Content-Type': 'application/json',
    'X-Forwarded-For': B1_SECURITY.iphoneIpv4,
    'X-Forwarded-Host': B1_SECURITY.publicHost,
    'X-Forwarded-Proto': 'https',
    'X-PAIOS-Proxy-Attestation': B1_SECURITY.proxyAttestationSecret,
  };
  try {
    const candidates = [
      [`${baseUrl}/connection-details`, { method: 'POST', headers: exactHeaders, body: '{}' }],
      [`${baseUrl}/connection-details?query=hostile`, { method: 'POST', headers: {}, body: '{}' }],
      [`${baseUrl}/connection-details/`, { method: 'GET', headers: {} }],
      [`${baseUrl}/connection-details%2fescape`, { method: 'DELETE', headers: {}, body: 'x' }],
    ] as const;
    for (const [url, options] of candidates) {
      const response = await b1HttpRequest(url, options);
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.body), { error: 'DEVICE_LAN_PRECONTACT_CLOSED' });
    }
    const snapshot = witness.snapshot();
    assert.equal(snapshot.route_attempt_count, candidates.length);
    assert.equal(snapshot.adapter_call_count, 0);
    assert.equal(snapshot.adapter_call_in_flight, 0);
    assert.equal(snapshot.signer_call_count, 0);
    assert.equal(snapshot.signer_call_in_flight, 0);
    assert.equal(snapshot.materialized_success_count, 0);
    assert.equal(snapshot.response_count, 0);
    assert.equal(snapshot.gateway_internal_prearm_success_count, 0);
    assert.equal(adapterCalls, 0);
    assert.throws(
      () => witness.fenceForStop(),
      /^Error: PRECONTACT_DEVICE_PARTICIPANT_ACTIVITY$/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('B-prime OPEN_NORMAL passes the exact supervised route to adapter with no witness', async () => {
  let adapterCalls = 0;
  const adapter = {
    async createConnectionDetails() {
      adapterCalls += 1;
      return {
        serverUrl: 'wss://192.168.50.14',
        roomName: T15_SESSION_ID,
        participantName: 'user',
        participantToken: 'unit-test-token',
      };
    },
  } as unknown as DeviceSessionAdapter;
  const server = createGatewayServer(bPrimeRuntimeConfig('OPEN_NORMAL'), adapter);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await b1HttpRequest(`http://127.0.0.1:${address.port}/connection-details`, {
      method: 'POST',
      headers: {
        Host: B1_SECURITY.publicHost,
        Origin: B1_SECURITY.publicOrigin,
        'Content-Type': 'application/json',
        'X-Forwarded-For': B1_SECURITY.iphoneIpv4,
        'X-Forwarded-Host': B1_SECURITY.publicHost,
        'X-Forwarded-Proto': 'https',
        'X-PAIOS-Proxy-Attestation': B1_SECURITY.proxyAttestationSecret,
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(adapterCalls, 1);
    assert.deepEqual(JSON.parse(response.body), {
      serverUrl: 'wss://192.168.50.14',
      roomName: T15_SESSION_ID,
      participantName: 'user',
      participantToken: 'unit-test-token',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('SSE subscribe failure ends the committed stream without a second response write', async () => {
  const adapter = {
    sessionExists(sessionId: string) {
      return sessionId === T15_SESSION_ID;
    },
    subscribe() {
      throw new Error('INJECTED_SUBSCRIBE_FAILURE');
    },
    activeSessionIds() {
      return [T15_SESSION_ID];
    },
  } as unknown as DeviceSessionAdapter;
  const server = createGatewayServer(b1RuntimeConfig(), adapter);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const stream = await b1HttpRequest(`${baseUrl}/events?session_id=${T15_SESSION_ID}`, {
      method: 'GET',
      headers: { Host: '127.0.0.1:8787' },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(stream.body, ': connected\n\n');

    const health = await b1HttpRequest(`${baseUrl}/healthz`, {
      method: 'GET',
      headers: { Host: '127.0.0.1:8787' },
    });
    assert.equal(health.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('B1 exact HTTP Start has one 200 winner and public HTTP Stop is terminal', async () => {
  let activeRoom: string | undefined;
  let winningRoom: string | undefined;
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  const server = createGatewayServer(b1RuntimeConfig(), adapter);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    Host: B1_SECURITY.publicHost,
    Origin: B1_SECURITY.publicOrigin,
    'Content-Type': 'application/json',
    'X-Forwarded-For': B1_SECURITY.iphoneIpv4,
    'X-Forwarded-Host': B1_SECURITY.publicHost,
    'X-Forwarded-Proto': 'https',
    'X-PAIOS-Proxy-Attestation': B1_SECURITY.proxyAttestationSecret,
  };
  const { ['Content-Type']: _contentType, ...stopHeaders } = headers;
  try {
    assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'ARMED');
    for (const [url, options] of [
      [`${baseUrl}/connection-details/`, { method: 'POST', headers, body: '{}' }],
      [`${baseUrl}/connection-details?retry=1`, { method: 'POST', headers, body: '{}' }],
      [`${baseUrl}/connection-details`, { method: 'GET', headers }],
      [`${baseUrl}/connection-details`, { method: 'POST', headers, body: '{"extra":true}' }],
    ] as const) {
      const denied = await b1HttpRequest(url, options);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers['cache-control'], 'no-store');
      assert.deepEqual(JSON.parse(denied.body), {
        error: 'DEVICE_LAN_REQUEST_DENIED',
      });
      assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'ARMED');
    }
    const publicStopBeforeStart = await b1HttpRequest(
      `${baseUrl}/sessions/phase0_session_unknown/stop`,
      { method: 'POST', headers: stopHeaders },
    );
    assert.equal(publicStopBeforeStart.status, 404);
    assert.deepEqual(JSON.parse(publicStopBeforeStart.body), { error: 'ROUTE_NOT_FOUND' });
    assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'ARMED');

    const starts = await Promise.all([
      b1HttpRequest(`${baseUrl}/connection-details`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
      b1HttpRequest(`${baseUrl}/connection-details`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
    ]);
    assert.deepEqual(starts.map((response) => response.status).sort(), [200, 403]);
    const winner = starts.find((response) => response.status === 200);
    const loser = starts.find((response) => response.status === 403);
    assert.ok(winner);
    assert.ok(loser);
    assert.equal(winner.headers['cache-control'], 'no-store');
    assert.equal(loser.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(loser.body), {
      error: 'DEVICE_LAN_REQUEST_DENIED',
    });

    const details = JSON.parse(winner.body) as {
      serverUrl: string;
      roomName: string;
      participantName: string;
      participantToken: string;
    };
    assert.equal(details.serverUrl, 'wss://192.168.50.14');
    winningRoom = details.roomName;
    assert.equal(details.participantName, 'user');
    assert.match(details.roomName, /^phase0_session_[a-z0-9]+$/);
    const claims = await new TokenVerifier(
      b1GatewayConfig().apiKey,
      b1GatewayConfig().apiSecret,
    ).verify(details.participantToken, 0);
    assert.equal(claims.sub, claims.attributes?.device_id);
    assert.equal(claims.name, details.participantName);
    assert.equal(claims.attributes?.device_class, 'web_mobile');
    assert.equal(claims.attributes?.run_id, B1_RUN_ID);
    assert.ok(typeof claims.attributes?.client_instance_id === 'string');
    assert.deepEqual(claims.video, {
      room: details.roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canPublishData: false,
      canSubscribe: true,
    });
    assertNoExcessLiveKitGrants(claims);
    assert.ok(Number.isSafeInteger(claims.iat));
    assert.ok(Number.isSafeInteger(claims.exp));
    assert.ok(claims.exp! > claims.iat!);
    assert.ok(claims.exp! - claims.iat! <= 120);
    assert.ok(claims.exp! <= Math.floor(adapter.deviceLanIssuanceSnapshot()!.deadlineAt! / 1_000));
    const [encodedHeader, encodedClaims] = details.participantToken.split('.');
    assert.deepEqual(
      JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString('utf8')),
      { alg: 'HS256' },
    );
    assert.deepEqual(
      Object.keys(
        JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString('utf8')) as object,
      ).sort(),
      ['attributes', 'exp', 'iat', 'iss', 'name', 'nbf', 'sub', 'video'],
    );
    for (const forbidden of ['inference', 'roomConfig', 'roomPreset', 'sip']) {
      assert.equal(forbidden in claims, false);
    }

    const reload = await b1HttpRequest(`${baseUrl}/connection-details`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(reload.status, 403);
    const wrongStop = await b1HttpRequest(`${baseUrl}/sessions/phase0_session_wrong/stop`, {
      method: 'POST',
      headers: stopHeaders,
    });
    assert.equal(wrongStop.status, 404);
    assert.deepEqual(JSON.parse(wrongStop.body), { error: 'ROUTE_NOT_FOUND' });
    assert.equal(adapter.sessionExists(details.roomName), true);

    const stop = await b1HttpRequest(
      `${baseUrl}/sessions/${encodeURIComponent(details.roomName)}/stop`,
      { method: 'POST', headers: stopHeaders },
    );
    assert.equal(stop.status, 200);
    assert.equal(stop.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(stop.body), { status: 'cleanup_complete' });
    assert.equal(adapter.sessionExists(details.roomName), false);
    assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED');

    const duplicate = await b1HttpRequest(
      `${baseUrl}/sessions/${encodeURIComponent(details.roomName)}/stop`,
      { method: 'POST', headers: stopHeaders },
    );
    assert.equal(duplicate.status, 410);
    assert.deepEqual(JSON.parse(duplicate.body), { error: 'SESSION_CLEANED' });
  } finally {
    if (winningRoom && adapter.sessionExists(winningRoom)) {
      await adapter.stopSession(winningRoom, 'error');
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('B1 valid-HMAC JWT duplicate keys fail closed at header, root and nested maps', async () => {
  function signRaw(headerJson: string, payloadJson: string): string {
    const header = Buffer.from(headerJson, 'utf8').toString('base64url');
    const payload = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const input = `${header}.${payload}`;
    const signature = createHmac('sha256', b1GatewayConfig().apiSecret)
      .update(input, 'ascii')
      .digest('base64url');
    return `${input}.${signature}`;
  }

  const mutations: Array<
    (headerJson: string, payloadJson: string) => readonly [string, string]
  > = [
    (_header, payload) => ['{"alg":"HS256","alg":"HS256"}', payload],
    (_header, payload) => [String.raw`{"alg":"HS256","\u0061lg":"HS256"}`, payload],
    (header, payload) => [
      header,
      `{"iss":${JSON.stringify(b1GatewayConfig().apiKey)},${payload.slice(1)}`,
    ],
    (header, payload) => [
      header,
      `${String.raw`{"\u0069ss":`}${JSON.stringify(b1GatewayConfig().apiKey)},${payload.slice(1)}`,
    ],
    (header, payload) => [
      header,
      payload.replace(
        '"attributes":{',
        '"attributes":{"device_id":"duplicate-device",',
      ),
    ],
    (header, payload) => [
      header,
      payload.replace(
        '"attributes":{',
        String.raw`"attributes":{"\u0064evice_id":"duplicate-device",`,
      ),
    ],
    (header, payload) => [
      header,
      payload.replace('"video":{', '"video":{"room":"duplicate-room",'),
    ],
  ];

  for (const mutate of mutations) {
    let activeRoom: string | undefined;
    const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
      enableGatewayJoin: false,
      signParticipantToken: async (token) => {
        const valid = await token.toJwt();
        const [encodedHeader, encodedPayload] = valid.split('.');
        const headerJson = Buffer.from(encodedHeader!, 'base64url').toString('utf8');
        const payloadJson = Buffer.from(encodedPayload!, 'base64url').toString('utf8');
        const [mutatedHeader, mutatedPayload] = mutate(headerJson, payloadJson);
        return signRaw(mutatedHeader, mutatedPayload);
      },
      roomService: {
        async createRoom(options: { name?: string }) {
          activeRoom = options.name;
          return {};
        },
        async listParticipants() {
          return [];
        },
        async deleteRoom(room: string) {
          if (activeRoom === room) activeRoom = undefined;
        },
        async listRooms() {
          return [];
        },
      },
    });
    await assert.rejects(
      adapter.createConnectionDetails({}),
      /LIVEKIT_TOKEN_CLOSED_BINDING_FAILED/,
    );
    assert.equal(activeRoom, undefined);
    assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'FAILED_CLOSED');
  }
  assert.equal(mutations.length, 7);
});

test('B1 issuance failure stays FAILED_CLOSED and invalid body never consumes ARMED', async () => {
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    roomService: {
      async createRoom() {
        throw new Error('synthetic issuance failure');
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom() {},
      async listRooms() {
        return [];
      },
    },
  });
  await assert.rejects(
    adapter.createConnectionDetails({ unexpected: true }),
    /CONNECTION_REQUEST_CLOSED_MAP/,
  );
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'ARMED');
  await assert.rejects(adapter.createConnectionDetails({}), /synthetic issuance failure/);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'FAILED_CLOSED');
  await assert.rejects(adapter.createConnectionDetails({}), /^Error: DEVICE_LAN_REQUEST_DENIED$/);
});

test('B1 Stop revokes before asynchronous cleanup; parallel Stop and reissue cannot resurrect', async () => {
  let activeRoom: string | undefined;
  let deleteStarted = false;
  let releaseDelete: (() => void) | undefined;
  const deleteBarrier = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        deleteStarted = true;
        await deleteBarrier;
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  const details = await adapter.createConnectionDetails({});
  const firstStop = adapter.stopSession(details.roomName);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deleteStarted, true);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKING');
  const parallelStop = adapter.stopSession(details.roomName);
  assert.equal(parallelStop, firstStop);
  await assert.rejects(adapter.createConnectionDetails({}), /^Error: DEVICE_LAN_REQUEST_DENIED$/);
  releaseDelete?.();
  await firstStop;
  assert.equal(adapter.sessionExists(details.roomName), false);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED');
});

test('B1 Stop racing ISSUING cannot return a token and linearizes at verified room absence', async () => {
  let activeRoom: string | undefined;
  let releaseCreate: (() => void) | undefined;
  const createBarrier = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    scheduleCleanupRetry: () => ({ unref() {} }),
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        await createBarrier;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  const issuance = adapter.createConnectionDetails({});
  const roomName = adapter.deviceLanIssuanceSnapshot()?.roomName;
  assert.ok(roomName);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'ISSUING');
  const stop = adapter.stopSession(roomName);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKING');
  releaseCreate?.();
  await assert.rejects(stop, /SESSION_NOT_STARTED/);
  await assert.rejects(issuance, /DEVICE_LAN_REQUEST_DENIED/);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED');
  assert.equal(adapter.sessionExists(roomName), false);
  await assert.rejects(adapter.createConnectionDetails({}), /^Error: DEVICE_LAN_REQUEST_DENIED$/);
});

test('B1 120-second expiry enters the same bounded cleanup path without reopening', async () => {
  let activeRoom: string | undefined;
  let expiryCallback: (() => void) | undefined;
  let expiryDelay: number | undefined;
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    scheduleSessionExpiry: (callback, delayMs) => {
      expiryCallback = callback;
      expiryDelay = delayMs;
      return { unref() {} };
    },
    cancelSessionExpiry: () => {},
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  const details = await adapter.createConnectionDetails({});
  assert.ok(expiryDelay !== undefined && expiryDelay > 0 && expiryDelay <= 120_000);
  assert.ok(expiryCallback);
  expiryCallback();
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKING');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(adapter.sessionExists(details.roomName), false);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED');
  await assert.rejects(adapter.createConnectionDetails({}), /^Error: DEVICE_LAN_REQUEST_DENIED$/);
});

test('B1 adapter startup rejects an unproven LiveKit room auto-create setting', () => {
  const invalid = {
    ...b1GatewayConfig(),
    deviceLan: {
      ...b1GatewayConfig().deviceLan!,
      roomAutoCreateDisabled: false,
    },
  } as unknown as GatewayConfig;
  assert.throws(
    () => new DeviceSessionAdapter(invalid, { enableGatewayJoin: false }),
    /DEVICE_LAN_CONFIG_INVALID/,
  );
});

test('B1 deadline is scheduled before createRoom and no token is minted after delayed creation', async () => {
  let now = Date.now();
  let expiryScheduled = false;
  let signerCalled = false;
  let activeRoom: string | undefined;
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    now: () => now,
    scheduleSessionExpiry: () => {
      expiryScheduled = true;
      return { unref() {} };
    },
    cancelSessionExpiry: () => {},
    signParticipantToken: async (token) => {
      signerCalled = true;
      return token.toJwt();
    },
    roomService: {
      async createRoom(options: { name?: string }) {
        assert.equal(expiryScheduled, true);
        activeRoom = options.name;
        now += 120_000;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  await assert.rejects(
    adapter.createConnectionDetails({}),
    /LIVEKIT_TOKEN_DEADLINE_BINDING_FAILED/,
  );
  assert.equal(signerCalled, false);
  assert.equal(activeRoom, undefined);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'FAILED_CLOSED');
});

test('B1 signing that crosses the absolute deadline is compensated without late ISSUED', async () => {
  let now = Date.now();
  let activeRoom: string | undefined;
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    now: () => now,
    scheduleSessionExpiry: () => ({ unref() {} }),
    cancelSessionExpiry: () => {},
    signParticipantToken: async (token) => {
      now += 120_000;
      return token.toJwt();
    },
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  await assert.rejects(
    adapter.createConnectionDetails({}),
    /LIVEKIT_TOKEN_DEADLINE_BINDING_FAILED/,
  );
  assert.equal(activeRoom, undefined);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'FAILED_CLOSED');
  assert.notEqual(adapter.deviceLanIssuanceSnapshot()?.state, 'ISSUED');
});

test('B1 aborted issuance enters REVOKING immediately and compensates the late room', async () => {
  let activeRoom: string | undefined;
  let releaseCreate: (() => void) | undefined;
  const createBarrier = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        await createBarrier;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: activeRoom }]
          : [];
      },
    },
  });
  const controller = new AbortController();
  const issuance = adapter.createConnectionDetails({}, { signal: controller.signal });
  controller.abort();
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKING');
  releaseCreate?.();
  await assert.rejects(issuance, /DEVICE_LAN_REQUEST_DENIED/);
  assert.equal(activeRoom, undefined);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'FAILED_CLOSED');
});

test('B1 cleanup completion is withheld until deleteRoom plus listRooms proves absence', async () => {
  let activeRoom: string | undefined;
  let returnWrongName = true;
  const timeline: TimelineItem[] = [];
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: false,
    scheduleCleanupRetry: () => ({ unref() {} }),
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        return {};
      },
      async listParticipants() {
        return [];
      },
      async deleteRoom() {},
      async listRooms(names?: string[]) {
        return activeRoom !== undefined && names?.includes(activeRoom)
          ? [{ name: returnWrongName ? 'wrong_room_name' : activeRoom }]
          : [];
      },
    },
  });
  const details = await adapter.createConnectionDetails({});
  adapter.subscribe(details.roomName, (item) => timeline.push(item));
  await assert.rejects(adapter.stopSession(details.roomName), /ROOM_DELETE_NOT_VERIFIED/);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKING');
  assert.equal(adapter.sessionExists(details.roomName), true);
  assert.equal(timeline.some((item) => item.verifiedCleanup === true), false);
  assert.throws(
    () => adapter.ingest(details.roomName, {}),
    /DEVICE_LAN_SESSION_NOT_ADMISSIBLE/,
  );

  activeRoom = undefined;
  returnWrongName = false;
  await adapter.stopSession(details.roomName);
  assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED');
  assert.equal(adapter.sessionExists(details.roomName), false);
  assert.equal(timeline.some((item) => item.verifiedCleanup === true), true);
});

test('B1 disconnect, duplicate identity and reconnect events revoke before DirectLoop can continue', async () => {
  type RoomHandler = (...args: unknown[]) => void;
  const gatewayBinding = gatewayPublisherIdentityBinding();
  class FakeRoom {
    readonly handlers = new Map<unknown, RoomHandler[]>();
    readonly remoteParticipants = new Map<string, RemoteParticipant>();
    readonly localParticipant = {
      identity: gatewayBinding.identity,
      attributes: gatewayBinding.attributes,
      async publishData() {},
      async sendChatMessage() {},
    };
    connected = false;

    on(event: unknown, handler: RoomHandler): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: unknown, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }

    async connect(): Promise<void> {
      this.connected = true;
    }

    async disconnect(): Promise<void> {
      this.connected = false;
    }
  }

  for (const hostile of ['disconnect', 'duplicate', 'reconnect'] as const) {
    let activeRoom: string | undefined;
    let physicalIdentity = '';
    let directStopCount = 0;
    const fakeRoom = new FakeRoom();
    const directLoop = {
      stopSession() {
        directStopCount += 1;
      },
      clearAfterVerifiedCleanup() {},
      invalidate() {},
      async execute() {},
    } as unknown as DirectLoopController;
    const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
      enableGatewayJoin: true,
      directLoopController: directLoop,
      roomFactory: () => fakeRoom as never,
      roomService: {
        async createRoom(options: { name?: string }) {
          activeRoom = options.name;
          return {};
        },
        async listParticipants() {
          return physicalIdentity ? [{ identity: physicalIdentity }] : [];
        },
        async deleteRoom(room: string) {
          if (activeRoom === room) activeRoom = undefined;
        },
        async listRooms(names?: string[]) {
          return activeRoom !== undefined && names?.includes(activeRoom)
            ? [{ name: activeRoom }]
            : [];
        },
      },
    });
    const details = await adapter.createConnectionDetails({});
    const claims = await new TokenVerifier(
      b1GatewayConfig().apiKey,
      b1GatewayConfig().apiSecret,
    ).verify(details.participantToken, 0);
    physicalIdentity = claims.sub!;
    for (let attempt = 0; attempt < 30 && !fakeRoom.connected; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fakeRoom.connected, true, hostile);
    const participant = {
      identity: physicalIdentity,
      attributes: claims.attributes!,
      trackPublications: new Map(),
    } as unknown as RemoteParticipant;
    fakeRoom.remoteParticipants.set(physicalIdentity, participant);
    fakeRoom.emit(RoomEvent.ParticipantConnected, participant);

    if (hostile === 'disconnect') {
      fakeRoom.emit(RoomEvent.ParticipantDisconnected, participant);
    } else if (hostile === 'duplicate') {
      const duplicate = {
        identity: physicalIdentity,
        attributes: claims.attributes!,
        trackPublications: new Map(),
      } as unknown as RemoteParticipant;
      fakeRoom.emit(RoomEvent.ParticipantConnected, duplicate);
    } else {
      fakeRoom.emit(RoomEvent.Reconnecting);
    }
    assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKING', hostile);
    assert.ok(directStopCount > 0, hostile);
    for (
      let attempt = 0;
      attempt < 30 && adapter.deviceLanIssuanceSnapshot()?.state !== 'REVOKED';
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED', hostile);
    assert.equal(adapter.sessionExists(details.roomName), false, hostile);
  }
});

test('B1 RTC parser accepts an actual envelope and rejects duplicate root/nested keys and invalid bytes', async () => {
  type RoomHandler = (...args: unknown[]) => void;
  const gatewayBinding = gatewayPublisherIdentityBinding();
  const published: Uint8Array[] = [];
  let gatewayToken: string | undefined;
  class EventRoom {
    readonly handlers = new Map<unknown, RoomHandler[]>();
    readonly remoteParticipants = new Map<string, RemoteParticipant>();
    readonly localParticipant = {
      identity: gatewayBinding.identity,
      attributes: gatewayBinding.attributes,
      async publishData(payload: Uint8Array) {
        published.push(payload);
      },
      async sendChatMessage() {},
    };
    connected = false;

    on(event: unknown, handler: RoomHandler): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: unknown, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }

    async connect(_url: string, token: string): Promise<void> {
      gatewayToken = token;
      this.connected = true;
    }

    async disconnect(): Promise<void> {
      this.connected = false;
    }
  }

  let activeRoom: string | undefined;
  let physicalIdentity = '';
  const eventRoom = new EventRoom();
  const timeline: TimelineItem[] = [];
  const directLoop = {
    stopSession() {},
    clearAfterVerifiedCleanup() {},
    invalidate() {},
    async execute() {},
  } as unknown as DirectLoopController;
  const adapter = new DeviceSessionAdapter(b1GatewayConfig(), {
    enableGatewayJoin: true,
    directLoopController: directLoop,
    roomFactory: () => eventRoom as never,
    roomService: {
      async createRoom(options: { name?: string }) {
        activeRoom = options.name;
        return {};
      },
      async listParticipants() {
        return physicalIdentity ? [{ identity: physicalIdentity }] : [];
      },
      async deleteRoom(room: string) {
        if (activeRoom === room) activeRoom = undefined;
      },
      async listRooms() {
        return [];
      },
    },
  });
  const details = await adapter.createConnectionDetails({});
  adapter.subscribe(details.roomName, (item) => timeline.push(item));
  const claims = await new TokenVerifier(
    b1GatewayConfig().apiKey,
    b1GatewayConfig().apiSecret,
  ).verify(details.participantToken, 0);
  physicalIdentity = claims.sub!;
  assert.deepEqual(claims.video, {
    room: details.roomName,
    roomJoin: true,
    canPublish: true,
    canPublishSources: ['microphone'],
    canPublishData: false,
    canSubscribe: true,
  });
  assert.deepEqual(Object.keys(claims).sort(), [
    'attributes',
    'exp',
    'iat',
    'iss',
    'name',
    'nbf',
    'sub',
    'video',
  ]);
  assertNoExcessLiveKitGrants(claims);
  for (let attempt = 0; attempt < 40 && published.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(published.length > 0);
  assert.ok(gatewayToken);
  const gatewayClaims = await new TokenVerifier(
    b1GatewayConfig().apiKey,
    b1GatewayConfig().apiSecret,
  ).verify(gatewayToken, 0);
  assert.equal(gatewayClaims.sub, gatewayBinding.identity);
  assert.equal(gatewayClaims.name, 'Windows Demo Gateway');
  assert.deepEqual(gatewayClaims.attributes, gatewayBinding.attributes);
  assert.deepEqual(gatewayClaims.video, {
    room: details.roomName,
    roomJoin: true,
    canPublish: false,
    canPublishData: true,
    canSubscribe: true,
  });
  assertNoExcessLiveKitGrants(gatewayClaims);
  assert.deepEqual(Object.keys(eventRoom.localParticipant).sort(), [
    'attributes',
    'identity',
    'publishData',
    'sendChatMessage',
  ]);
  const validEnvelopeBytes = published[0]!;
  const gatewayParticipant = {
    identity: gatewayBinding.identity,
    attributes: gatewayBinding.attributes,
    trackPublications: new Map(),
  } as unknown as RemoteParticipant;
  const rejectedBeforeControl = timeline.filter((item) => item.kind === 'rejected').length;
  eventRoom.emit(
    RoomEvent.DataReceived,
    validEnvelopeBytes,
    gatewayParticipant,
    DataPacketKind.KIND_RELIABLE,
    RELIABLE_EVENT_TOPIC,
  );
  assert.equal(
    timeline.filter((item) => item.kind === 'rejected').length,
    rejectedBeforeControl,
  );

  const validEnvelopeJson = new TextDecoder('utf-8', { fatal: true }).decode(
    validEnvelopeBytes,
  );
  const validEnvelope = JSON.parse(validEnvelopeJson) as EventEnvelope;
  assert.equal(validEnvelope.event_type, 'paios.phase0.demo.session.started');
  assert.deepEqual(
    (validEnvelope.payload.credential_lease as { scopes?: unknown }).scopes,
    ['room_join', 'publish_audio'],
  );
  const hostilePayloads = [
    utf8(`{"schema_version":"phase0-demo/0.3",${validEnvelopeJson.slice(1)}`),
    utf8(
      `${String.raw`{"\u0073chema_version":"phase0-demo/0.3",`}${validEnvelopeJson.slice(1)}`,
    ),
    utf8(
      validEnvelopeJson.replace(
        '"origin":{',
        '"origin":{"device_id":"duplicate-device",',
      ),
    ),
    utf8(
      validEnvelopeJson.replace(
        '"payload":{',
        '"payload":{"active_device_id":"duplicate-device",',
      ),
    ),
    new Uint8Array([0xc3, 0x28]),
    utf8(`${validEnvelopeJson} trailing`),
  ];
  for (const hostile of hostilePayloads) {
    eventRoom.emit(
      RoomEvent.DataReceived,
      hostile,
      gatewayParticipant,
      DataPacketKind.KIND_RELIABLE,
      RELIABLE_EVENT_TOPIC,
    );
  }
  const parserRejections = timeline.filter(
    (item) => item.kind === 'rejected' && item.errors?.[0] === 'MALFORMED_EVENT_JSON',
  );
  assert.equal(parserRejections.length, hostilePayloads.length);
  assert.equal(hostilePayloads.length, 6);
  await adapter.stopSession(details.roomName);
  assert.equal(activeRoom, undefined);
});

test('B1 source keeps token and attestation memory-only and statically binds React one-shot HTTPS', () => {
  const mainSource = readFileSync(
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    'utf8',
  );
  const adapterSource = readFileSync(
    fileURLToPath(new URL('../src/device-session-adapter.ts', import.meta.url)),
    'utf8',
  );
  const utilsSource = readFileSync(
    fileURLToPath(
      new URL('../../../upstream/phase0/LiveKit_Agent_Starter_React/lib/utils.ts', import.meta.url),
    ),
    'utf8',
  );
  const appSource = readFileSync(
    fileURLToPath(
      new URL(
        '../../../upstream/phase0/LiveKit_Agent_Starter_React/components/app/app.tsx',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  assert.ok(mainSource.includes('sessionTtlSeconds: 120'));
  assert.ok(mainSource.includes('tokenTtlSeconds: 120'));
  assert.ok(mainSource.includes("'LIVEKIT_ROOM_AUTO_CREATE'"));
  assert.ok(mainSource.includes("!== 'false'"));
  assert.ok(mainSource.includes("'DEVICE_LAN_HOST_IPV4_CIDR'"));
  assert.ok(mainSource.includes('request.socket.remoteAddress'));
  assert.ok(mainSource.includes('timingSafeEqual(candidateDigest, expectedDigest)'));
  assert.ok(mainSource.includes("'Cache-Control': 'no-store'"));
  assert.ok(mainSource.includes("'DEVICE_LAN_REQUEST_DENIED'"));
  assert.ok(mainSource.includes("throw new Error('LOOPBACK_LIVEKIT_URL_REQUIRED')"));
  assert.equal(mainSource.includes('console.log'), false);
  assert.equal(mainSource.includes('JSON.stringify(request.headers)'), false);
  assert.equal(mainSource.includes('JSON.stringify(request.rawHeaders)'), false);
  assert.equal(mainSource.includes('JSON.stringify(request.url)'), false);
  assert.equal(mainSource.includes('JSON.stringify(requestBody)'), false);

  assert.ok(adapterSource.includes("state: 'ARMED'"));
  assert.ok(adapterSource.includes("deviceLanIssuance.state = 'FAILED_CLOSED'"));
  assert.ok(adapterSource.includes("issuance.state = 'REVOKING'"));
  assert.ok(adapterSource.includes("issuance.state = 'REVOKED'"));
  assert.ok(adapterSource.includes('this.#deviceLanRoomNames.add(sessionId)'));
  assert.ok(adapterSource.includes('canPublishSources: [ServerTrackSource.MICROPHONE]'));
  assert.equal(adapterSource.includes('roomCreate: true'), false);
  assert.ok(adapterSource.includes('await localParticipant.sendChatMessage('));
  assert.ok(adapterSource.includes('await participant.publishData('));
  for (const forbidden of [
    '.publishTrack(',
    '.publishAudioTrack(',
    '.publishVideoTrack(',
    '.setMicrophoneEnabled(',
    '.setCameraEnabled(',
    '.setScreenShareEnabled(',
  ]) {
    assert.equal(adapterSource.includes(forbidden), false, forbidden);
  }
  assert.ok(adapterSource.includes('setLiveKitIssuedAt(token'));
  assert.ok(adapterSource.includes('new AccessToken('));
  assert.ok(adapterSource.includes('class StrictJsonParser'));
  assert.ok(adapterSource.includes('const STRICT_JSON_MAX_DEPTH = 32'));
  assert.equal(adapterSource.includes('JSON.parse'), false);
  assert.equal(adapterSource.includes('createHmac'), false);
  assert.equal(adapterSource.includes('SignJWT'), false);
  assert.equal(adapterSource.includes("from 'jose'"), false);

  const combinedReactSource = `${utilsSource}\n${appSource}`;
  assert.ok(utilsSource.includes("window.location.protocol !== 'https:'"));
  assert.ok(utilsSource.includes("new URL('/connection-details', window.location.origin)"));
  assert.ok(utilsSource.includes('let tokenRequestConsumed = false'));
  assert.ok(utilsSource.includes("credentials: 'omit'"));
  assert.ok(utilsSource.includes("redirect: 'error'"));
  assert.ok(utilsSource.includes('response.url !== connectionDetailsUrl.href'));
  assert.equal(mainSource.includes("kind: 'stop'"), false);
  assert.equal(mainSource.includes('stopSession(route.roomName'), false);
  assert.ok(utilsSource.includes("throw new Error('CONNECTION_DETAILS_TOKEN_BINDING_INVALID')"));
  assert.ok(utilsSource.includes('expiresAt - issuedAt > 120'));
  assert.ok(utilsSource.includes("video.canPublishSources[0] !== 'microphone'"));
  assert.ok(utilsSource.includes('video.canPublishData !== false'));
  assert.ok(utilsSource.includes('video.canSubscribe !== true'));
  assert.ok(utilsSource.includes('FORBIDDEN_TOKEN_CLAIMS'));
  assert.ok(utilsSource.includes('await onRoomBound(startContext, acceptedDetails.roomName)'));
  assert.equal(utilsSource.includes('onConnectionDetails'), false);
  assert.equal(utilsSource.includes('NEXT_PUBLIC_CONN_DETAILS_ENDPOINT'), false);
  assert.ok(appSource.includes('sessionConsumedRef.current = true'));
  assert.ok(
    appSource.includes('roomConnectOptions: { maxRetries: 0, autoSubscribe: false }'),
  );
  assert.equal(appSource.includes('autoSubscribe: true'), false);
  assert.ok(appSource.includes('nextRetryDelayInMs: () => null'));
  assert.ok(appSource.includes('state.controller.abort()'));
  assert.ok(appSource.includes('startGenerationRef.current += 1'));
  assert.ok(appSource.includes('endInFlightRef.current = undefined'));
  assert.ok(appSource.includes('state.roomName = roomName'));
  for (const forbidden of [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'document.cookie',
    'history.pushState',
    'history.replaceState',
    'location.href =',
    'searchParams.set',
    'publishData(',
    'sendChatMessage(',
    '.publishTrack(',
    'setSubscribed(',
    'setCameraEnabled(',
    'setScreenShareEnabled(',
  ]) {
    assert.equal(combinedReactSource.includes(forbidden), false, forbidden);
  }
  assert.equal(
    /console\.(?:log|info|warn|error)\([^)]*participantToken/s.test(combinedReactSource),
    false,
  );
});

test('React consumes only directed Gateway ChatMessage events with lifecycle-clean room binding', async () => {
  const consumerSource = readFileSync(
    fileURLToPath(
      new URL(
        '../../../upstream/phase0/LiveKit_Agent_Starter_React/components/agents-ui/blocks/agent-session-view-01/components/agent-session-block.tsx',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  const helperStart = consumerSource.indexOf('function asGatewayChatMessage(');
  const helperEnd = consumerSource.indexOf('\ninterface GatewayMessageState', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const { ModuleKind, ScriptTarget, transpileModule } = await import('typescript');
  const helperModule = transpileModule(
    `${consumerSource.slice(helperStart, helperEnd)}\nexport { asGatewayChatMessage };`,
    {
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const { asGatewayChatMessage } = (await import(
    `data:text/javascript;base64,${Buffer.from(helperModule).toString('base64')}`
  )) as {
    asGatewayChatMessage(
      message: Record<string, unknown>,
      participant?: Record<string, unknown>,
    ): Record<string, unknown> | undefined;
  };

  const message = {
    id: 'gateway-message-1',
    timestamp: 1_786_272_600_000,
    message: 'PINNED_BROWSER_VISIBLE_REPLY',
    editTimestamp: 1_786_272_600_001,
    generated: true,
  };
  const gateway = { identity: 'windows_gateway_01', isLocal: false };
  assert.deepEqual(asGatewayChatMessage(message, gateway), {
    ...message,
    type: 'chatMessage',
    from: gateway,
  });
  assert.equal(asGatewayChatMessage(message), undefined);
  assert.equal(
    asGatewayChatMessage(message, { identity: 'windows_gateway_01', isLocal: true }),
    undefined,
  );
  assert.equal(
    asGatewayChatMessage(message, { identity: 'alternate_participant', isLocal: false }),
    undefined,
  );
  assert.equal(
    asGatewayChatMessage(message, { identity: 'windows_gateway_01', isLocal: undefined }),
    undefined,
  );

  assert.equal(consumerSource.includes('useSessionMessages'), false);
  assert.equal(
    consumerSource.match(/room\.on\(RoomEvent\.ChatMessage, handleGatewayChatMessage\)/g)?.length,
    1,
  );
  assert.equal(
    consumerSource.match(/room\.off\(RoomEvent\.ChatMessage, handleGatewayChatMessage\)/g)?.length,
    1,
  );
  assert.ok(consumerSource.includes('gatewayMessageState?.room === session.room'));
  assert.ok(consumerSource.includes('let active = true'));
  assert.ok(consumerSource.includes('active = false'));
  assert.ok(
    consumerSource.includes(
      "data-phase0-evidence={gatewayMessage ? 'gateway-chat-message-rendered' : undefined}",
    ),
  );
  assert.ok(consumerSource.includes('data-phase0-message-id={gatewayMessage?.id}'));
  assert.ok(consumerSource.includes('data-phase0-message-text={gatewayMessage?.message}'));
  for (const forbidden of [
    'RoomEvent.DataReceived',
    'registerTextStreamHandler',
    'registerByteStreamHandler',
    'setSubscribed(',
    'subscribeToTrack(',
    'RemoteTrackSubscribed',
    '.attach(',
    '.play(',
    'decodeAudioData(',
  ]) {
    assert.equal(consumerSource.includes(forbidden), false, forbidden);
  }
});


test('React Stop helper verifies terminal cleanup and bounds in-progress polling', async () => {
  const utilsSource = readFileSync(
    fileURLToPath(
      new URL('../../../upstream/phase0/LiveKit_Agent_Starter_React/lib/utils.ts', import.meta.url),
    ),
    'utf8',
  );
  const appSource = readFileSync(
    fileURLToPath(
      new URL(
        '../../../upstream/phase0/LiveKit_Agent_Starter_React/components/app/app.tsx',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  const endpointStart = utilsSource.indexOf('function getConnectionDetailsUrl()');
  const endpointEnd = utilsSource.indexOf('\n/**', endpointStart);
  const helperStart = utilsSource.indexOf('const SESSION_STOP_MAX_REQUESTS');
  const helperEnd = utilsSource.indexOf('\nexport function stopMicrophoneNow', helperStart);
  assert.ok(endpointStart >= 0 && endpointEnd > endpointStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const moduleSource = transpileModule(
    [
      "const DEVICE_LAN_ROOM_PATTERN = /^phase0_session_[a-f0-9]{20}$/;",
      utilsSource.slice(endpointStart, endpointEnd),
      utilsSource.slice(helperStart, helperEnd),
      'export { stopDeviceLanSession };',
    ].join('\n'),
    { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } },
  ).outputText;
  const stopModule = (await import(
    `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
  )) as { stopDeviceLanSession(roomName: string): Promise<void> };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'https:', origin: 'https://198.51.100.14' },
      setTimeout,
      clearTimeout,
    },
  });
  const originalFetch = globalThis.fetch;
  const roomName = 'phase0_session_0123456789abcdefabcd';
  const otherRoomName = 'phase0_session_abcdef0123456789abcd';
  const stopUrl = `https://198.51.100.14/sessions/${roomName}/stop`;
  const cleanupBody = '{"status":"cleanup_complete"}';
  const inProgressBody = '{"error":"SESSION_STOP_IN_PROGRESS"}';
  const cleanedBody = '{"error":"SESSION_CLEANED"}';
  type ResponseOptions = {
    redirected?: boolean;
    url?: string;
    headers?: Record<string, string>;
    readError?: boolean;
  };
  const response = (status: number, body: string, options: ResponseOptions = {}) => {
    const bytes = new TextEncoder().encode(body);
    return {
      status,
      redirected: options.redirected ?? false,
      url: options.url ?? stopUrl,
      headers: new Headers({
        'cache-control': 'no-store',
        'content-length': String(bytes.length),
        'content-type': 'application/json; charset=utf-8',
        ...options.headers,
      }),
      arrayBuffer: options.readError
        ? async () => {
            throw new Error('BODY_READ_FAILED');
          }
        : async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  };
  type FetchStep = Response | Error | (() => Promise<Response>);
  type FetchCall = { url: string; init: RequestInit | undefined };
  const installFetch = (steps: FetchStep[]) => {
    const calls: FetchCall[] = [];
    const queue = [...steps];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: input instanceof URL ? input.href : String(input), init });
      const step = queue.shift();
      if (step === undefined) throw new Error('UNEXPECTED_FETCH');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    }) as typeof fetch;
    return calls;
  };
  const assertClosedRequest = (calls: FetchCall[]) => {
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.url, stopUrl);
      assert.deepEqual(Object.keys(call.init ?? {}).sort(), [
        'cache',
        'credentials',
        'method',
        'redirect',
        'signal',
      ]);
      assert.equal(call.init?.method, 'POST');
      assert.equal(call.init?.cache, 'no-store');
      assert.equal(call.init?.credentials, 'omit');
      assert.equal(call.init?.redirect, 'error');
      assert.ok(call.init?.signal instanceof AbortSignal);
    }
  };

  try {
    let calls = installFetch([response(200, cleanupBody)]);
    await assert.doesNotReject(stopModule.stopDeviceLanSession(roomName));
    assert.equal(calls.length, 1);
    assertClosedRequest(calls);

    for (const status of [201, 202, 299]) {
      calls = installFetch([response(status, cleanupBody)]);
      await assert.rejects(stopModule.stopDeviceLanSession(roomName), {
        message: `SESSION_STOP_REJECTED_${status}`,
      });
      assert.equal(calls.length, 1);
      assertClosedRequest(calls);
    }

    calls = installFetch([response(410, cleanedBody)]);
    await assert.doesNotReject(stopModule.stopDeviceLanSession(roomName));
    assert.equal(calls.length, 1);

    calls = installFetch([response(409, inProgressBody), response(200, cleanupBody)]);
    await assert.doesNotReject(stopModule.stopDeviceLanSession(roomName));
    assert.equal(calls.length, 2);
    assertClosedRequest(calls);

    calls = installFetch([response(409, inProgressBody), response(410, cleanedBody)]);
    await assert.doesNotReject(stopModule.stopDeviceLanSession(roomName));
    assert.equal(calls.length, 2);

    calls = installFetch(Array.from({ length: 6 }, () => response(409, inProgressBody)));
    await assert.rejects(stopModule.stopDeviceLanSession(roomName), {
      message: 'SESSION_STOP_POLL_EXHAUSTED',
    });
    assert.equal(calls.length, 6);

    const hostileResponses = [
      response(410, '{"error":"SESSION_STALE"}'),
      response(410, '{"error":"SESSION_CLEANED","extra":true}'),
      response(410, cleanedBody, { headers: { 'content-type': 'application/json' } }),
      response(410, cleanedBody, { headers: { 'cache-control': 'private' } }),
      response(410, cleanedBody, { headers: { 'content-length': '999' } }),
      response(410, cleanedBody, { redirected: true }),
      response(410, cleanedBody, { url: `${stopUrl}?redirected=1` }),
      response(409, '{"error":"SESSION_CLEANED"}'),
      response(409, '{"error":"SESSION_STOP_IN_PROGRESS","extra":true}'),
      response(200, cleanupBody, { readError: true }),
      response(410, cleanedBody, { readError: true }),
      response(409, inProgressBody, { readError: true }),
    ];
    for (const hostile of hostileResponses) {
      calls = installFetch([hostile]);
      await assert.rejects(stopModule.stopDeviceLanSession(roomName));
      assert.equal(calls.length, 1);
    }

    for (const status of [403, 404, 500, 503]) {
      calls = installFetch([response(status, `{"error":"STATUS_${status}"}`)]);
      await assert.rejects(stopModule.stopDeviceLanSession(roomName), {
        message: `SESSION_STOP_REJECTED_${status}`,
      });
      assert.equal(calls.length, 1);
    }
    calls = installFetch([new Error('NETWORK_DOWN')]);
    await assert.rejects(stopModule.stopDeviceLanSession(roomName), {
      message: 'SESSION_STOP_REQUEST_FAILED',
    });
    assert.equal(calls.length, 1);
    calls = installFetch([new DOMException('aborted', 'AbortError')]);
    await assert.rejects(stopModule.stopDeviceLanSession(roomName), {
      message: 'SESSION_STOP_REQUEST_FAILED',
    });
    assert.equal(calls.length, 1);

    calls = [];
    let activeHungRequests = 0;
    let observedAbortSignals = 0;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: input instanceof URL ? input.href : String(input), init });
      activeHungRequests += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        signal.addEventListener(
          'abort',
          () => {
            observedAbortSignals += 1;
            activeHungRequests -= 1;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    const hungRequestStartedAt = Date.now();
    await assert.rejects(stopModule.stopDeviceLanSession(roomName), {
      message: 'SESSION_STOP_TIMEOUT',
    });
    const hungRequestElapsedMs = Date.now() - hungRequestStartedAt;
    assert.ok(hungRequestElapsedMs >= 4_800 && hungRequestElapsedMs < 7_500);
    assert.equal(calls.length, 1);
    assertClosedRequest(calls);
    assert.equal(observedAbortSignals, 1);
    assert.equal(activeHungRequests, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls.length, 1);
    assert.equal(activeHungRequests, 0);

    let resolveFetch!: (value: Response) => void;
    calls = installFetch([
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    ]);
    const first = stopModule.stopDeviceLanSession(roomName);
    const concurrent = stopModule.stopDeviceLanSession(roomName);
    assert.equal(first, concurrent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    await assert.rejects(stopModule.stopDeviceLanSession(otherRoomName), {
      message: 'SESSION_STOP_OTHER_ROOM_IN_PROGRESS',
    });
    assert.equal(calls.length, 1);
    resolveFetch(response(200, cleanupBody));
    await Promise.all([first, concurrent]);
    assert.equal(calls.length, 1);

    assert.throws(() => stopModule.stopDeviceLanSession('phase0_session_invalid'), {
      message: 'DEVICE_LAN_SESSION_ID_INVALID',
    });
    assert.ok(appSource.includes('const existingEnd = endInFlightRef.current'));
    assert.ok(appSource.includes('if (existingEnd?.generation === state.generation)'));
    assert.ok(appSource.includes('const existing = remoteCleanupByRoomRef.current.get(roomName)'));
    assert.ok(appSource.includes('if (existing) return existing'));
    assert.equal(utilsSource.includes("redirect: 'follow'"), false);
    assert.equal(utilsSource.includes("credentials: 'include'"), false);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test('official React validator closes canSubscribe and grant claim variants', async () => {
  const utilsSource = readFileSync(
    fileURLToPath(
      new URL('../../../upstream/phase0/LiveKit_Agent_Starter_React/lib/utils.ts', import.meta.url),
    ),
    'utf8',
  );
  const constantsStart = utilsSource.indexOf('const CONNECTION_DETAILS_KEYS');
  const constantsEnd = utilsSource.indexOf('export interface DeviceLanStartContext');
  const helpersStart = utilsSource.indexOf('function isNonemptyString');
  const helpersEnd = utilsSource.indexOf('function getExactRevealedRoom');
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
  const { ModuleKind, ScriptTarget, transpileModule } = await import('typescript');
  const validatorModuleSource = transpileModule(
    [
      utilsSource.slice(constantsStart, constantsEnd),
      utilsSource.slice(helpersStart, helpersEnd),
      'export { validateDeviceLanJwt };',
    ].join('\n'),
    { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } },
  ).outputText;
  const validatorModule = await import(
    `data:text/javascript;base64,${Buffer.from(validatorModuleSource).toString('base64')}`
  ) as { validateDeviceLanJwt(details: Record<string, string>): void };

  const now = Math.floor(Date.now() / 1_000);
  const roomName = 'phase0_session_0123456789abcdefabcd';
  const participantName = 'user';
  const baseVideo = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishSources: ['microphone'],
    canPublishData: false,
    canSubscribe: true,
  };
  const basePayload = {
    iss: 'p0_downlink_validator',
    sub: 'web_device_0123456789abcdefabcd',
    name: participantName,
    nbf: 0,
    iat: now,
    exp: now + 120,
    video: baseVideo,
    attributes: {
      schema_version: 'phase0-demo/0.3',
      device_id: 'web_device_0123456789abcdefabcd',
      device_class: 'web_mobile',
      client_instance_id: 'web_client_0123456789abcdefabcd',
      run_id: 'downlink_validator',
    },
  };
  const encode = (value: object | string) =>
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const details = (payload: object | string) => ({
    serverUrl: 'wss://192.168.50.14',
    roomName,
    participantName,
    participantToken: `${encode({ alg: 'HS256' })}.${encode(payload)}.${'A'.repeat(43)}`,
  });
  const reject = (payload: object | string) => assert.throws(
    () => validatorModule.validateDeviceLanJwt(details(payload)),
    { message: 'CONNECTION_DETAILS_TOKEN_BINDING_INVALID' },
  );

  assert.doesNotThrow(() => validatorModule.validateDeviceLanJwt(details(basePayload)));
  const withoutCanSubscribe = structuredClone(basePayload);
  delete (withoutCanSubscribe.video as Partial<typeof baseVideo>).canSubscribe;
  reject(withoutCanSubscribe);
  reject({ ...basePayload, video: { ...baseVideo, canSubscribe: false } });
  reject({ ...basePayload, video: { ...baseVideo, canSubscribe: 'true' } });
  reject(
    JSON.stringify(basePayload).replace(
      '"canSubscribe":true',
      '"canSubscribe":true,"canSubscribe":true',
    ),
  );
  reject({ ...basePayload, video: { ...baseVideo, canSubscribeMetrics: true } });
  reject({ ...basePayload, video: { ...baseVideo, canPublishData: true } });
  reject({ ...basePayload, roomConfig: {} });
});

test('B1 generic React token route returns the same closed no-store 403 for every method', async () => {
  type DisabledTokenRouteHandler = () => Promise<{
    readonly status: number;
    readonly ok: boolean;
    readonly redirected: boolean;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
  const routeUrl = new URL(
    '../../../upstream/phase0/LiveKit_Agent_Starter_React/app/api/token/route.ts',
    import.meta.url,
  );
  const route = (await import(routeUrl.href)) as {
    readonly revalidate: number;
    readonly GET: DisabledTokenRouteHandler;
    readonly HEAD: DisabledTokenRouteHandler;
    readonly POST: DisabledTokenRouteHandler;
    readonly PUT: DisabledTokenRouteHandler;
    readonly PATCH: DisabledTokenRouteHandler;
    readonly DELETE: DisabledTokenRouteHandler;
    readonly OPTIONS: DisabledTokenRouteHandler;
  };
  const handlers = {
    GET: route.GET,
    HEAD: route.HEAD,
    POST: route.POST,
    PUT: route.PUT,
    PATCH: route.PATCH,
    DELETE: route.DELETE,
    OPTIONS: route.OPTIONS,
  };
  assert.equal(route.revalidate, 0);
  for (const [method, handler] of Object.entries(handlers)) {
    assert.equal(handler, route.GET, method);
    const response = await handler();
    assert.equal(response.status, 403, method);
    assert.equal(response.ok, false, method);
    assert.equal(response.redirected, false, method);
    assert.equal(response.headers.get('cache-control'), 'no-store', method);
    assert.equal(response.headers.get('location'), null, method);
    assert.equal(response.headers.get('set-cookie'), null, method);
    const body = await response.text();
    assert.equal(body, '{"error":"GENERIC_TOKEN_ROUTE_DISABLED"}', method);
    assert.deepEqual(JSON.parse(body), { error: 'GENERIC_TOKEN_ROUTE_DISABLED' }, method);
  }
  assert.equal(Object.keys(handlers).length, 7);
});

function t15GatewayConfig(): GatewayConfig {
  return {
    ...b1GatewayConfig(),
    deviceLan: {
      clientLivekitUrl: B1_SECURITY.publicOrigin.replace('https:', 'wss:'),
      runId: T15_DEVICE_LAN_RUN_ID,
      roomAutoCreateDisabled: true,
      supervised: T15_BINDING,
    },
  };
}

type T15RoomHandler = (...args: any[]) => void;

class T15FakeRoom {
  readonly handlers = new Map<unknown, T15RoomHandler[]>();
  readonly remoteParticipants = new Map<string, RemoteParticipant>();
  readonly localParticipant = {
    identity: 'windows_gateway_01',
    trackPublications: new Map(),
    async publishData() {},
    async sendChatMessage() {},
  };
  readonly operations: string[];
  onConnect?: () => void;
  isConnected = false;
  connectionState = ConnectionState.CONN_DISCONNECTED;
  disconnectFailures = 0;

  constructor(operations: string[]) {
    this.operations = operations;
  }

  on(event: unknown, handler: T15RoomHandler): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: unknown, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async connect(): Promise<void> {
    this.operations.push('rtc.connect');
    this.isConnected = true;
    this.connectionState = ConnectionState.CONN_CONNECTED;
    this.onConnect?.();
  }

  async disconnect(): Promise<void> {
    this.operations.push('rtc.disconnect');
    if (this.disconnectFailures > 0) {
      this.disconnectFailures -= 1;
      throw new Error('INJECTED_RTC_DISCONNECT_FAILURE');
    }
    this.isConnected = false;
    this.connectionState = ConnectionState.CONN_DISCONNECTED;
  }
}

function t15DirectLoop(onClear: () => void = () => {}): DirectLoopController {
  return {
    stopSession() {},
    clearAfterVerifiedCleanup() { onClear(); },
    invalidate() {},
    async execute() {},
  } as unknown as DirectLoopController;
}

function createT15Harness(options: {
  readonly afterStage?: (room: T15FakeRoom) => void;
  readonly directLoopController?: DirectLoopController;
  readonly observeDirectLoop?: DeviceSessionAdapterDependencies['observeDirectLoop'];
  commitFailures?: number;
  deleteFailures?: number;
  cleanupFailures?: number;
  clearFailures?: number;
  disconnectFailures?: number;
} = {}) {
  const operations: string[] = [];
  const room = new T15FakeRoom(operations);
  room.disconnectFailures = options.disconnectFailures ?? 0;
  let activeRoom = false;
  const proofs: SupervisedAbsenceProofDocuments[] = [];
  const commits: Array<{ epoch: number; generation: number; committedAtUtc: string }> = [];
  const cleanupReceipts: SupervisedCleanupReceipt[] = [];
  let participantSnapshotCalls = 0;
  let commitFailures = options.commitFailures ?? 0;
  let deleteFailures = options.deleteFailures ?? 0;
  let cleanupFailures = options.cleanupFailures ?? 0;
  let clearFailures = options.clearFailures ?? 0;
  const adapter = new DeviceSessionAdapter(t15GatewayConfig(), {
    directLoopController:
      options.directLoopController ??
      t15DirectLoop(() => {
        operations.push('direct.clear');
        if (clearFailures > 0) {
          clearFailures -= 1;
          throw new Error('INJECTED_DIRECT_CLEAR_FAILURE');
        }
      }),
    ...(options.observeDirectLoop === undefined
      ? {}
      : { observeDirectLoop: options.observeDirectLoop }),
    roomFactory: () => room as never,
    supervisedFenceTimeoutMs: 100,
    sleep: async () => {},
    roomService: {
      async createRoom(options: { name?: string }) {
        operations.push('service.create');
        assert.equal(options.name, T15_SESSION_ID);
        assert.equal(activeRoom, false);
        activeRoom = true;
        return {};
      },
      async listRooms(names?: string[]) {
        operations.push(`service.listRooms:${activeRoom ? 'present' : 'absent'}`);
        assert.deepEqual(names, [T15_SESSION_ID]);
        return activeRoom ? [{ name: T15_SESSION_ID }] : [];
      },
      async listParticipants(roomName: string) {
        operations.push('service.listParticipants');
        participantSnapshotCalls += 1;
        assert.equal(roomName, T15_SESSION_ID);
        if (!activeRoom) throw new Error('POST_DELETE_LIST_PARTICIPANTS_FORBIDDEN');
        return [
          { identity: 'windows_gateway_01', tracks: [] },
          ...[...room.remoteParticipants.values()].map((participant) => ({
            identity: participant.identity,
            tracks: [...participant.trackPublications.values()],
          })),
        ];
      },
      async deleteRoom(roomName: string) {
        operations.push('service.delete');
        assert.equal(roomName, T15_SESSION_ID);
        if (deleteFailures > 0) {
          deleteFailures -= 1;
          throw new Error('INJECTED_ROOM_DELETE_FAILURE');
        }
        activeRoom = false;
      },
    },
    async stageSupervisedAbsenceProofs(documents) {
      operations.push('evidence.stage');
      proofs.push(documents);
      options.afterStage?.(room);
      return {
        async commit(committedAtUtc: string) {
          operations.push('evidence.commit');
          if (commitFailures > 0) {
            commitFailures -= 1;
            throw new Error('INJECTED_ABSENCE_COMMIT_FAILURE');
          }
          commits.push({
            epoch: documents.observationEpoch,
            generation: documents.observationGeneration,
            committedAtUtc,
          });
        },
      };
    },
    async persistSupervisedCleanupReceipt(receipt) {
      operations.push('evidence.cleanup');
      if (cleanupFailures > 0) {
        cleanupFailures -= 1;
        throw new Error('INJECTED_CLEANUP_RECEIPT_FAILURE');
      }
      cleanupReceipts.push(receipt);
    },
  });
  return {
    adapter,
    room,
    operations,
    proofs,
    commits,
    cleanupReceipts,
    participantSnapshotCalls: () => participantSnapshotCalls,
  };
}

function t15Participant(sid = 'PA_iphone001'): RemoteParticipant {
  return {
    identity: T15_DEVICE_ID,
    sid,
    attributes: {
      schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
      device_id: T15_DEVICE_ID,
      device_class: 'web_mobile',
      client_instance_id: T15_CLIENT_ID,
    },
    trackPublications: new Map(),
  } as unknown as RemoteParticipant;
}

function t15Publication(
  sid = 'TR_microphone001',
  kind = TrackKind.KIND_AUDIO,
  source = TrackSource.SOURCE_MICROPHONE,
) {
  return { sid, kind, source, subscribed: false } as any;
}

async function t15Tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function t15ContactProofDocuments(participantSid: string) {
  const harness = createT15Harness();
  await harness.adapter.prearmSupervisedSession();
  await harness.adapter.createConnectionDetails({});
  const participant = t15Participant(participantSid);
  const publication = t15Publication();
  harness.room.remoteParticipants.set(participant.identity, participant);
  harness.room.emit(RoomEvent.ParticipantConnected, participant);
  await t15Tick();
  participant.trackPublications.set(publication.sid, publication);
  harness.room.emit(RoomEvent.TrackPublished, publication, participant);
  await t15Tick();
  const stop = harness.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  participant.trackPublications.delete(publication.sid);
  harness.room.emit(RoomEvent.TrackUnpublished, publication, participant);
  harness.room.remoteParticipants.delete(participant.identity);
  harness.room.emit(RoomEvent.ParticipantDisconnected, participant);
  await stop;
  return harness.proofs[0]!;
}

test('direct-loop observations expose only redacted stages and a bounded terminal code', async () => {
  const transcriptText = 'SENSITIVE_TRANSCRIPT_SENTINEL';
  const modelText = 'SENSITIVE_MODEL_OUTPUT_SENTINEL';
  const observations: unknown[] = [];
  const directLoop = {
    stopSession() {},
    clearAfterVerifiedCleanup() {},
    invalidate() {},
    async execute(attempt: DirectLoopAttempt): Promise<'success'> {
      attempt.prepareSource();
      const request = attempt.acceptTranscriptAndModelRequested(
        { text: transcriptText } as never,
        Date.now(),
      );
      attempt.acceptModelResult({
        requestEventId: request.requestEventId,
        text: modelText,
        model: 'SENSITIVE_MODEL_NAME_SENTINEL',
        latencyMs: 1,
        observedAt: Date.now(),
      });
      await attempt.sendDirectedChat(modelText, attempt.originatingParticipantIdentity);
      return 'success';
    },
  } as unknown as DirectLoopController;
  const harness = createT15Harness({
    directLoopController: directLoop,
    observeDirectLoop: (observation) => observations.push(observation),
  });
  await harness.adapter.prearmSupervisedSession();
  await harness.adapter.createConnectionDetails({});
  const participant = t15Participant();
  const publication = t15Publication();
  const track = {};
  harness.room.remoteParticipants.set(participant.identity, participant);
  harness.room.emit(RoomEvent.ParticipantConnected, participant);
  await t15Tick();
  participant.trackPublications.set(publication.sid, publication);
  harness.room.emit(RoomEvent.TrackPublished, publication, participant);
  await t15Tick();
  publication.subscribed = true;
  publication.track = track;
  harness.room.emit(RoomEvent.TrackSubscribed, track, publication, participant);
  await t15Tick();
  await t15Tick();

  assert.deepEqual(
    observations.map((value: any) => value.stage),
    ['STT_CAPTURE', 'STT_RESULT', 'MODEL_REQUEST', 'MODEL_RESULT', 'DIRECTED_CHAT_SUCCESS'],
  );
  for (const observation of observations as any[]) {
    assert.deepEqual(Object.keys(observation).sort(), [
      'publication_sid',
      'session_id',
      'stage',
      'track_attempt',
    ]);
  }
  const serialized = JSON.stringify(observations);
  for (const secret of [transcriptText, modelText, 'SENSITIVE_MODEL_NAME_SENTINEL']) {
    assert.equal(serialized.includes(secret), false);
  }

  const terminalObservations: unknown[] = [];
  const failingLoop = {
    stopSession() {},
    clearAfterVerifiedCleanup() {},
    invalidate() {},
    async execute(attempt: DirectLoopAttempt): Promise<'success'> {
      attempt.prepareSource();
      throw new Error('MODEL_DEADLINE_EXCEEDED:SENSITIVE_ERROR_DETAIL_SENTINEL');
    },
  } as unknown as DirectLoopController;
  const failingHarness = createT15Harness({
    directLoopController: failingLoop,
    observeDirectLoop: (observation) => terminalObservations.push(observation),
  });
  await failingHarness.adapter.prearmSupervisedSession();
  await failingHarness.adapter.createConnectionDetails({});
  const failingParticipant = t15Participant('PA_iphone002');
  const failingPublication = t15Publication('TR_microphone002');
  const failingTrack = {};
  failingHarness.room.remoteParticipants.set(failingParticipant.identity, failingParticipant);
  failingHarness.room.emit(RoomEvent.ParticipantConnected, failingParticipant);
  await t15Tick();
  failingParticipant.trackPublications.set(failingPublication.sid, failingPublication);
  failingHarness.room.emit(RoomEvent.TrackPublished, failingPublication, failingParticipant);
  await t15Tick();
  failingPublication.subscribed = true;
  failingPublication.track = failingTrack;
  failingHarness.room.emit(
    RoomEvent.TrackSubscribed,
    failingTrack,
    failingPublication,
    failingParticipant,
  );
  await t15Tick();
  await t15Tick();

  assert.deepEqual(
    terminalObservations.map((value: any) => value.stage),
    ['STT_CAPTURE', 'TERMINAL_ERROR'],
  );
  assert.equal((terminalObservations[1] as any).error_code, 'MODEL_DEADLINE_EXCEEDED');
  assert.equal(JSON.stringify(terminalObservations).includes('SENSITIVE_ERROR_DETAIL_SENTINEL'), false);
});

test('pinned LiveKit delivers directed chat with auto-subscribe disabled and zero remote media', {
  timeout: 60_000,
}, async () => {
  const binary = fileURLToPath(
    new URL(
      '../../../upstream/phase0/LiveKit_Server/bin-v1.13.4/livekit-server.exe',
      import.meta.url,
    ),
  );
  assert.equal(sha256File(binary), '4d60c4043c8c6ff34845727587c7a7f86946d92c390b879ea35ad3793fcbd916');
  const basePort = 30_000 + Math.floor(Math.random() * 5_000);
  const apiKey = 'p0_downlink_test_key';
  const apiSecret = 'p0_downlink_test_secret_01234567890123456789';
  const config = [
    `port: ${basePort}`,
    'bind_addresses:',
    '  - 127.0.0.1',
    'rtc:',
    `  tcp_port: ${basePort + 1}`,
    `  udp_port: ${basePort + 2}`,
    '  use_external_ip: false',
    '  node_ip: 127.0.0.1',
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
    '',
  ].join('\n');
  const server = spawn(binary, [], {
    env: { ...process.env, LIVEKIT_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOutput = '';
  server.stdout?.on('data', (chunk: Buffer) => {
    serverOutput = `${serverOutput}${chunk.toString('utf8')}`.slice(-8_192);
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    serverOutput = `${serverOutput}${chunk.toString('utf8')}`.slice(-8_192);
  });
  const controlUrl = `http://127.0.0.1:${basePort}`;
  const signalUrl = `ws://127.0.0.1:${basePort}`;
  const service = new RoomServiceClient(controlUrl, apiKey, apiSecret);
  const rooms: OfficialRoom[] = [];
  const tracks: Array<LocalAudioTrack | LocalVideoTrack> = [];
  const waitUntil = async (
    predicate: () => boolean,
    timeoutMs: number,
    code: string,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(code);
  };
  const token = async (
    roomName: string,
    identity: string,
    grant: VideoGrant,
  ): Promise<string> => {
    const value = new AccessToken(apiKey, apiSecret, { identity, ttl: '2m' });
    value.addGrant({ room: roomName, roomJoin: true, ...grant });
    return value.toJwt();
  };
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (server.exitCode !== null) {
        throw new Error(`PINNED_LIVEKIT_START_FAILED:${serverOutput}`);
      }
      try {
        await service.listRooms();
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error('PINNED_LIVEKIT_READY_TIMEOUT');
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }

    const roomName = `p0_downlink_${Date.now().toString(36)}`;
    const gatewayIdentity = 'windows_gateway_01';
    const iphoneIdentity = 'web_device_downlink01';
    const alternateIdentity = 'web_device_alternate1';
    const hostileIdentity = 'hostile_media_publisher';
    const gateway = new OfficialRoom();
    const iphone = new OfficialRoom();
    const alternate = new OfficialRoom();
    const hostile = new OfficialRoom();
    rooms.push(gateway, iphone, alternate, hostile);
    await Promise.all([
      gateway.connect(
        signalUrl,
        await token(roomName, gatewayIdentity, {
          canPublish: false,
          canPublishData: true,
          canSubscribe: true,
        }),
        { autoSubscribe: true, dynacast: false },
      ),
      iphone.connect(
        signalUrl,
        await token(roomName, iphoneIdentity, {
          canPublish: true,
          canPublishSources: [ServerTrackSource.MICROPHONE],
          canPublishData: false,
          canSubscribe: true,
        }),
        { autoSubscribe: false, dynacast: false },
      ),
      alternate.connect(
        signalUrl,
        await token(roomName, alternateIdentity, {
          canPublish: false,
          canPublishData: false,
          canSubscribe: true,
        }),
        { autoSubscribe: false, dynacast: false },
      ),
      hostile.connect(
        signalUrl,
        await token(roomName, hostileIdentity, {
          canPublish: true,
          canPublishSources: [
            ServerTrackSource.MICROPHONE,
            ServerTrackSource.CAMERA,
            ServerTrackSource.SCREEN_SHARE,
            ServerTrackSource.SCREEN_SHARE_AUDIO,
          ],
          canPublishData: false,
          canSubscribe: false,
        }),
        { autoSubscribe: false, dynacast: false },
      ),
    ]);
    await waitUntil(
      () => rooms.every((room) => room.remoteParticipants.size === 3),
      5_000,
      'PINNED_LIVEKIT_PARTICIPANT_VISIBILITY_TIMEOUT',
    );

    let iphoneSubscribed = 0;
    iphone.on(RoomEvent.TrackSubscribed, () => {
      iphoneSubscribed += 1;
    });
    const publishAudio = async (name: string, source: TrackSource): Promise<void> => {
      const track = LocalAudioTrack.createAudioTrack(name, new AudioSource(48_000, 1));
      tracks.push(track);
      const options = new TrackPublishOptions();
      options.source = source;
      await hostile.localParticipant!.publishTrack(track, options);
    };
    const publishVideo = async (name: string, source: TrackSource): Promise<void> => {
      const track = LocalVideoTrack.createVideoTrack(name, new VideoSource(16, 16));
      tracks.push(track);
      const options = new TrackPublishOptions();
      options.source = source;
      await hostile.localParticipant!.publishTrack(track, options);
    };
    await publishAudio('hostile-microphone', TrackSource.SOURCE_MICROPHONE);
    await publishVideo('hostile-camera', TrackSource.SOURCE_CAMERA);
    await publishVideo('hostile-screen', TrackSource.SOURCE_SCREENSHARE);
    await publishAudio('hostile-screen-audio', TrackSource.SOURCE_SCREENSHARE_AUDIO);
    await waitUntil(
      () =>
        (iphone.remoteParticipants.get(hostileIdentity)?.trackPublications.size ?? 0) === 4,
      5_000,
      'PINNED_LIVEKIT_PUBLICATION_VISIBILITY_TIMEOUT',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(iphoneSubscribed, 0);
    const remotePublications = [
      ...(iphone.remoteParticipants.get(hostileIdentity)?.trackPublications.values() ?? []),
    ];
    assert.equal(remotePublications.length, 4);
    assert.ok(remotePublications.every((publication) => !publication.subscribed));
    assert.ok(remotePublications.every((publication) => publication.track === undefined));

    let alternateChatCount = 0;
    alternate.on(RoomEvent.ChatMessage, () => {
      alternateChatCount += 1;
    });
    const received = new Promise<{ message: string; sender: string | undefined }>((resolve) => {
      iphone.once(RoomEvent.ChatMessage, (message, participant) => {
        resolve({ message: message.message, sender: participant?.identity });
      });
    });
    await gateway.localParticipant!.sendChatMessage('PINNED_DIRECTED_REPLY', [iphoneIdentity]);
    const delivered = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PINNED_DIRECTED_CHAT_TIMEOUT')), 5_000),
      ),
    ]);
    assert.deepEqual(delivered, {
      message: 'PINNED_DIRECTED_REPLY',
      sender: gatewayIdentity,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(alternateChatCount, 0);
    assert.equal(iphoneSubscribed, 0);
  } finally {
    await Promise.allSettled(tracks.map((track) => track.close()));
    await Promise.allSettled(rooms.map((room) => room.disconnect()));
    server.kill();
    const deadline = Date.now() + 2_000;
    while (server.exitCode === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (server.exitCode === null && server.pid !== undefined) {
      spawnSync(taskkillExe, ['/PID', String(server.pid), '/F'], { windowsHide: true });
    }
  }
});

test('T15 private binding and absence wrappers are exact and secret-closed', async () => {
  const adapterModule = await import('../src/device-session-adapter.ts');
  assert.equal(Object.hasOwn(adapterModule, 'captureSupervisedRtcLiveMapSnapshot'), false);
  assert.equal(Object.hasOwn(adapterModule, 'createSupervisedAbsenceProofDocuments'), false);
  const precontact = createT15Harness();
  await precontact.adapter.prearmSupervisedSession();
  await precontact.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  const postcontactDocuments = await t15ContactProofDocuments('PA_iphone001');
  const alternateParticipantDocuments = await t15ContactProofDocuments('PA_iphone002');
  for (const documents of [precontact.proofs[0]!, postcontactDocuments]) {
    for (const [kind, bytes, digest] of [
      ['participant', documents.participantBytes, documents.participantSha256],
      ['publication', documents.publicationBytes, documents.publicationSha256],
    ] as const) {
      const text = Buffer.from(bytes).toString('utf8');
      assert.equal(text.includes('\r'), false);
      assert.equal(text.includes('\u0000'), false);
      assert.equal(text.normalize('NFC'), text);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
      const wrapper = JSON.parse(text);
      const expectedKeys = [
        'activation_attempt_id',
        'device_id',
        'participant_identity',
        'provider',
        'provider_snapshot_bytes',
        'provider_snapshot_bytes_base64',
        'provider_snapshot_sha256',
        'room_name',
        'run_id',
        'schema',
        'session_id',
        ...(kind === 'publication'
          ? ['contact_observed', 'microphone_source', 'publication_sid']
          : []),
      ].sort();
      assert.deepEqual(Object.keys(wrapper).sort(), expectedKeys);
      assert.equal(wrapper.provider, 'livekit-rtc-node');
      const providerBytes = Buffer.from(wrapper.provider_snapshot_bytes_base64, 'base64');
      assert.equal(providerBytes.length, wrapper.provider_snapshot_bytes);
      assert.equal(
        createHash('sha256').update(providerBytes).digest('hex'),
        wrapper.provider_snapshot_sha256,
      );
      const provider = JSON.parse(providerBytes.toString('utf8'));
      assert.deepEqual(provider.rows, []);
      assert.equal(provider.provider, 'livekit-rtc-node');
      assert.equal(provider.schema, `paos.livekit-${kind}-snapshot.v1`);
    }
  }
  assert.equal(precontact.proofs[0]!.participantSid, null);
  assert.equal(precontact.proofs[0]!.publicationSid, null);
  assert.equal(postcontactDocuments.participantSid, 'PA_iphone001');
  assert.equal(postcontactDocuments.publicationSid, 'TR_microphone001');
  assert.notEqual(
    postcontactDocuments.participantSha256,
    alternateParticipantDocuments.participantSha256,
  );
  assert.notEqual(
    postcontactDocuments.publicationSha256,
    alternateParticipantDocuments.publicationSha256,
  );
});

function t15ProofDocuments(
  binding: SupervisedDeviceLanBinding,
  observed = false,
  sid: string | null = null,
  observationEpoch = 0,
  observationGeneration = 1,
): SupervisedAbsenceProofDocuments {
  const participantSid = observed ? 'PA_iphone001' : null;
  const common = {
    run_id: binding.firewallRunId,
    activation_attempt_id: binding.activationAttemptId,
    session_id: binding.sessionId,
    room_name: binding.roomName,
    device_id: binding.deviceId,
    participant_identity: binding.participantIdentity,
    provider: 'livekit-rtc-node',
  };
  const bindParticipantSid = (value: unknown) => {
    const payload =
      `paos-observation-v1|${participantSid ?? '-'}|${observationEpoch}|${observationGeneration}`;
    let prefix = '\n';
    for (const byte of Buffer.from(payload, 'ascii')) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        prefix += (byte & (1 << bit)) === 0 ? ' ' : '\t';
      }
    }
    return Buffer.concat([Buffer.from(`${prefix}\n`), Buffer.from(JSON.stringify(value))]);
  };
  const participantProviderBytes = bindParticipantSid({
    schema: 'paos.livekit-participant-snapshot.v1', ...common, rows: [],
  });
  const publicationProviderBytes = bindParticipantSid({
    schema: 'paos.livekit-publication-snapshot.v1', ...common, rows: [],
    microphone_source: 'microphone', contact_observed: observed, publication_sid: sid,
  });
  const wrap = (kind: 'participant' | 'publication', providerBytes: Buffer) => ({
    schema: `paos.${kind}-absence-proof.v1`,
    ...common,
    provider_snapshot_sha256: createHash('sha256').update(providerBytes).digest('hex'),
    provider_snapshot_bytes: providerBytes.length,
    provider_snapshot_bytes_base64: providerBytes.toString('base64'),
    ...(kind === 'publication'
      ? { microphone_source: 'microphone', contact_observed: observed, publication_sid: sid }
      : {}),
  });
  const participantBytes = Buffer.from(JSON.stringify(wrap('participant', participantProviderBytes)));
  const publicationBytes = Buffer.from(JSON.stringify(wrap('publication', publicationProviderBytes)));
  return {
    participantBytes,
    publicationBytes,
    participantSha256: createHash('sha256').update(participantBytes).digest('hex'),
    publicationSha256: createHash('sha256').update(publicationBytes).digest('hex'),
    contactObserved: observed,
    participantSid,
    publicationSid: sid,
    observationEpoch,
    observationGeneration,
  };
}

function t15ProviderBytes(
  documents: SupervisedAbsenceProofDocuments,
  kind: 'participant' | 'publication',
): Buffer {
  const wrapper = JSON.parse(Buffer.from(
    kind === 'participant' ? documents.participantBytes : documents.publicationBytes,
  ).toString('utf8'));
  return Buffer.from(wrapper.provider_snapshot_bytes_base64, 'base64');
}

function t15ReplaceParticipantProvider(
  documents: SupervisedAbsenceProofDocuments,
  providerBytes: Buffer,
): SupervisedAbsenceProofDocuments {
  const wrapper = JSON.parse(Buffer.from(documents.participantBytes).toString('utf8'));
  wrapper.provider_snapshot_sha256 = createHash('sha256').update(providerBytes).digest('hex');
  wrapper.provider_snapshot_bytes = providerBytes.byteLength;
  wrapper.provider_snapshot_bytes_base64 = providerBytes.toString('base64');
  const participantBytes = Buffer.from(JSON.stringify(wrapper));
  return {
    ...documents,
    participantBytes,
    participantSha256: createHash('sha256').update(participantBytes).digest('hex'),
  };
}

function t15ProviderWithPayload(providerBytes: Buffer, payload: Buffer): Buffer {
  const end = providerBytes.indexOf(10, 1);
  let prefix = '\n';
  for (const byte of payload) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      prefix += (byte & (1 << bit)) === 0 ? ' ' : '\t';
    }
  }
  return Buffer.concat([
    Buffer.from(`${prefix}\n`, 'ascii'),
    providerBytes.subarray(end + 1),
  ]);
}
function t15PipeBootstrap(): {
  readonly bootstrap: GatewayNodePipeBootstrap;
  readonly challengeHex: string;
} {
  const challengeHex = 'ab'.repeat(32);
  const challengeSha256 = createHash('sha256')
    .update(Buffer.from(challengeHex, 'hex')).digest('hex');
  const config = {
    schema: 'paos.gateway-node-pipe-config.v1' as const,
    version: 1 as const,
    grant_id:
      'MG-T15-P0-NO-DEVICE-PRECONTACT-NPCAP-AUTH-CLOSURE-SOURCE-003' as const,
    run_id: T15_FIREWALL_RUN_ID,
    activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
    pipe_name: 'paos-12345678-1234-4234-8234-123456789abc-gateway-node-' +
      '1'.repeat(32),
    broker_pid: 4242,
    broker_creation_time_utc: '2026-07-31T00:00:00.000Z',
    broker_program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    broker_bytes: 512000,
    broker_sha256: '1'.repeat(64),
    broker_token_sid: 'S-1-5-21-1-2-3-500',
    broker_integrity_rid: 12288,
    challenge_sha256: challengeSha256,
    max_wire_bytes: 262144,
    max_payload_bytes: 131072,
    sqos: 'SECURITY_IDENTIFICATION' as const,
  };
  const configBytes = Buffer.from(JSON.stringify(config));
  return {
    challengeHex,
    bootstrap: {
      config,
      configBytes,
      configSha256: createHash('sha256').update(configBytes).digest('hex'),
      configPath: T15_CONTROL_ROOT +
        '\\gateway-broker-private\\gateway-node-pipe-config.json',
      configFd: -1,
      stageRoot: T15_CONTROL_ROOT + '\\gateway-stage',
      manifestSha256: '2'.repeat(64),
    },
  };
}

test('T15 Gateway Node pipe rejects unauthenticated and noncanonical server-first HELLO hostiles', async () => {
  const { bootstrap, challengeHex } = t15PipeBootstrap();
  const base = {
    schema: 'paos.gateway-node-pipe.v1',
    message_type: 'SERVER_HELLO',
    version: 1,
    grant_id: 'MG-T15-P0-NO-DEVICE-PRECONTACT-NPCAP-AUTH-CLOSURE-SOURCE-003',
    run_id: T15_FIREWALL_RUN_ID,
    activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
    broker_pid: bootstrap.config.broker_pid,
    broker_creation_time_utc: bootstrap.config.broker_creation_time_utc,
    broker_token_sid: bootstrap.config.broker_token_sid,
    broker_integrity_rid: bootstrap.config.broker_integrity_rid,
    pipe_instance_id: '3'.repeat(32),
    challenge_hex: challengeHex,
    challenge_sha256: bootstrap.config.challenge_sha256,
    pipe_next_sequence: 1,
    pipe_previous_message_sha256: '0'.repeat(64),
    global_next_sequence: 19,
    global_previous_message_sha256: '4'.repeat(64),
    issued_at_utc: '2026-07-31T00:00:01.000Z',
  };
  const hostiles = [
    Buffer.from(JSON.stringify({ ...base, extra: true })),
    Buffer.from(JSON.stringify({ ...base, broker_pid: 4243 })),
    Buffer.from(JSON.stringify({ ...base, broker_creation_time_utc:
      '2026-07-31T00:00:00.001Z' })),
    Buffer.from(JSON.stringify({ ...base, challenge_hex: 'cd'.repeat(32) })),
    Buffer.from(JSON.stringify({ ...base, pipe_next_sequence: 0 })),
    Buffer.from(JSON.stringify({ ...base, pipe_previous_message_sha256: '5'.repeat(64) })),
    Buffer.from(JSON.stringify(base) + ' '),
  ];
  for (const bytes of hostiles) {
    let writes = 0;
    const transport: GatewayNodePipeTransport = {
      async readMessage() { return bytes; },
      async writeMessage() { writes += 1; },
      close() {},
    };
    const witness = new NoDevicePrecontactWitness();
    witness.recordGatewayInternalPrearmSuccess();
    await assert.rejects(
      runGatewayNodePipeSession({
        transport,
        bootstrap,
        binding: T15_BINDING,
        witness,
        witnessProducer: createGatewayPrecontactWitnessProducer(
          T15_BINDING,
          9191,
          createHash('sha256').update(T15_NONCE).digest('hex'),
        ),
        publications: createGatewayPublicationBuffer(T15_BINDING),
        gatewayPid: 9191,
        clientCreationTimeUtc: '2026-07-31T00:00:00.500Z',
        async stopSession() {},
      }),
      /GATEWAY_PIPE_/,
    );
    assert.equal(writes, 0);
  }
});

test('T15 Gateway publications stay memory-only and cross-bind proof, commit and cleanup bytes', async () => {
  const buffer = createGatewayPublicationBuffer(T15_BINDING);
  const documents = t15ProofDocuments(T15_BINDING, false, null, 0, 1);
  const committer = await buffer.stageAbsenceProofs(documents);
  assert.throws(() => buffer.payload('PARTICIPANT_ABSENCE'),
    /GATEWAY_PUBLICATION_NOT_READY/);
  const committedAt = '2026-07-31T00:00:02.000Z';
  await committer.commit(committedAt);
  const participant = buffer.payload('PARTICIPANT_ABSENCE');
  const publication = buffer.payload('PUBLICATION_ABSENCE');
  const marker = buffer.payload('ABSENCE_COMMIT');
  assert.deepEqual(participant.bytes, Buffer.from(documents.participantBytes));
  assert.deepEqual(publication.bytes, Buffer.from(documents.publicationBytes));
  const markerDocument = JSON.parse(marker.bytes.toString('utf8'));
  assert.equal(markerDocument.participant_bytes, participant.bytes.byteLength);
  assert.equal(markerDocument.participant_sha256, participant.sha256);
  assert.equal(markerDocument.publication_bytes, publication.bytes.byteLength);
  assert.equal(markerDocument.publication_sha256, publication.sha256);
  await buffer.persistCleanupReceipt({
    schema: 'paos.gateway-cleanup-complete.v1',
    run_id: T15_FIREWALL_RUN_ID,
    activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
    session_id: T15_SESSION_ID,
    room_name: T15_SESSION_ID,
    device_id: T15_DEVICE_ID,
    participant_identity: T15_DEVICE_ID,
    provider: 'livekit-rtc-node',
    issuance_denied: true,
    contact_observed: false,
    publication_sid: null,
    participant_absence_evidence_sha256: participant.sha256,
    publication_absence_evidence_sha256: publication.sha256,
    gateway_disconnected: true,
    room_absent: true,
    completed_at_utc: '2026-07-31T00:00:03.000Z',
  });
  const cleanup = buffer.payload('CLEANUP_COMPLETE');
  assert.equal(createHash('sha256').update(cleanup.bytes).digest('hex'), cleanup.sha256);
  assert.equal(cleanup.bytes.toString('utf8').includes('\r'), false);
  assert.equal(cleanup.bytes.toString('utf8').normalize('NFC'), cleanup.bytes.toString('utf8'));
});

test('T15 Gateway witness bytes enforce exact canonical request hash, sequence and STOP fence', () => {
  const witness = new NoDevicePrecontactWitness();
  witness.recordGatewayInternalPrearmSuccess();
  const nonceSha256 = createHash('sha256').update(T15_NONCE).digest('hex');
  const producer = createGatewayPrecontactWitnessProducer(
    T15_BINDING,
    9191,
    nonceSha256,
  );
  const initial = producer.produce('INITIAL', witness.snapshot(), null);
  let previous = initial.sha256;
  for (const [checkpoint, firewall] of [
    ['E03', 'E03-create-caddy.json'],
    ['E05', 'E05-create-livekit-tcp.json'],
    ['E07', 'E07-create-livekit-udp.json'],
    ['E09', 'E09-ready-for-device-contact.json'],
    ['STOP', 'E09-ready-for-device-contact.json'],
    ['E14', 'E14-end.json'],
  ] as const) {
    if (checkpoint === 'STOP') witness.fenceForStop();
    const sequence = checkpoint === 'E03' ? 1 : checkpoint === 'E05' ? 2 :
      checkpoint === 'E07' ? 3 : checkpoint === 'E09' ? 4 :
      checkpoint === 'STOP' ? 5 : 6;
    const request = Buffer.from(JSON.stringify({
      schema: 'paos.precontact-checkpoint-request.v1',
      run_id: T15_FIREWALL_RUN_ID,
      activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
      session_id: T15_SESSION_ID,
      checkpoint,
      sequence,
      control_nonce_sha256: nonceSha256,
      firewall_leaf_name: firewall,
      firewall_leaf_bytes: 100 + sequence,
      firewall_leaf_sha256: String(sequence).repeat(64),
      previous_gateway_witness_sha256: previous,
      requested_at_utc: new Date(1_800_000_000_000 + sequence).toISOString(),
    }));
    const result = producer.produce(checkpoint, witness.snapshot(), request);
    const value = JSON.parse(result.bytes.toString('utf8'));
    assert.equal(value.request_sha256,
      createHash('sha256').update(request).digest('hex'));
    assert.equal(value.previous_witness_sha256, previous);
    assert.equal(value.stop_fenced, checkpoint === 'STOP' || checkpoint === 'E14');
    previous = result.sha256;
  }
  assert.throws(
    () => producer.produce('E14', witness.snapshot(), Buffer.from('{}')),
    /PRECONTACT_WITNESS_NOT_ZERO/,
  );
});

test('T15 Gateway pipe source freezes exact schemas, 11 publications and ACK-gated advance', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
  const frozenKeys = (constant: string): string[] => {
    const match = new RegExp(
      'const ' + constant + " = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);",
    ).exec(source);
    assert.ok(match, constant);
    return [...match[1]!.matchAll(/'([^']+)'/g)].map((item) => item[1]!);
  };
  assert.deepEqual(frozenKeys('GATEWAY_REQUEST_KEYS'), [
    'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
    'pipe_instance_id','challenge_sha256','turn_challenge_hex','turn_challenge_sha256',
    'pipe_sequence','pipe_previous_message_sha256','checkpoint','outer_turn_bytes',
    'outer_turn_sha256','outer_turn_base64','request_leaf_name','request_bytes',
    'request_sha256','request_base64','sent_at_utc',
  ]);
  assert.deepEqual(frozenKeys('GATEWAY_RESPONSE_KEYS'), [
    'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
    'pipe_instance_id','challenge_sha256','request_sha256','turn_challenge_sha256',
    'pipe_sequence','pipe_previous_message_sha256','checkpoint','payload_bytes',
    'payload_sha256','payload_base64','sent_at_utc',
  ]);
  assert.deepEqual(frozenKeys('RESPONSE_ACK_KEYS'), [
    'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
    'pipe_instance_id','challenge_sha256','request_sha256','turn_challenge_sha256',
    'pipe_sequence','pipe_message_sha256','checkpoint','payload_bytes','payload_sha256',
    'outer_turn_sha256','outer_global_sequence','outer_global_message_sha256',
    'outer_commit_ack_sha256','committed','committed_at_utc',
  ]);
  for (const message of [
    'SERVER_HELLO', 'CLIENT_HELLO', 'HELLO_ACK', 'GATEWAY_REQUEST',
    'GATEWAY_RESPONSE', 'RESPONSE_ACK', 'FIN', 'FIN_ACK',
  ]) assert.ok(source.includes(message), message);
  for (const checkpoint of [
    'INITIAL', 'E03', 'E05', 'E07', 'E09', 'STOP', 'PARTICIPANT_ABSENCE',
    'PUBLICATION_ABSENCE', 'ABSENCE_COMMIT', 'CLEANUP_COMPLETE', 'E14',
  ]) assert.ok(source.includes(checkpoint), checkpoint);
  assert.ok(source.includes('publication_count: 11'));
  assert.ok(source.includes('final_pipe_sequence: 11'));
  assert.ok(source.indexOf('canonicalUtc(ack.committed_at_utc') <
    source.indexOf('previousResponseSha256 = responseSha'));
  assert.equal(source.includes('createServer({ path:'), false);
  assert.ok(source.includes('createConnection({'));
  assert.ok(source.includes('seenChallenges.has'));
  assert.ok(source.includes('seenOuterPrevious.has'));
});

test('T15 Gateway Node pipe carries the committed outer global head across contiguous publications', async () => {
  const { bootstrap, challengeHex } = t15PipeBootstrap();
  const pipeInstanceId = '3'.repeat(32);
  const schedule = [
    ['INITIAL', 'gateway-precontact-INITIAL.json'],
    ['E03', 'gateway-precontact-E03.json'],
    ['E05', 'gateway-precontact-E05.json'],
    ['E07', 'gateway-precontact-E07.json'],
    ['E09', 'gateway-precontact-E09.json'],
    ['STOP', 'gateway-precontact-STOP.json'],
    ['PARTICIPANT_ABSENCE', 'participant-absence.json'],
    ['PUBLICATION_ABSENCE', 'publication-absence.json'],
    ['ABSENCE_COMMIT', 'absence-commit.json'],
    ['CLEANUP_COMPLETE', 'gateway-cleanup-complete.json'],
    ['E14', 'gateway-precontact-E14.json'],
  ] as const;
  const firewallLeaf = {
    E03: 'E03-create-caddy.json',
    E05: 'E05-create-livekit-tcp.json',
    E07: 'E07-create-livekit-udp.json',
    E09: 'E09-ready-for-device-contact.json',
    STOP: 'E09-ready-for-device-contact.json',
    E14: 'E14-end.json',
  } as const;
  const semanticSequence = {
    E03: 1, E05: 2, E07: 3, E09: 4, STOP: 5, E14: 6,
  } as const;
  const queue: Buffer[] = [];
  let index = 0;
  let previousResponseSha256 = '0'.repeat(64);
  let previousGlobalMessageSha256 = '4'.repeat(64);
  let previousWitnessSha256: string | null = null;
  let activeOuterTurnSha256 = '';
  let activeOuterGlobalSequence = 0;
  let closed = false;
  const now = () => new Date().toISOString();
  const encode = (value: object) => Buffer.from(JSON.stringify(value));
  const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

  const requestFor = (position: number): Buffer => {
    const [checkpoint, leafName] = schedule[position]!;
    const globalSequence = 19 + position;
    const turnChallengeHex = (position + 1).toString(16).padStart(2, '0').repeat(32);
    const outerTurn = encode({
      schema: 'paos.gateway-durable-pipe.v1',
      message_type: 'SERVER_TURN',
      version: 1,
      grant_id: bootstrap.config.grant_id,
      run_id: T15_FIREWALL_RUN_ID,
      activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
      client_role: 'GATEWAY_BROKER_PRODUCER',
      pipe_instance_id: pipeInstanceId,
      challenge_sha256: bootstrap.config.challenge_sha256,
      turn_challenge_hex: turnChallengeHex,
      turn_challenge_sha256: digest(Buffer.from(turnChallengeHex, 'hex')),
      pipe_sequence: position + 1,
      pipe_previous_message_sha256: previousGlobalMessageSha256,
      global_sequence: globalSequence,
      global_previous_message_sha256: previousGlobalMessageSha256,
      publication_class: 'EVIDENCE',
      leaf_name: leafName,
      issued_at_utc: now(),
    });
    activeOuterTurnSha256 = digest(outerTurn);
    activeOuterGlobalSequence = globalSequence;
    const semantic = checkpoint in semanticSequence;
    let requestBytes: Buffer | null = null;
    if (semantic) {
      assert.ok(previousWitnessSha256);
      const sequence = semanticSequence[checkpoint as keyof typeof semanticSequence];
      requestBytes = encode({
        schema: 'paos.precontact-checkpoint-request.v1',
        run_id: T15_FIREWALL_RUN_ID,
        activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
        session_id: T15_SESSION_ID,
        checkpoint,
        sequence,
        control_nonce_sha256: createHash('sha256').update(T15_NONCE).digest('hex'),
        firewall_leaf_name: firewallLeaf[checkpoint as keyof typeof firewallLeaf],
        firewall_leaf_bytes: 100 + sequence,
        firewall_leaf_sha256: String(sequence).repeat(64),
        previous_gateway_witness_sha256: previousWitnessSha256,
        requested_at_utc: now(),
      });
    }
    return encode({
      schema: 'paos.gateway-node-pipe.v1',
      message_type: 'GATEWAY_REQUEST',
      version: 1,
      grant_id: bootstrap.config.grant_id,
      run_id: T15_FIREWALL_RUN_ID,
      activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
      client_role: 'GATEWAY_NODE_PRODUCER',
      pipe_instance_id: pipeInstanceId,
      challenge_sha256: bootstrap.config.challenge_sha256,
      turn_challenge_hex: turnChallengeHex,
      turn_challenge_sha256: digest(Buffer.from(turnChallengeHex, 'hex')),
      pipe_sequence: position + 1,
      pipe_previous_message_sha256: previousResponseSha256,
      checkpoint,
      outer_turn_bytes: outerTurn.byteLength,
      outer_turn_sha256: activeOuterTurnSha256,
      outer_turn_base64: outerTurn.toString('base64'),
      request_leaf_name: requestBytes === null ? null : `precontact-request-${checkpoint}.json`,
      request_bytes: requestBytes?.byteLength ?? 0,
      request_sha256: requestBytes === null ? null : digest(requestBytes),
      request_base64: requestBytes?.toString('base64') ?? null,
      sent_at_utc: now(),
    });
  };

  queue.push(encode({
    schema: 'paos.gateway-node-pipe.v1',
    message_type: 'SERVER_HELLO',
    version: 1,
    grant_id: bootstrap.config.grant_id,
    run_id: T15_FIREWALL_RUN_ID,
    activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
    broker_pid: bootstrap.config.broker_pid,
    broker_creation_time_utc: bootstrap.config.broker_creation_time_utc,
    broker_token_sid: bootstrap.config.broker_token_sid,
    broker_integrity_rid: bootstrap.config.broker_integrity_rid,
    pipe_instance_id: pipeInstanceId,
    challenge_hex: challengeHex,
    challenge_sha256: bootstrap.config.challenge_sha256,
    pipe_next_sequence: 1,
    pipe_previous_message_sha256: '0'.repeat(64),
    global_next_sequence: 19,
    global_previous_message_sha256: previousGlobalMessageSha256,
    issued_at_utc: now(),
  }));

  const transport: GatewayNodePipeTransport = {
    async readMessage() {
      const message = queue.shift();
      if (!message) throw new Error('TEST_PIPE_QUEUE_EMPTY');
      return message;
    },
    async writeMessage(bytes) {
      const message = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (message.message_type === 'CLIENT_HELLO') {
        queue.push(encode({
          schema: 'paos.gateway-node-pipe.v1',
          message_type: 'HELLO_ACK',
          version: 1,
          grant_id: bootstrap.config.grant_id,
          run_id: T15_FIREWALL_RUN_ID,
          activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
          client_role: 'GATEWAY_NODE_PRODUCER',
          pipe_instance_id: pipeInstanceId,
          challenge_sha256: bootstrap.config.challenge_sha256,
          client_hello_sha256: digest(bytes),
          pipe_next_sequence: 1,
          pipe_previous_message_sha256: '0'.repeat(64),
          global_next_sequence: 19,
          global_previous_message_sha256: previousGlobalMessageSha256,
          accepted: true,
          accepted_at_utc: now(),
        }));
        queue.push(requestFor(0));
        return;
      }
      if (message.message_type === 'GATEWAY_RESPONSE') {
        const [checkpoint] = schedule[index]!;
        const responseSha256 = digest(bytes);
        if (checkpoint === 'INITIAL' || checkpoint in semanticSequence)
          previousWitnessSha256 = message.payload_sha256 as string;
        const committedGlobalHead = digest(`outer-publish-${checkpoint}`);
        queue.push(encode({
          schema: 'paos.gateway-node-pipe.v1',
          message_type: 'RESPONSE_ACK',
          version: 1,
          grant_id: bootstrap.config.grant_id,
          run_id: T15_FIREWALL_RUN_ID,
          activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
          client_role: 'GATEWAY_NODE_PRODUCER',
          pipe_instance_id: pipeInstanceId,
          challenge_sha256: bootstrap.config.challenge_sha256,
          request_sha256: message.request_sha256,
          turn_challenge_sha256: message.turn_challenge_sha256,
          pipe_sequence: message.pipe_sequence,
          pipe_message_sha256: responseSha256,
          checkpoint,
          payload_bytes: message.payload_bytes,
          payload_sha256: message.payload_sha256,
          outer_turn_sha256: activeOuterTurnSha256,
          outer_global_sequence: activeOuterGlobalSequence,
          outer_global_message_sha256: committedGlobalHead,
          outer_commit_ack_sha256: digest(`outer-commit-${checkpoint}`),
          committed: true,
          committed_at_utc: now(),
        }));
        previousResponseSha256 = responseSha256;
        previousGlobalMessageSha256 = committedGlobalHead;
        index += 1;
        if (index < schedule.length) queue.push(requestFor(index));
        return;
      }
      if (message.message_type === 'FIN') {
        assert.equal(message.publication_count, 11);
        assert.equal(message.final_pipe_sequence, 11);
        assert.equal(message.final_global_sequence, 29);
        assert.equal(message.final_global_message_sha256, previousGlobalMessageSha256);
        queue.push(encode({
          ...message, message_type: 'FIN_ACK', accepted: true, accepted_at_utc: now(),
        }));
        return;
      }
      throw new Error('TEST_PIPE_UNEXPECTED_WRITE');
    },
    close() { closed = true; },
  };
  const publications = createGatewayPublicationBuffer(T15_BINDING);
  const documents = t15ProofDocuments(T15_BINDING, false, null, 0, 1);
  const committer = await publications.stageAbsenceProofs(documents);
  await committer.commit(now());
  const participant = publications.payload('PARTICIPANT_ABSENCE');
  const publication = publications.payload('PUBLICATION_ABSENCE');
  await publications.persistCleanupReceipt({
    schema: 'paos.gateway-cleanup-complete.v1',
    run_id: T15_FIREWALL_RUN_ID,
    activation_attempt_id: T15_ACTIVATION_ATTEMPT_ID,
    session_id: T15_SESSION_ID,
    room_name: T15_SESSION_ID,
    device_id: T15_DEVICE_ID,
    participant_identity: T15_DEVICE_ID,
    provider: 'livekit-rtc-node',
    issuance_denied: true,
    contact_observed: false,
    publication_sid: null,
    participant_absence_evidence_sha256: participant.sha256,
    publication_absence_evidence_sha256: publication.sha256,
    gateway_disconnected: true,
    room_absent: true,
    completed_at_utc: now(),
  });
  const witness = new NoDevicePrecontactWitness();
  witness.recordGatewayInternalPrearmSuccess();
  await runGatewayNodePipeSession({
    transport,
    bootstrap,
    binding: T15_BINDING,
    witness,
    witnessProducer: createGatewayPrecontactWitnessProducer(
      T15_BINDING, 9191, createHash('sha256').update(T15_NONCE).digest('hex'),
    ),
    publications,
    gatewayPid: 9191,
    clientCreationTimeUtc: '2026-07-31T00:00:00.500Z',
    async stopSession() {},
  });
  assert.equal(index, schedule.length);
  assert.equal(queue.length, 0);
  assert.equal(closed, true);
});

test('T15 dual-plane pure checks reject proxy, getter, duplicate, foreign and mutable residue', () => {
  const validRooms = [{ name: T15_SESSION_ID }];
  const validParticipants = [{ identity: 'windows_gateway_01', tracks: [] }];
  assert.deepEqual(
    assertSupervisedRoomServiceSnapshot(validRooms, validParticipants, T15_SESSION_ID),
    {
      room_name: T15_SESSION_ID,
      participant_identity: 'windows_gateway_01',
      track_count: 0,
    },
  );
  class OfficialRoomShape {
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
  }
  class OfficialParticipantInfoShape {
    readonly identity: string;
    readonly tracks: readonly unknown[];
    constructor(identity: string, tracks: readonly unknown[]) {
      this.identity = identity;
      this.tracks = tracks;
    }
  }
  const sdkRooms = [new OfficialRoomShape(T15_SESSION_ID)];
  const sdkParticipants = [new OfficialParticipantInfoShape('windows_gateway_01', [])];
  assert.deepEqual(
    assertSupervisedRoomServiceSnapshot(sdkRooms, sdkParticipants, T15_SESSION_ID),
    {
      room_name: T15_SESSION_ID,
      participant_identity: 'windows_gateway_01',
      track_count: 0,
    },
  );
  const getterRoom = {};
  Object.defineProperty(getterRoom, 'name', { get: () => T15_SESSION_ID, enumerable: true });
  for (const [rooms, participants] of [
    [new Proxy(validRooms, {}), validParticipants],
    [[getterRoom], validParticipants],
    [validRooms, new Proxy(validParticipants, {})],
    [validRooms, [...validParticipants, { identity: T15_DEVICE_ID, tracks: [] }]],
    [validRooms, [{ identity: 'foreign', tracks: [] }]],
    [validRooms, [{ identity: 'windows_gateway_01', tracks: [{}] }]],
    [[new OfficialRoomShape('foreign')], sdkParticipants],
    [sdkRooms, [new OfficialParticipantInfoShape('foreign', [])]],
    [sdkRooms, [new OfficialParticipantInfoShape('windows_gateway_01', [{}])]],
    [Object.assign([], { extra: true }), validParticipants],
  ]) {
    assert.throws(
      () => assertSupervisedRoomServiceSnapshot(rooms, participants, T15_SESSION_ID),
      /^Error: SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID$/,
    );
  }
  const empty = new Map();
  assert.doesNotThrow(() => assertEmptyOrdinaryMap(empty, 'RESIDUE'));
  for (const hostile of [
    new Map([['foreign', {}]]),
    new Proxy(new Map(), {}),
    Object.create(Map.prototype),
    new (class extends Map {})(),
    Object.defineProperty(new Map(), 'shadow', { get: () => 1 }),
  ]) {
    assert.throws(() => assertEmptyOrdinaryMap(hostile, 'RESIDUE'), /^Error: RESIDUE$/);
  }
  empty.set('late', {});
  assert.throws(() => assertEmptyOrdinaryMap(empty, 'RESIDUE'), /^Error: RESIDUE$/);
});

test('T15 precontact Stop uses connected rtc state and preserves proof-disconnect-delete order', async () => {
  const harness = createT15Harness();
  const report = await harness.adapter.prearmSupervisedSession();
  assert.deepEqual(harness.adapter.activeSessionIds(), []);
  assert.equal(report.schema, 'paos.gateway-prearm-ready.v1');
  assert.equal(report.room_name, T15_SESSION_ID);
  assert.equal(report.gateway_identity, 'windows_gateway_01');
  assert.equal(harness.room.isConnected, true);
  const callsAtPrearm = harness.participantSnapshotCalls();
  assert.ok(callsAtPrearm >= 2);

  await harness.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  assert.equal(harness.proofs.length, 1);
  assert.equal(harness.proofs[0]!.contactObserved, false);
  assert.equal(harness.proofs[0]!.publicationSid, null);
  assert.equal(harness.cleanupReceipts.length, 1);
  assert.equal(harness.cleanupReceipts[0]!.contact_observed, false);
  assert.equal(harness.cleanupReceipts[0]!.publication_sid, null);
  assert.equal(harness.participantSnapshotCalls(), callsAtPrearm + 4);
  assert.ok(harness.operations.indexOf('evidence.stage') < harness.operations.indexOf('rtc.disconnect'));
  assert.ok(harness.operations.indexOf('rtc.disconnect') < harness.operations.indexOf('evidence.commit'));
  assert.ok(harness.operations.indexOf('evidence.commit') < harness.operations.indexOf('service.delete'));
  assert.ok(harness.operations.indexOf('rtc.disconnect') < harness.operations.indexOf('service.delete'));
  assert.ok(harness.operations.indexOf('service.delete') < harness.operations.indexOf('evidence.cleanup'));
  assert.equal(harness.operations.at(-1), 'evidence.cleanup');
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.adapter.deviceLanIssuanceSnapshot()?.state, 'REVOKED');
});

test('T15 one-shot Start binds preallocated IDs and genuine post-contact absence', async () => {
  const harness = createT15Harness();
  await harness.adapter.prearmSupervisedSession();
  const starts = await Promise.allSettled([
    harness.adapter.createConnectionDetails({}),
    harness.adapter.createConnectionDetails({}),
  ]);
  const winner = starts.find(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof harness.adapter.createConnectionDetails>>> =>
      result.status === 'fulfilled',
  );
  assert.ok(winner);
  assert.equal(starts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(starts.filter((result) => result.status === 'rejected').length, 1);
  assert.deepEqual(Object.keys(winner.value).sort(), [
    'participantName',
    'participantToken',
    'roomName',
    'serverUrl',
  ]);
  assert.equal(winner.value.roomName, T15_SESSION_ID);
  assert.equal(winner.value.participantName, 'user');
  assert.deepEqual(harness.adapter.activeSessionIds(), [T15_SESSION_ID]);

  const participant = t15Participant();
  const publication = t15Publication();
  harness.room.remoteParticipants.set(participant.identity, participant);
  harness.room.emit(RoomEvent.ParticipantConnected, participant);
  await t15Tick();
  participant.trackPublications.set(publication.sid, publication);
  harness.room.emit(RoomEvent.TrackPublished, publication, participant);
  await t15Tick();

  const stop = harness.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  participant.trackPublications.delete(publication.sid);
  harness.room.emit(RoomEvent.TrackUnpublished, publication, participant);
  harness.room.remoteParticipants.delete(participant.identity);
  harness.room.emit(RoomEvent.ParticipantDisconnected, participant);
  await stop;

  assert.equal(harness.proofs.length, 1);
  assert.equal(harness.proofs[0]!.contactObserved, true);
  assert.equal(harness.proofs[0]!.publicationSid, 'TR_microphone001');
  assert.equal(harness.cleanupReceipts[0]!.contact_observed, true);
  assert.equal(harness.cleanupReceipts[0]!.publication_sid, 'TR_microphone001');
  assert.equal(harness.adapter.sessionExists(T15_SESSION_ID), false);
});

test('T15 Packet-002 retries only the permitted phase and cleanup receipt is last', async () => {
  const late = createT15Harness({
    afterStage(room) {
      const participant = t15Participant('PA_lateevent01');
      room.remoteParticipants.set(participant.identity, participant);
      room.emit(RoomEvent.ParticipantConnected, participant);
    },
  });
  await late.adapter.prearmSupervisedSession();
  await assert.rejects(
    late.adapter.stopSession(T15_SESSION_ID, 'user_stop'),
    /SUPERVISED_OBSERVATION_POISONED|SUPERVISED_PROOF_INVALIDATED/,
  );
  assert.equal(late.operations.includes('rtc.disconnect'), false);
  assert.equal(late.operations.includes('evidence.commit'), false);
  assert.equal(late.cleanupReceipts.length, 0);

  const disconnected = createT15Harness({ disconnectFailures: 1 });
  await disconnected.adapter.prearmSupervisedSession();
  await assert.rejects(
    disconnected.adapter.stopSession(T15_SESSION_ID, 'user_stop'),
    /INJECTED_RTC_DISCONNECT_FAILURE/,
  );
  assert.equal(disconnected.operations.includes('evidence.commit'), false);
  assert.equal(disconnected.operations.includes('service.delete'), false);
  await disconnected.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  assert.equal(disconnected.operations.filter((item) => item === 'evidence.stage').length, 2);
  assert.equal(disconnected.cleanupReceipts.length, 1);

  const commitRetry = createT15Harness({ commitFailures: 1 });
  await commitRetry.adapter.prearmSupervisedSession();
  await assert.rejects(
    commitRetry.adapter.stopSession(T15_SESSION_ID, 'user_stop'),
    /INJECTED_ABSENCE_COMMIT_FAILURE/,
  );
  assert.equal(commitRetry.operations.filter((item) => item === 'rtc.disconnect').length, 1);
  assert.equal(commitRetry.operations.includes('service.delete'), false);
  await commitRetry.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  assert.equal(commitRetry.operations.filter((item) => item === 'evidence.stage').length, 1);
  assert.equal(commitRetry.operations.filter((item) => item === 'rtc.disconnect').length, 1);
  assert.equal(commitRetry.operations.filter((item) => item === 'evidence.commit').length, 2);
  assert.equal(commitRetry.operations.at(-1), 'evidence.cleanup');

  const deleteRetry = createT15Harness({ deleteFailures: 1 });
  await deleteRetry.adapter.prearmSupervisedSession();
  await assert.rejects(
    deleteRetry.adapter.stopSession(T15_SESSION_ID, 'user_stop'),
    /INJECTED_ROOM_DELETE_FAILURE/,
  );
  assert.equal(deleteRetry.commits.length, 1);
  assert.equal(deleteRetry.cleanupReceipts.length, 0);
  const snapshotsBeforeRetry = deleteRetry.participantSnapshotCalls();
  await deleteRetry.adapter.stopSession(T15_SESSION_ID, 'user_stop');
  assert.equal(deleteRetry.commits.length, 1);
  assert.equal(deleteRetry.participantSnapshotCalls(), snapshotsBeforeRetry);
  assert.equal(deleteRetry.operations.filter((item) => item === 'rtc.disconnect').length, 1);
  assert.equal(deleteRetry.operations.filter((item) => item === 'service.delete').length, 2);
  assert.equal(deleteRetry.operations.at(-1), 'evidence.cleanup');

  const lateCleanup = createT15Harness({ clearFailures: 1 });
  await lateCleanup.adapter.prearmSupervisedSession();
  await assert.rejects(
    lateCleanup.adapter.stopSession(T15_SESSION_ID, 'user_stop'),
    /INJECTED_DIRECT_CLEAR_FAILURE/,
  );
  assert.equal(lateCleanup.commits.length, 1);
  assert.equal(lateCleanup.cleanupReceipts.length, 0);
  assert.equal(lateCleanup.operations.includes('evidence.cleanup'), false);

  const receiptFailure = createT15Harness({ cleanupFailures: 1 });
  await receiptFailure.adapter.prearmSupervisedSession();
  await assert.rejects(
    receiptFailure.adapter.stopSession(T15_SESSION_ID, 'user_stop'),
    /INJECTED_CLEANUP_RECEIPT_FAILURE/,
  );
  assert.equal(receiptFailure.cleanupReceipts.length, 0);
  assert.equal(receiptFailure.adapter.sessionExists(T15_SESSION_ID), false);
  assert.equal(receiptFailure.operations.at(-1), 'evidence.cleanup');
});

test('T15 contact ledger poisons duplicates, replay, malformed order and non-microphone history', async () => {
  const cases: Array<readonly [string, (h: ReturnType<typeof createT15Harness>) => Promise<void>]> = [
    ['duplicate connect', async (h) => {
      const participant = t15Participant();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      h.room.emit(RoomEvent.ParticipantConnected, participant);
    }],
    ['publish before connect', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication();
      h.room.remoteParticipants.set(participant.identity, participant);
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
    }],
    ['participant under foreign map key', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      h.room.remoteParticipants.delete(participant.identity);
      h.room.remoteParticipants.set('foreign', participant);
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
    }],
    ['duplicate publish', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
      await t15Tick();
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
    }],
    ['wrong source', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication(
        'TR_wrongsource01', TrackKind.KIND_AUDIO, TrackSource.SOURCE_CAMERA,
      );
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
    }],
    ['wrong kind', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication(
        'TR_wrongkind001', TrackKind.KIND_VIDEO, TrackSource.SOURCE_MICROPHONE,
      );
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
    }],
    ['second publication SID', async (h) => {
      const participant = t15Participant();
      const first = t15Publication();
      const second = t15Publication('TR_microphone002');
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      participant.trackPublications.set(first.sid, first);
      h.room.emit(RoomEvent.TrackPublished, first, participant);
      await t15Tick();
      participant.trackPublications.set(second.sid, second);
      h.room.emit(RoomEvent.TrackPublished, second, participant);
    }],
    ['unpublish before publish', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      h.room.emit(RoomEvent.TrackUnpublished, publication, participant);
    }],
    ['participant only', async (h) => {
      const participant = t15Participant();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
    }],
    ['duplicate unpublish', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
      await t15Tick();
      participant.trackPublications.delete(publication.sid);
      h.room.emit(RoomEvent.TrackUnpublished, publication, participant);
      await t15Tick();
      h.room.emit(RoomEvent.TrackUnpublished, publication, participant);
    }],
    ['duplicate disconnect', async (h) => {
      const participant = t15Participant();
      const publication = t15Publication();
      h.room.remoteParticipants.set(participant.identity, participant);
      h.room.emit(RoomEvent.ParticipantConnected, participant);
      await t15Tick();
      participant.trackPublications.set(publication.sid, publication);
      h.room.emit(RoomEvent.TrackPublished, publication, participant);
      await t15Tick();
      participant.trackPublications.delete(publication.sid);
      h.room.emit(RoomEvent.TrackUnpublished, publication, participant);
      await t15Tick();
      h.room.remoteParticipants.delete(participant.identity);
      h.room.emit(RoomEvent.ParticipantDisconnected, participant);
      h.room.emit(RoomEvent.ParticipantDisconnected, participant);
    }],
    ['same SID reconnect', async (h) => {
      const first = t15Participant();
      h.room.remoteParticipants.set(first.identity, first);
      h.room.emit(RoomEvent.ParticipantConnected, first);
      await t15Tick();
      const replay = t15Participant();
      h.room.remoteParticipants.set(replay.identity, replay);
      h.room.emit(RoomEvent.ParticipantConnected, replay);
    }],
  ];
  for (const [name, act] of cases) {
    const harness = createT15Harness();
    await harness.adapter.prearmSupervisedSession();
    await harness.adapter.createConnectionDetails({});
    await act(harness);
    await t15Tick();
    await assert.rejects(
      harness.adapter.stopSession(T15_SESSION_ID, 'error'),
      /SUPERVISED_OBSERVATION_POISONED|SUPERVISED_ABSENCE_FENCE_TIMEOUT|DEVICE_LAN_REQUEST_DENIED/,
      name,
    );
    assert.equal(harness.commits.length, 0, name);
    assert.equal(harness.cleanupReceipts.length, 0, name);
  }
});

test('T15 prearm rejects synthetic disconnect and queued transient precontact contact', async () => {
  const disconnected = createT15Harness();
  disconnected.room.isConnected = false;
  disconnected.room.connectionState = ConnectionState.CONN_DISCONNECTED;
  disconnected.room.onConnect = () => {
    disconnected.room.isConnected = false;
    disconnected.room.connectionState = ConnectionState.CONN_DISCONNECTED;
  };
  await assert.rejects(
    disconnected.adapter.prearmSupervisedSession(),
    /SUPERVISED_RTC_NOT_CONNECTED/,
  );
  assert.equal(disconnected.cleanupReceipts.length, 0);
  assert.equal(disconnected.proofs.length, 0);

  const transient = createT15Harness();
  const participant = {
    identity: T15_DEVICE_ID,
    sid: 'PA_transient001',
    attributes: {
      schema_version: CONTRACT_SCHEMA_VERSION_V0_3,
      device_id: T15_DEVICE_ID,
      device_class: 'web_mobile',
      client_instance_id: T15_CLIENT_ID,
    },
    trackPublications: new Map(),
  } as unknown as RemoteParticipant;
  transient.room.onConnect = () => {
    transient.room.remoteParticipants.set(participant.identity, participant);
    transient.room.emit(RoomEvent.ParticipantConnected, participant);
    transient.room.remoteParticipants.delete(participant.identity);
    transient.room.emit(RoomEvent.ParticipantDisconnected, participant);
  };
  await assert.rejects(
    transient.adapter.prearmSupervisedSession(),
    /SUPERVISED_OBSERVATION_POISONED/,
  );
  assert.equal(transient.cleanupReceipts.length, 0);
  assert.equal(transient.proofs.length, 0);
});

const enabled = process.env.G_A1_EXTERNAL_GATE === '1';
const gatewayUrl = process.env.G_A1_GATEWAY_URL;
const gateSessionId = process.env.G_A1_GATE_SESSION_ID;
const expectedPrompt = process.env.G_A1_EXPECTED_PROMPT;
const expectedModelResult = process.env.G_A1_EXPECTED_MODEL_RESULT;
const externalInputs = {
  G_A1_GATEWAY_URL: gatewayUrl,
  G_A1_GATE_SESSION_ID: gateSessionId,
  G_A1_EXPECTED_PROMPT: expectedPrompt,
  G_A1_EXPECTED_MODEL_RESULT: expectedModelResult,
};
const missingExternalInputs = Object.entries(externalInputs)
  .filter(([, value]) => !value)
  .map(([name]) => name);
const externalConfigurationError =
  enabled && missingExternalInputs.length > 0
    ? `G_A1_EXTERNAL_GATE=1 missing required inputs: ${missingExternalInputs.join(',')}`
    : undefined;
const skipReason = enabled
  ? false
  : 'external loopback services are outside the implementation grant; set G_A1_EXTERNAL_GATE=1 later';

function assertExternalGateConfigured(): void {
  assert.equal(externalConfigurationError, undefined, externalConfigurationError);
}

test(
  'external loopback health is fail-closed and loopback-only',
  { skip: skipReason },
  async () => {
    assertExternalGateConfigured();
    assert.equal(gatewayUrl, 'http://127.0.0.1:8787');
    const response = await fetch(`${gatewayUrl}/healthz`, {
      headers: { Host: '127.0.0.1:8787' },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      activeSessions: string[];
    };
    assert.equal(body.status, 'ok');
    assert.ok(Array.isArray(body.activeSessions));
  },
);

test(
  'connection endpoint rejects a mismatched explicit dispatch',
  { skip: skipReason },
  async () => {
    assertExternalGateConfigured();
    const response = await fetch(`${gatewayUrl}/connection-details`, {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:8787',
        Origin: 'http://127.0.0.1:3000',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room_config: { agents: [{ agent_name: 'wrong-agent' }] },
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'AGENT_DISPATCH_MISMATCH',
    });
  },
);

test(
  'official React preflight has the exact sandbox header allow-list',
  { skip: skipReason },
  async () => {
    assertExternalGateConfigured();
    const response = await fetch(`${gatewayUrl}/connection-details`, {
      method: 'OPTIONS',
      headers: {
        Host: '127.0.0.1:8787',
        Origin: 'http://127.0.0.1:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-sandbox-id',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3000');
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'Content-Type, X-Sandbox-Id',
    );
  },
);

test(
  'public HTTP stop endpoint is absent',
  { skip: skipReason },
  async () => {
    assertExternalGateConfigured();
    const response = await fetch(`${gatewayUrl}/sessions/unknown_session_001/stop`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:8787' },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'ROUTE_NOT_FOUND' });
  },
);

test(
  'non-loopback origin is rejected without credential reflection',
  { skip: skipReason },
  async () => {
    assertExternalGateConfigured();
    const response = await fetch(`${gatewayUrl}/connection-details`, {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:8787',
        Origin: 'http://192.0.2.10:3000',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'ORIGIN_REJECTED' });
  },
);

const promptGateSkip = skipReason;

test(
  'real official-client prompt yields linked model.requested and exact final model.result text',
  { skip: promptGateSkip, timeout: 180_000 },
  async () => {
    assertExternalGateConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 170_000);
    try {
      const response = await fetch(
        `${gatewayUrl}/events?session_id=${encodeURIComponent(gateSessionId!)}`,
        { headers: { Host: '127.0.0.1:8787' }, signal: controller.signal },
      );
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let transcript: any;
      let requested: any;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
          if (!line) continue;
          const item = JSON.parse(line.slice(6));
          if (
            item.eventType === 'paios.phase0.demo.transcript.final' &&
            item.displayText === expectedPrompt
          )
            transcript = item;
          if (item.eventType === 'paios.phase0.demo.model.requested') requested = item;
          if (item.eventType === 'paios.phase0.demo.model.result') {
            assert.ok(transcript, 'exact user prompt transcript must precede model.requested');
            assert.ok(requested, 'model.requested must precede model.result');
            assert.ok(requested.references.includes(transcript.eventId));
            assert.deepEqual(item.references, [requested.eventId]);
            assert.equal(item.displayText, expectedModelResult);
            await reader.cancel();
            return;
          }
        }
      }
      assert.fail('SSE ended before the exact model.result was observed');
    } finally {
      clearTimeout(timeout);
    }
  },
);

const phase0AgentControlBarUrl = new URL(
  '../../../upstream/phase0/LiveKit_Agent_Starter_React/components/agents-ui/agent-control-bar.tsx',
  import.meta.url,
);

async function loadPhase0MicPermissionPrimitives(): Promise<{
  mayStartPhase0MicEnable(pending: boolean, stopped: boolean, consumed: boolean): boolean;
  phase0MicEnableMayCommit(
    operationEpoch: number,
    currentEpoch: number,
    stopped: boolean,
    connected: boolean,
    mounted: boolean,
    roomMatches: boolean,
  ): boolean;
  settlePhase0MicEnable(
    enable: () => Promise<unknown>,
    isCurrent: () => boolean,
    cleanupLateSuccess: () => Promise<void>,
  ): Promise<'accepted' | 'invalidated'>;
}> {
  const source = readFileSync(phase0AgentControlBarUrl, 'utf8');
  const begin = source.indexOf('// BEGIN_PHASE0_MIC_PERMISSION_PRIMITIVES');
  const endMarker = '// END_PHASE0_MIC_PERMISSION_PRIMITIVES';
  const end = source.indexOf(endMarker, begin);
  assert.notEqual(begin, -1);
  assert.notEqual(end, -1);
  const output = transpileModule(source.slice(begin, end + endMarker.length), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('T15 Safari permission may remain pending past eight seconds and settles exactly once', async () => {
  const {
    mayStartPhase0MicEnable,
    phase0MicEnableMayCommit,
    settlePhase0MicEnable,
  } = await loadPhase0MicPermissionPrimitives();
  assert.equal(mayStartPhase0MicEnable(false, false, false), true);
  assert.equal(mayStartPhase0MicEnable(true, false, false), false, 'concurrent double click');
  assert.equal(mayStartPhase0MicEnable(false, true, false), false, 'Stop');
  assert.equal(mayStartPhase0MicEnable(false, false, true), false, 'room already consumed');

  const currentFence = [1, 1, false, true, true, true] as const;
  assert.equal(phase0MicEnableMayCommit(...currentFence), true);
  for (const [name, fence] of [
    ['epoch', [1, 2, false, true, true, true]],
    ['Stop', [1, 1, true, true, true, true]],
    ['disconnect', [1, 1, false, false, true, true]],
    ['unmount', [1, 1, false, true, false, true]],
    ['room change', [1, 1, false, true, true, false]],
  ] as const) {
    assert.equal(
      phase0MicEnableMayCommit(
        fence[0],
        fence[1],
        fence[2],
        fence[3],
        fence[4],
        fence[5],
      ),
      false,
      name,
    );
  }

  let resolveEnable!: () => void;
  let enableCalls = 0;
  let cleanupCalls = 0;
  let settled = false;
  const permission = new Promise<void>((resolve) => {
    resolveEnable = resolve;
  });
  const delayed = settlePhase0MicEnable(
    () => {
      enableCalls += 1;
      return permission;
    },
    () => true,
    async () => {
      cleanupCalls += 1;
    },
  ).finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enableCalls, 1);
  assert.equal(settled, false, 'permission remains pending without the former eight-second fence');
  resolveEnable();
  assert.equal(await delayed, 'accepted');
  assert.equal(enableCalls, 1);
  assert.equal(cleanupCalls, 0, 'valid delayed success is not compensatingly unpublished');
  assert.equal(
    mayStartPhase0MicEnable(false, false, true),
    false,
    'successful room cannot unpublish, re-enable, or replace its publication',
  );

  const originalError = new Error('SAFARI_PERMISSION_REJECTED');
  await assert.rejects(
    settlePhase0MicEnable(
      async () => {
        throw originalError;
      },
      () => true,
      async () => {
        cleanupCalls += 1;
      },
    ),
    (error: unknown) => error === originalError,
  );
  assert.equal(cleanupCalls, 0, 'rejection never claims a publication to clean');
  assert.equal(
    mayStartPhase0MicEnable(false, false, true),
    false,
    'permission rejection consumes the room and cannot be retried',
  );

  for (const reason of ['Stop', 'disconnect', 'unmount', 'room change'] as const) {
    let resolveLate!: () => void;
    let current = true;
    let reasonCleanupCalls = 0;
    const latePermission = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    const late = settlePhase0MicEnable(
      () => latePermission,
      () => current,
      async () => {
        reasonCleanupCalls += 1;
      },
    );
    current = false;
    resolveLate();
    assert.equal(await late, 'invalidated', reason);
    assert.equal(reasonCleanupCalls, 1, reason);
  }

  assert.equal(
    mayStartPhase0MicEnable(false, false, false),
    true,
    'a genuinely new room starts with an unconsumed latch',
  );
});

test('T15 Phase-0 mic consumer has no permission timer, replacement, or media expansion', () => {
  const source = readFileSync(phase0AgentControlBarUrl, 'utf8');
  const phase0Source = source.slice(source.indexOf('function Phase0AgentControlBar'));
  assert.equal(phase0Source.includes('MICROPHONE_ENABLE_TIMEOUT'), false);
  assert.equal(phase0Source.includes('MICROPHONE_ACTION_STOP_TIMEOUT'), false);
  assert.equal(phase0Source.includes('deadlineAt'), false);
  assert.equal(phase0Source.includes('expireDeadline'), false);
  assert.equal(phase0Source.includes('setTimeout('), false);
  assert.equal(phase0Source.includes("'MICROPHONE_UNPUBLISH_TIMEOUT'"), false);
  assert.equal(phase0Source.includes('DISABLE MICROPHONE'), false);
  assert.equal(phase0Source.match(/\.setMicrophoneEnabled\(true\)/g)?.length, 1);
  assert.ok(phase0Source.includes('mayStartPhase0MicEnable('));
  assert.ok(phase0Source.includes('settlePhase0MicEnable('));
  assert.ok(phase0Source.includes('currentRoomRef.current === room'));
  assert.ok(phase0Source.includes('connectedRef.current'));
  assert.ok(phase0Source.includes('mountedRef.current'));
  assert.ok(phase0Source.includes('micEpochRef.current += 1'));
  assert.ok(phase0Source.includes('consumedRoomRef.current = room'));
  assert.ok(
    phase0Source.indexOf('consumedRoomRef.current = room') <
      phase0Source.indexOf('setMicrophoneEnabled(true)'),
    'the room latch must be consumed synchronously before permission begins',
  );
  assert.ok(phase0Source.includes('consumedRoomRef.current = undefined'));
  assert.ok(phase0Source.includes('trackedRoomRef.current !== session.room'));
  assert.equal(phase0Source.match(/consumedRoomRef\.current = undefined/g)?.length, 1);
  assert.ok(phase0Source.includes("cleanPhase0Microphone(room, 'MICROPHONE_STOP_CLEANUP_TIMEOUT')"));
  for (const forbidden of [
    '.setCameraEnabled(',
    '.setScreenShareEnabled(',
    '.publishData(',
    '.publishTrack(',
    '.setSubscribed(',
  ]) {
    assert.equal(phase0Source.includes(forbidden), false, forbidden);
  }
});

}
