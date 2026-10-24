import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_SCHEMA_VERSION_V0_3,
  ContractConsumer,
  loadFrozenArtifacts,
  semanticErrors,
  type ContractProfile,
  type EventEnvelope,
  type JsonObject,
  type LiveKitPublicationObservation,
} from '../src/contract-consumer.ts';

interface Mutation {
  readonly op: 'add' | 'replace' | 'remove';
  readonly path: string;
  readonly value?: unknown;
}

function pointerTokens(path: string): string[] {
  assert.ok(path.startsWith('/'));
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function applyMutations<T>(source: T, mutations: readonly Mutation[]): T {
  const result = structuredClone(source) as any;
  for (const mutation of mutations) {
    const tokens = pointerTokens(mutation.path);
    let parent = result;
    for (const token of tokens.slice(0, -1)) parent = parent[Array.isArray(parent) ? Number(token) : token];
    const leaf = tokens.at(-1)!;
    if (mutation.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
      else delete parent[leaf];
    } else if (Array.isArray(parent)) parent[Number(leaf)] = structuredClone(mutation.value);
    else parent[leaf] = structuredClone(mutation.value);
  }
  return result as T;
}

const artifacts = loadFrozenArtifacts();
const events = artifacts.validFixture.events as EventEnvelope[];
const initialEvent = events[0];
assert.ok(initialEvent, 'frozen valid fixture must contain an initial event');
const byId = new Map(events.map((event) => [event.event_id, event]));

test('frozen valid fixture is accepted without side-effect drift', () => {
  assert.equal(CONTRACT_SCHEMA_VERSION, 'phase0-demo/0.2');
  assert.match(artifacts.root.replaceAll('\\', '/'), /\/contracts\/demo_v0_2\/$/);
  assert.deepEqual(artifacts.hashes, {
    'PHASE0_DEMO_CONTRACT.md': '89750f3b83fbfa165fd0776f65ea21e415608491d4849fd05f22dcda51ce362c',
    'session-event.schema.json': 'f0db8c31a2244535e410c8afeb6f00d156934f3961377363b24999dc22b006cf',
    'rtc-mapping.yaml': 'a1692d11693676c55d58e9c1f0af264ecf7cc1309c7585179b57d6c6159863f0',
    'examples/valid-events.json': 'd307b7d17a4ce0bc93e10c4fed7a5d27478e43a2bb0d43623bf54c4a86cc831f',
    'examples/invalid-events.json': '42e20fd3f537bc6caa49f4d24aa0b1581da123815b8968f17a84c468f2269707',
    'tests/test_contract_compatibility.py': '3700a12a2904b44e95cba3c2e8530d5a29b10df00583eadd05d23733d319b912',
  });
  assert.match(artifacts.mappingText, /gateway_identity: windows_gateway_01/);
  assert.doesNotMatch(artifacts.mappingText, /gateway_identity: windows-gateway/);
  const consumer = new ContractConsumer(artifacts);
  events.forEach((event, index) => {
    const result = consumer.consume(event);
    assert.equal(result.accepted, true, `${event.event_type}: ${result.errors.join(',')}`);
    assert.equal(result.retry, false);
    assert.equal(result.acceptedEffectCount, index + 1);
  });
  assert.deepEqual(semanticErrors(events), []);
});

test('frozen artifacts use one defensive byte snapshot and recursively immutable parsed trees', () => {
  const reads = new Map<string, number>();
  const exposed = new Map<string, Buffer>();
  const hostileArtifacts = loadFrozenArtifacts((path, relativePath) => {
    const count = (reads.get(relativePath) ?? 0) + 1;
    reads.set(relativePath, count);
    if (count !== 1) return Buffer.from('{}');
    const source = readFileSync(path);
    exposed.set(relativePath, source);
    return source;
  });
  for (const count of reads.values()) assert.equal(count, 1);
  for (const source of exposed.values()) source.fill(0x78);
  assert.match(hostileArtifacts.mappingText, /gateway_identity: windows_gateway_01/);
  assert.equal(Object.isFrozen(hostileArtifacts.validFixture), true);
  assert.equal(Object.isFrozen(hostileArtifacts.validFixture.events), true);
  assert.equal(Object.isFrozen(hostileArtifacts.schema.$defs.mediaRef.properties.locator), true);
  assert.throws(() => {
    hostileArtifacts.schema.$defs.mediaRef.properties.locator.pattern = '^hostile$';
  }, TypeError);
  assert.equal(new ContractConsumer(hostileArtifacts).consume(
    structuredClone((hostileArtifacts.validFixture.events as EventEnvelope[])[0]),
  ).accepted, true);
});

test('v0.1, mixed-version batches, and cross-version retries fail closed without reinterpretation', () => {
  assert.throws(
    () => new ContractConsumer({ ...artifacts }),
    /UNVERIFIED_CONTRACT_ARTIFACT_SET/,
  );
  const v01Fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../contracts/demo_v0/examples/valid-events.json', import.meta.url)),
    'utf8',
  )) as JsonObject;
  const v01Initial = (v01Fixture.events as EventEnvelope[])[0];
  assert.ok(v01Initial);
  assert.equal(v01Initial.schema_version, 'phase0-demo/0.1');

  const directV01 = new ContractConsumer(artifacts).consume(v01Initial);
  assert.equal(directV01.accepted, false);
  assert.deepEqual(directV01.errors, ['SCHEMA_INVALID']);
  assert.equal(directV01.acceptedEffectCount, 0);

  const mixedConsumer = new ContractConsumer(artifacts);
  const mixed = mixedConsumer.consumeBatch([structuredClone(initialEvent), structuredClone(v01Initial)]);
  assert.equal(mixed.accepted, false);
  assert.deepEqual(mixed.errors, ['SCHEMA_INVALID']);
  assert.equal(mixed.acceptedEffectCount, 0);
  assert.deepEqual(mixedConsumer.acceptedEvents(), []);

  const retryConsumer = new ContractConsumer(artifacts);
  assert.equal(retryConsumer.consume(initialEvent).accepted, true);
  const crossVersionRetry = structuredClone(initialEvent);
  crossVersionRetry.schema_version = 'phase0-demo/0.1';
  const rejectedRetry = retryConsumer.consume(crossVersionRetry);
  assert.equal(rejectedRetry.accepted, false);
  assert.deepEqual(rejectedRetry.errors, ['SCHEMA_INVALID']);
  assert.equal(rejectedRetry.acceptedEffectCount, 1);
  const exactV02Retry = retryConsumer.consume(structuredClone(initialEvent));
  assert.equal(exactV02Retry.accepted, true);
  assert.equal(exactV02Retry.retry, true);
  assert.equal(exactV02Retry.acceptedEffectCount, 1);

  for (const alias of ['windows-gateway', 'windows_gateway']) {
    const aliasedGateway = structuredClone(initialEvent);
    aliasedGateway.origin.device_id = alias;
    const aliasResult = new ContractConsumer(artifacts).consume(aliasedGateway);
    assert.equal(aliasResult.accepted, false, alias);
    assert.deepEqual(aliasResult.errors, ['GATEWAY_FOREIGN_ORIGIN_RELAY_FORBIDDEN'], alias);
    assert.equal(aliasResult.acceptedEffectCount, 0, alias);
  }
});

test('every frozen schema case is rejected before semantic effects', () => {
  for (const fixtureCase of artifacts.invalidFixture.schema_cases as JsonObject[]) {
    const source = byId.get(fixtureCase.source_event_id);
    assert.ok(source, fixtureCase.name);
    const hostile = applyMutations(source, fixtureCase.mutations as Mutation[]);
    const result = new ContractConsumer(artifacts).consume(hostile);
    assert.equal(result.accepted, false, fixtureCase.name);
    assert.deepEqual(result.errors, [fixtureCase.expected_code], fixtureCase.name);
    assert.equal(result.acceptedEffectCount, 0, fixtureCase.name);
  }
});

test('media locator parent type and transport-specific scheme remain enforced', () => {
  const mediaEvent = events.find((event) => event.payload?.media_ref?.locator);
  assert.ok(mediaEvent, 'frozen fixture must contain a direct media_ref');

  const nonStringLocator = structuredClone(mediaEvent);
  nonStringLocator.payload.media_ref.locator = 7;
  const nonStringResult = new ContractConsumer(artifacts).consume(nonStringLocator);
  assert.equal(nonStringResult.accepted, false);
  assert.deepEqual(nonStringResult.errors, ['SCHEMA_INVALID']);
  assert.ok(nonStringResult.schemaErrors.some((error) => error.keyword === 'type'));

  const wrongScheme = structuredClone(mediaEvent);
  wrongScheme.payload.media_ref.locator = 'ephemeral://object/wrong-for-livekit-track';
  const wrongSchemeResult = new ContractConsumer(artifacts).consume(wrongScheme);
  assert.equal(wrongSchemeResult.accepted, false);
  assert.deepEqual(wrongSchemeResult.errors, ['SCHEMA_INVALID']);
  assert.ok(wrongSchemeResult.schemaErrors.some((error) => error.keyword === 'pattern'));
});

test('ephemeral media still requires its parent-declared byte length and SHA-256', () => {
  const mediaEvent = events.find((event) => event.payload?.media_ref?.locator);
  assert.ok(mediaEvent, 'frozen fixture must contain a direct media_ref');
  const ephemeral = structuredClone(mediaEvent);
  Object.assign(ephemeral.payload.media_ref, {
    transport: 'ephemeral_object',
    locator: 'ephemeral://object/source-repair-proof',
    byte_length: 128,
    sha256: 'a'.repeat(64),
  });
  for (const missingProperty of ['byte_length', 'sha256']) {
    const hostile = structuredClone(ephemeral);
    delete hostile.payload.media_ref[missingProperty];
    const result = new ContractConsumer(artifacts).consume(hostile);
    assert.equal(result.accepted, false, missingProperty);
    assert.deepEqual(result.errors, ['SCHEMA_INVALID'], missingProperty);
    assert.ok(result.schemaErrors.some((error) =>
      error.keyword === 'required' && error.params.missingProperty === missingProperty), missingProperty);
  }
});

test('every executable frozen semantic mutation produces its exact code', () => {
  for (const fixtureCase of artifacts.invalidFixture.semantic_cases as JsonObject[]) {
    const sourceIndex = events.findIndex((event) => event.event_id === fixtureCase.source_event_id);
    assert.notEqual(sourceIndex, -1, fixtureCase.name);
    const source = events[sourceIndex];
    assert.ok(source, fixtureCase.name);
    const timeline = events.slice(0, sourceIndex);
    const hostile = applyMutations(source, fixtureCase.mutations as Mutation[]);
    const detected = semanticErrors([...timeline, hostile]);
    assert.ok(detected.includes(fixtureCase.expected_code), `${fixtureCase.name}: ${detected.join(',')}`);
  }
});

test('frozen semantic pair mutations produce exact conflict/order codes', () => {
  for (const fixtureCase of artifacts.invalidFixture.semantic_pair_cases as JsonObject[]) {
    const sourceIndex = events.findIndex((event) => event.event_id === fixtureCase.source_event_id);
    const first = events[sourceIndex];
    assert.ok(first, fixtureCase.name);
    const second = applyMutations(first, fixtureCase.second_mutations as Mutation[]);
    const detected = semanticErrors([...events.slice(0, sourceIndex), first, second]);
    assert.ok(detected.includes(fixtureCase.expected_code), `${fixtureCase.name}: ${detected.join(',')}`);
  }
});

test('generated transcript/request batch rolls back completely when the request fails', () => {
  const transcriptIndex = events.findIndex(
    (event) => event.event_type === 'paios.phase0.demo.transcript.final',
  );
  const requestIndex = events.findIndex(
    (event) => event.event_type === 'paios.phase0.demo.model.requested',
  );
  assert.ok(transcriptIndex >= 0 && requestIndex > transcriptIndex);
  const consumer = new ContractConsumer(artifacts);
  for (const event of events.slice(0, transcriptIndex)) {
    assert.equal(consumer.consume(event).accepted, true);
  }
  const before = consumer.acceptedEvents();
  const batch = structuredClone(events.slice(transcriptIndex, requestIndex + 1));
  const request = batch.at(-1);
  assert.ok(request);
  request.payload.input_event_ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff'];
  const result = consumer.consumeBatch(batch);
  assert.equal(result.accepted, false);
  assert.ok(result.errors.includes('MODEL_INPUT_EVENT_NOT_FOUND'));
  assert.deepEqual(consumer.acceptedEvents(), before);
  assert.equal(result.acceptedEffectCount, before.length);
});

test('100 exact retries are no-ops with zero additional accepted effects', () => {
  const consumer = new ContractConsumer(artifacts);
  const first = consumer.consume(initialEvent);
  assert.equal(first.acceptedEffectCount, 1);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = consumer.consume(structuredClone(initialEvent));
    assert.equal(result.accepted, true, `retry ${attempt}`);
    assert.equal(result.retry, true, `retry ${attempt}`);
    assert.equal(result.acceptedEffectCount, 1, `retry ${attempt}`);
  }
});

test('100 mutated retries are rejected and never add an effect', () => {
  const consumer = new ContractConsumer(artifacts);
  assert.equal(consumer.consume(initialEvent).accepted, true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hostile = structuredClone(initialEvent);
    hostile.trace_id = `${String(attempt).padStart(8, '0')}-0000-4000-8000-000000000099`;
    const result = consumer.consume(hostile);
    assert.equal(result.accepted, false, `mutation ${attempt}`);
    assert.ok(result.errors.includes('EVENT_ID_CONFLICT'), `mutation ${attempt}`);
    assert.ok(result.errors.includes('IDEMPOTENCY_CONFLICT'), `mutation ${attempt}`);
    assert.equal(result.acceptedEffectCount, 1, `mutation ${attempt}`);
  }
});

test('cleanup terminality is evaluated before old-event retry dedupe', () => {
  const consumer = new ContractConsumer(artifacts);
  for (const event of events) assert.equal(consumer.consume(event).accepted, true);
  const oldRetry = consumer.consume(structuredClone(initialEvent));
  assert.equal(oldRetry.accepted, false);
  assert.ok(oldRetry.errors.includes('EVENT_AFTER_CLEANUP'));
  const cleanupRetry = consumer.consume(structuredClone(events.at(-1)));
  assert.equal(cleanupRetry.accepted, true);
  assert.equal(cleanupRetry.retry, true);
});

test('credential value channels reject raw, encoded, invalid and nested forms', () => {
  const resultIndex = events.findIndex(
    (event) => event.event_type === 'paios.phase0.demo.model.result',
  );
  assert.ok(resultIndex > 0);
  const base = events[resultIndex];
  assert.ok(base, 'frozen valid fixture must contain a model.result event');
  const values = [
    'eyJhbGciOiJIUzI1NiJ9.e30.signature',
    'eyJhbGciOiJIUzI1NiJ9%2Ee30%2Esignature',
    'https://example.invalid/path/X-Amz-Signature/value',
    'https://example.invalid/?X-Amz-%53ignature=value',
    'bad%2',
    'eyJhbGciOiJIUzI1NiJ9%252Ee30%252Esignature',
  ];
  for (const [index, value] of values.entries()) {
    const hostile = structuredClone(base);
    hostile.payload = {
      request_event_id: base.payload.request_event_id,
      result_id: `hostile_result_${index}`,
      status: 'failure',
      provider: 'local',
      model: 'test',
      latency_ms: 1,
      non_authoritative: true,
      error: { code: 'LOCAL_FAILURE', message: value, retryable: false },
    };
    const detected = semanticErrors([...events.slice(0, resultIndex), hostile]);
    assert.ok(detected.includes('CREDENTIAL_VALUE_EMBEDDED'), `${index}: ${detected.join(',')}`);
    if (value.includes('%252E') || value === 'bad%2') {
      assert.ok(detected.includes('CREDENTIAL_VALUE_ENCODING_INVALID'));
    }
  }
});

test('all frozen named hostile codes have an implementation branch', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/contract-consumer.ts', import.meta.url)),
    'utf8',
  ) + readFileSync(
    fileURLToPath(new URL('../src/device-session-adapter.ts', import.meta.url)),
    'utf8',
  );
  const matrices = [
    't14_hostile_regressions',
    't14_revise_regressions',
    't14_credential_final_regressions',
    't01_gateway_identity_regressions',
  ];
  for (const matrixName of matrices) {
    for (const fixtureCase of artifacts.invalidFixture[matrixName] as JsonObject[]) {
      assert.ok(source.includes(`'${fixtureCase.expected_code}'`), `${matrixName}:${fixtureCase.name}`);
    }
  }
});

const v03Artifacts = loadFrozenArtifacts(CONTRACT_SCHEMA_VERSION_V0_3);
const v03Events = v03Artifacts.validFixture.events as EventEnvelope[];
const v03Controls = v03Artifacts.validFixture.transcript_binding_controls as JsonObject;
const v03Observations =
  v03Controls.authoritative_publication_observations as LiveKitPublicationObservation[];
const v03Voice = v03Controls.m0b_voice_events as EventEnvelope[];

function observationForMedia(event: EventEnvelope): Omit<
  LiveKitPublicationObservation,
  'available_after_accepted_event_ordinal'
> {
  const locator = String(event.payload.media_ref.locator);
  const [sessionId, publisher, sid] = locator.slice('livekit://'.length).split('/');
  assert.ok(sessionId && publisher && sid);
  return {
    session_id: sessionId,
    room_name: sessionId,
    rtc_publisher_identity: publisher,
    publication_sid: sid,
  };
}

test('v0.2 and v0.3 immutable profiles each read and hash every artifact exactly once', () => {
  const reads = new Map<string, number>();
  const profiles: readonly ContractProfile[] = [
    CONTRACT_SCHEMA_VERSION,
    CONTRACT_SCHEMA_VERSION_V0_3,
  ];
  const loaded = profiles.map((profile) =>
    loadFrozenArtifacts(profile, (path, relativePath) => {
      const readKey = `${profile}:${relativePath}`;
      reads.set(readKey, (reads.get(readKey) ?? 0) + 1);
      return readFileSync(path);
    }));
  assert.equal(reads.size, 12);
  for (const count of reads.values()) assert.equal(count, 1);
  assert.notEqual(loaded[0]?.schema, loaded[1]?.schema);
  assert.equal(Object.isFrozen(loaded[1]), true);
  assert.equal(Object.isFrozen(loaded[1]?.schema.$defs.transcriptSourceId.oneOf[1]), true);
  assert.equal(Object.isFrozen(loaded[1]?.validFixture.transcript_binding_controls.m0b_voice_events), true);
  assert.deepEqual(v03Artifacts.hashes, {
    'PHASE0_DEMO_CONTRACT.md': '022239aba6fa230ea767718dd52e1d208b8aedb28663f3bce96b290ac78ab72c',
    'session-event.schema.json': '68253cd4c53776d777528ff43da1022815c1327a9b29f30c4aaa30da6f5bc2c8',
    'rtc-mapping.yaml': 'e38414b14489f23b166753c1688da3e70ca918c1c1fce732dce5f6b1be9d7c79',
    'examples/valid-events.json': '5e60ff05db5b2a186d35486fc248bb9d2bfbd5a87435ec53660332e3c9b7749f',
    'examples/invalid-events.json': '2767a8aaafdf2fb7f09410bc772ae972ebd8b9f60cb359082529afd26a42e391',
    'tests/test_contract_compatibility.py': '882f4f65482af79c7aa35cade16f83407b123c1bc402351cace72a109d987fb6',
  });
  for (const profile of profiles) {
    assert.throws(
      () => loadFrozenArtifacts(profile, (path, relativePath) => {
        const snapshot = Buffer.from(readFileSync(path));
        if (relativePath === 'session-event.schema.json') snapshot[0] = snapshot[0]! ^ 0x01;
        return snapshot;
      }),
      /FROZEN_POSTIMAGE_DRIFT/,
    );
  }
});

test('profile selection is explicit, immutable, and never request-controlled or upgraded', () => {
  const legacy = new ContractConsumer();
  const m0b = new ContractConsumer(CONTRACT_SCHEMA_VERSION_V0_3);
  assert.equal(legacy.profile, CONTRACT_SCHEMA_VERSION);
  assert.equal(m0b.profile, CONTRACT_SCHEMA_VERSION_V0_3);
  assert.throws(
    () => new ContractConsumer('phase0-demo/9.9' as ContractProfile),
    /UNSUPPORTED_CONTRACT_PROFILE/,
  );
  assert.throws(() => {
    (m0b as any).profile = CONTRACT_SCHEMA_VERSION;
  }, TypeError);
  assert.equal(m0b.profile, CONTRACT_SCHEMA_VERSION_V0_3);
  assert.throws(
    () => new ContractConsumer({ ...v03Artifacts }),
    /UNVERIFIED_CONTRACT_ARTIFACT_SET/,
  );

  const requestSelected = structuredClone(v03Voice[0]);
  assert.ok(requestSelected);
  requestSelected.contract_profile = CONTRACT_SCHEMA_VERSION;
  assert.deepEqual(m0b.consume(requestSelected).errors, ['SCHEMA_INVALID']);
  assert.deepEqual(legacy.consume(v03Voice[0]).errors, ['SCHEMA_INVALID']);
  assert.deepEqual(new ContractConsumer(CONTRACT_SCHEMA_VERSION_V0_3).consume(initialEvent).errors, [
    'SCHEMA_INVALID',
  ]);
  assert.equal(m0b.acceptedEvents().length, 0);
});

test('v0.2 and v0.3 state, retries, references, and cleanup remain isolated', () => {
  const legacy = new ContractConsumer(artifacts);
  const m0b = new ContractConsumer(v03Artifacts);
  assert.equal(legacy.consume(initialEvent).accepted, true);
  assert.equal(m0b.consume(v03Voice[0]).accepted, true);
  assert.equal(legacy.consume(structuredClone(initialEvent)).retry, true);
  assert.equal(m0b.consume(structuredClone(v03Voice[0])).retry, true);
  assert.equal(legacy.acceptedEvents().length, 1);
  assert.equal(m0b.acceptedEvents().length, 1);
  m0b.clearTemporaryState();
  assert.equal(m0b.acceptedEvents().length, 0);
  assert.equal(legacy.acceptedEvents().length, 1);

  const crossSession = structuredClone(v03Voice);
  crossSession[3]!.session_id = 'phase0_other_session_001';
  const crossErrors = semanticErrors(crossSession, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: v03Observations,
  });
  assert.ok(crossErrors.includes('TRANSCRIPT_SOURCE_SESSION_MISMATCH'));

  const mixed = structuredClone(v03Voice);
  mixed[2]!.schema_version = CONTRACT_SCHEMA_VERSION;
  const mixedErrors = semanticErrors(mixed, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: v03Observations,
  });
  assert.ok(mixedErrors.includes('SESSION_SCHEMA_VERSION_MIXED'));
  assert.ok(mixedErrors.includes('SCHEMA_VERSION_UNSUPPORTED'));
});

test('accepted v0.3 fixture and M0B publication observation order are enforced exactly', () => {
  assert.equal(CONTRACT_SCHEMA_VERSION_V0_3, 'phase0-demo/0.3');
  assert.match(v03Artifacts.root.replaceAll('\\', '/'), /\/contracts\/demo_v0_3\/$/);
  assert.deepEqual(semanticErrors(v03Events, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: v03Observations,
  }), []);

  const consumer = new ContractConsumer(CONTRACT_SCHEMA_VERSION_V0_3);
  assert.equal(consumer.consume(v03Voice[0]).accepted, true);
  assert.equal(consumer.consume(v03Voice[1]).accepted, true);
  const observation = observationForMedia(v03Voice[2]!);
  consumer.recordPublicationObservation(observation);
  assert.throws(
    () => consumer.recordPublicationObservation(observation),
    /PUBLICATION_OBSERVATION_DUPLICATE/,
  );
  assert.equal(consumer.consume(v03Voice[2]).accepted, true);
  assert.equal(consumer.consume(v03Voice[3]).accepted, true);
  assert.equal(consumer.acceptedEvents().length, 4);

  const lowercaseClaim = structuredClone(v03Voice);
  lowercaseClaim[3]!.payload.source_media_id = 'typed_voice_claim_001';
  const lowercaseConsumer = new ContractConsumer(CONTRACT_SCHEMA_VERSION_V0_3);
  assert.equal(lowercaseConsumer.consume(lowercaseClaim[0]).accepted, true);
  assert.equal(lowercaseConsumer.consume(lowercaseClaim[1]).accepted, true);
  lowercaseConsumer.recordPublicationObservation(observationForMedia(lowercaseClaim[2]!));
  assert.equal(lowercaseConsumer.consume(lowercaseClaim[2]).accepted, true);
  const rejected = lowercaseConsumer.consumeMicrophoneTranscript(lowercaseClaim[3]);
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.errors.includes('TRANSCRIPT_SOURCE_KIND_MISREPRESENTED'));
});

test('v0.3 rejects SID fallback, invalid observations, ambiguity, and non-prior evidence', () => {
  const invalidObservationConsumer = new ContractConsumer(CONTRACT_SCHEMA_VERSION_V0_3);
  const observation = observationForMedia(v03Voice[2]!);
  assert.throws(
    () => invalidObservationConsumer.recordPublicationObservation({
      ...observation,
      room_name: 'wrong_room_001',
    }),
    /PUBLICATION_OBSERVATION_INVALID/,
  );
  assert.throws(
    () => invalidObservationConsumer.recordPublicationObservation({
      ...observation,
      publication_sid: 'publication_name_fallback',
    }),
    /PUBLICATION_OBSERVATION_INVALID/,
  );

  const nameFallback = structuredClone(v03Voice);
  nameFallback[2]!.payload.media_ref.locator =
    'livekit://phase0_m0b_session_001/pwa_iphone_01/publication_name_fallback';
  const fallbackErrors = semanticErrors(nameFallback, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: v03Observations,
  });
  assert.ok(fallbackErrors.includes('LIVEKIT_LOCATOR_INVALID'));

  const notPrior = structuredClone(v03Voice);
  [notPrior[2], notPrior[3]] = [notPrior[3]!, notPrior[2]!];
  const orderErrors = semanticErrors(notPrior, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: v03Observations,
  });
  assert.ok(orderErrors.includes('TRANSCRIPT_SOURCE_MEDIA_NOT_PRIOR'));

  const lateObservations = v03Observations.map((item) =>
    item.publication_sid === 'TR_pwaAudio001'
      ? { ...item, available_after_accepted_event_ordinal: 4 }
      : { ...item },
  );
  const lateObservationErrors = semanticErrors(v03Voice, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: lateObservations,
  });
  assert.ok(lateObservationErrors.includes('LIVEKIT_PUBLICATION_NOT_OBSERVED'));

  const ambiguous = structuredClone(v03Voice);
  const duplicate = structuredClone(ambiguous[2]);
  assert.ok(duplicate);
  duplicate.event_id = '50000000-0000-4000-8000-000000000005';
  duplicate.idempotency_key = 'm0b-media-referenced-duplicate-001';
  ambiguous.splice(3, 0, duplicate);
  const ambiguousErrors = semanticErrors(ambiguous, {
    profile: CONTRACT_SCHEMA_VERSION_V0_3,
    publicationObservations: v03Observations,
  });
  assert.ok(ambiguousErrors.includes('TRANSCRIPT_SOURCE_MEDIA_AMBIGUOUS'));
});

test('rejected v0.3 transcript cannot be ratified by later media or observation', () => {
  const consumer = new ContractConsumer(CONTRACT_SCHEMA_VERSION_V0_3);
  assert.equal(consumer.consume(v03Voice[0]).accepted, true);
  assert.equal(consumer.consume(v03Voice[1]).accepted, true);
  const earlyTranscript = consumer.consume(v03Voice[3]);
  assert.equal(earlyTranscript.accepted, false);
  assert.ok(earlyTranscript.errors.includes('TRANSCRIPT_SOURCE_MEDIA_NOT_FOUND'));
  consumer.recordPublicationObservation(observationForMedia(v03Voice[2]!));
  assert.equal(consumer.consume(v03Voice[2]).accepted, true);
  const ratification = consumer.consume(structuredClone(v03Voice[3]));
  assert.equal(ratification.accepted, false);
  assert.deepEqual(ratification.errors, ['LATE_EVIDENCE_RATIFICATION_FORBIDDEN']);
  assert.equal(ratification.acceptedEffectCount, 3);
});
