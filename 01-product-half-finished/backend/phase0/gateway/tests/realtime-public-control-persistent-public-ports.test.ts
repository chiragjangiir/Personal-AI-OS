import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { join } from 'node:path';
import type { LiveKitCloudRoomPort } from '../src/livekit-cloud-participant.ts';
import type { RealtimeOperation } from '../src/realtime-public-control-runtime.ts';
import {
  PERSISTENT_PUBLIC_SECRET_PATHS,
  PERSISTENT_PUBLIC_SECRET_REFERENCES,
  PersistentRealtimePublicControlPortsError,
  createPersistentPublicSecretFileReader,
  createPersistentPublicSecretResolver,
  createPersistentRealtimePublicControlPorts,
  type PersistentPublicBearerAuthorityPort,
  type PersistentPublicBearerAuthoritySnapshot,
  type PersistentPublicOwnerProtectionPort,
  type PersistentPublicSecretFileReader,
} from '../src/realtime-public-control-persistent-public-ports.ts';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const EXPIRES = '2030-01-01T01:00:00.000Z';
const CONTROL_TOKEN = 'opaque-control-capability-123456';
const ATTESTATION = 'A'.repeat(43);
const LIVEKIT_KEY = 'K'.repeat(43);
const LIVEKIT_SECRET = 'S'.repeat(64);
const E2EE_ROOT_KEY = Buffer.alloc(32, 7).toString('base64url');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secretHarness(options: {
  protected?: boolean;
  reparsePath?: string;
  overrides?: Readonly<Record<string, string>>;
} = {}): {
  reader: PersistentPublicSecretFileReader;
  protection: PersistentPublicOwnerProtectionPort;
  reads: string[];
} {
  const values = new Map<string, string>([
    [PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiKey, LIVEKIT_KEY],
    [PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiSecret, LIVEKIT_SECRET],
    [PERSISTENT_PUBLIC_SECRET_PATHS.proxyAttestation, ATTESTATION],
    [PERSISTENT_PUBLIC_SECRET_PATHS.e2eeRootKey, E2EE_ROOT_KEY],
  ]);
  for (const [path, value] of Object.entries(options.overrides ?? {})) values.set(path, value);
  const reads: string[] = [];
  return {
    reads,
    protection: {
      isOwnerProtected: (path) => options.protected !== false && values.has(path),
    },
    reader: {
      inspect(path) {
        if (!values.has(path)) throw new Error('FILE_MISSING');
        return { regular: true, reparse: options.reparsePath === path };
      },
      read(path) {
        reads.push(path);
        const value = values.get(path);
        if (value === undefined) throw new Error('FILE_MISSING');
        return Buffer.from(value, 'utf8');
      },
    },
  };
}

function snapshot(
  token = CONTROL_TOKEN,
  overrides: Partial<PersistentPublicBearerAuthoritySnapshot> = {},
): PersistentPublicBearerAuthoritySnapshot {
  return Object.freeze({
    tokenSha256: sha256(token),
    principal: Object.freeze({ ref_type: 'User', ref_id: 'owner-opaque' }),
    deviceId: 'iphone-cycling-owner',
    capabilityRef: Object.freeze({ ref_type: 'CapabilityGrant', ref_id: 'grant-opaque' }),
    expiresAt: EXPIRES,
    scopes: Object.freeze(['bootstrap', 'media_stop'] as RealtimeOperation[]),
    ...overrides,
  });
}

function authority(options: {
  ready?: boolean;
  value?: PersistentPublicBearerAuthoritySnapshot;
  unavailable?: boolean;
} = {}): PersistentPublicBearerAuthorityPort & { readonly closeCount: () => number } {
  let closes = 0;
  const port = {
    isReady: () => options.ready !== false,
    async resolve(): Promise<PersistentPublicBearerAuthoritySnapshot | undefined> {
      if (options.unavailable) throw new Error('OWNER_DETAIL_MUST_NOT_ESCAPE');
      return options.value ?? snapshot();
    },
    close: () => { closes += 1; },
    closeCount: () => closes,
  };
  return port;
}

function roomHarness(): { room: LiveKitCloudRoomPort; connects: unknown[][]; disconnects: () => number } {
  const connects: unknown[][] = [];
  let disconnected = 0;
  return {
    connects,
    disconnects: () => disconnected,
    room: {
      async connect(...input) { connects.push(input); },
      async disconnect() { disconnected += 1; },
      on() {},
      removeAllListeners() {},
    },
  };
}

function createFixture(options: {
  publicApiUrl?: string;
  legacyPublicApiUrls?: string;
  livekitApiUrl?: string;
  bearerAuthority?: PersistentPublicBearerAuthorityPort;
  secrets?: ReturnType<typeof secretHarness>;
  now?: () => number;
} = {}) {
  const secrets = options.secrets ?? secretHarness();
  const room = roomHarness();
  const bearerAuthority = options.bearerAuthority ?? authority();
  const ports = createPersistentRealtimePublicControlPorts({
    publicApiUrl:'https://ai.example.invalid', livekitUrl:'wss://ai.example.invalid',
    ...(options.livekitApiUrl ? {livekitApiUrl: options.livekitApiUrl} : {}),
    ...(options.publicApiUrl ? {publicApiUrl: options.publicApiUrl} : {}),
    ...(options.legacyPublicApiUrls ? {legacyPublicApiUrls: options.legacyPublicApiUrls} : {}),
    bearerAuthority,
    ownerProtection: secrets.protection,
    secretFileReader: secrets.reader,
    room: room.room,
    now: options.now ?? (() => NOW),
  });
  return { ports, room, secrets, bearerAuthority };
}

function edgeHeaders(attestation = ATTESTATION): string[] {
  return [
    'Host', 'ai.example.invalid',
    'Content-Type', 'application/json',
    'Content-Length', '2',
    'Authorization', `Bearer ${CONTROL_TOKEN}`,
    'X-Forwarded-For', '203.0.113.18',
    'X-Forwarded-Host', 'ai.example.invalid',
    'X-Forwarded-Proto', 'https',
    'X-PAIOS-Proxy-Attestation', attestation,
    'X-PAIOS-Trusted-Edge', 'tencent-nginx-loopback-v1',
    'X-PAIOS-Trusted-Source-Family', 'ipv4',
  ];
}

test('production secret reader factory reuses the closed lstat/read implementation', () => {
  const reader = createPersistentPublicSecretFileReader();
  const root = mkdtempSync(join(tmpdir(), 'paios-public-reader-'));
  try {
    for (const [name, value] of [['key', LIVEKIT_KEY], ['secret', LIVEKIT_SECRET], ['attestation', ATTESTATION]] as const) {
      const path = join(root, name);
      writeFileSync(path, value, { mode: 0o600 });
      const facts = reader.inspect(path);
      assert.equal(facts.regular, true);
      assert.equal(facts.reparse, false);
      assert.deepEqual(reader.read(path), Buffer.from(value));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner-protected resolver admits only the exact four references and releases its lease', async () => {
  const fixture = secretHarness();
  const resolver = createPersistentPublicSecretResolver(fixture.protection, fixture.reader);
  const lease = await resolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.proxyAttestation);
  assert.equal(lease.read(), ATTESTATION);
  lease.release?.();
  assert.throws(() => lease.read(), /PERSISTENT_PUBLIC_SECRET_LEASE_RELEASED/u);
  await assert.rejects(resolver.resolve({ name: 'other-secret' }), /PERSISTENT_PUBLIC_SECRET_REF_UNKNOWN/u);
  await assert.rejects(
    resolver.resolve({ name: 'proxy-attestation', version: '1' }),
    /PERSISTENT_PUBLIC_SECRET_REF_INVALID/u,
  );
  assert.deepEqual(fixture.reads, [PERSISTENT_PUBLIC_SECRET_PATHS.proxyAttestation]);
  const rootLease = await resolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey);
  assert.equal(rootLease.read(), E2EE_ROOT_KEY);
  rootLease.release?.();
});

test('optional E2EE root does not block legacy Public readiness but fails its own resolution', async () => {
  const secrets = secretHarness({ overrides: { [PERSISTENT_PUBLIC_SECRET_PATHS.e2eeRootKey]: 'invalid' } });
  const fixture = createFixture({ secrets });
  assert.equal(fixture.ports.readiness().ready, true);
  await assert.rejects(
    fixture.ports.secretResolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey),
    /PERSISTENT_PUBLIC_SECRET_VALUE_INVALID/u,
  );
  await fixture.ports.close();
});

test('resolver rejects missing owner protection, reparse files, and invalid secret bytes', async () => {
  const unprotected = secretHarness({ protected: false });
  const unprotectedResolver = createPersistentPublicSecretResolver(unprotected.protection, unprotected.reader);
  await assert.rejects(
    unprotectedResolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey),
    /PERSISTENT_PUBLIC_SECRET_FILE_NOT_READY/u,
  );
  const reparse = secretHarness({ reparsePath: PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiSecret });
  const reparseResolver = createPersistentPublicSecretResolver(reparse.protection, reparse.reader);
  await assert.rejects(
    reparseResolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret),
    /PERSISTENT_PUBLIC_SECRET_FILE_NOT_READY/u,
  );
  const invalid = secretHarness({ overrides: { [PERSISTENT_PUBLIC_SECRET_PATHS.proxyAttestation]: 'short' } });
  const invalidResolver = createPersistentPublicSecretResolver(invalid.protection, invalid.reader);
  await assert.rejects(
    invalidResolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.proxyAttestation),
    /PERSISTENT_PUBLIC_SECRET_VALUE_INVALID/u,
  );
});

test('edge accepts the exact Tencent projection and fails closed on every provenance drift', async () => {
  const { ports } = createFixture();
  const valid = {
    method: 'POST',
    url: '/v1/realtime/bootstrap',
    remoteAddress: '127.0.0.1',
    rawHeaders: edgeHeaders(),
    controlHost: '127.0.0.1',
  };
  await ports.edge.authorize(valid);
  await assert.rejects(ports.edge.authorize({ ...valid, url: '/v1/realtime/bootstrap?retry=1' }), /PUBLIC_EDGE_REQUEST_DENIED/u);
  await assert.rejects(ports.edge.authorize({ ...valid, remoteAddress: '203.0.113.18' }), /PUBLIC_EDGE_REQUEST_DENIED/u);
  await assert.rejects(ports.edge.authorize({ ...valid, rawHeaders: edgeHeaders('B'.repeat(43)) }), /PUBLIC_EDGE_ATTESTATION_INVALID/u);
  await assert.rejects(ports.edge.authorize({
    ...valid,
    rawHeaders: [...edgeHeaders(), 'X-PAIOS-Proxy-Attestation', ATTESTATION],
  }), /PUBLIC_EDGE_ATTESTATION_INVALID/u);
  await assert.rejects(ports.edge.authorize({
    ...valid,
    rawHeaders: [...edgeHeaders(), 'Upgrade', 'websocket'],
  }), /PUBLIC_EDGE_HEADERS_INVALID/u);
  await assert.rejects(ports.edge.authorize({
    ...valid,
    rawHeaders: [...edgeHeaders(), 'X-PAIOS-Unowned', '1'],
  }), /PUBLIC_EDGE_HEADERS_INVALID/u);
});

test('bearer returns only the current owner snapshot and rejects token, expiry, scope, and authority drift', async () => {
  const { ports } = createFixture();
  const context = await ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} });
  assert.equal(context.deviceId, 'iphone-cycling-owner');
  assert.deepEqual(context.scopes, ['bootstrap', 'media_stop']);

  const wrong = createFixture({ bearerAuthority: authority({ value: snapshot('different-token') }) });
  await assert.rejects(
    wrong.ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} }),
    /PUBLIC_BEARER_SNAPSHOT_INVALID/u,
  );
  const expired = createFixture({ bearerAuthority: authority({ value: snapshot(CONTROL_TOKEN, { expiresAt: '2029-12-31T23:59:59.000Z' }) }) });
  await assert.rejects(
    expired.ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} }),
    /PUBLIC_BEARER_NOT_AUTHORIZED/u,
  );
  const scoped = createFixture({ bearerAuthority: authority({ value: snapshot(CONTROL_TOKEN, { scopes: ['media_stop'] }) }) });
  await assert.rejects(
    scoped.ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} }),
    /PUBLIC_BEARER_NOT_AUTHORIZED/u,
  );
  const unavailable = createFixture({ bearerAuthority: authority({ unavailable: true }) });
  let errorText = '';
  try {
    await unavailable.ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} });
  } catch (error) {
    errorText = String(error);
  }
  assert.match(errorText, /PUBLIC_BEARER_AUTHORITY_UNAVAILABLE/u);
  assert.equal(errorText.includes(CONTROL_TOKEN), false);
  assert.equal(errorText.includes('OWNER_DETAIL_MUST_NOT_ESCAPE'), false);
  const invalidClock = createFixture({ now: () => Number.NaN });
  await assert.rejects(
    invalidClock.ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} }),
    /PUBLIC_BEARER_NOT_AUTHORIZED/u,
  );
});

test('self-hosted signer and participant reuse the admitted exact origin without a network side effect', async () => {
  const { ports, room } = createFixture({livekitApiUrl: 'http://127.0.0.1:7880'});
  ports.tokenSigner.assertProjectUrl('wss://ai.example.invalid');
  const grants = {
    room: 'cycling-room', roomJoin: true as const, canPublish: false,
    canSubscribe: true, canPublishData: true, canPublishSources: [] as const,
  };
  const token = await ports.tokenSigner.sign({
    room: 'cycling-room', identity: 'gateway-cycling', ttlSeconds: 120, grants,
  });
  assert.ok(token.length > 16);
  await ports.participant.connect({
    projectUrl: ports.livekitUrl,
    roomName: 'cycling-room',
    identity: 'gateway-cycling',
    token,
    grants,
    roomOptions: { encryption: { keyProviderOptions: {} } },
    binding: {
      realtimeSessionRef: { ref_type: 'RealtimeSession', ref_id: 'session-opaque' },
      deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: 'lease-opaque' },
      continuityId: 'continuity-opaque',
      transportAliases: ['room-opaque'],
      connectionEpoch: '1',
    },
  });
  assert.equal(room.connects.length, 1);
  assert.equal(room.connects[0]![0], 'ws://127.0.0.1:7880');
  assert.equal(ports.participant.snapshot().projectUrl, 'wss://ai.example.invalid');
  await ports.close();
});

test('readiness is truthful and close fences edge, bearer, signer, participant, and owner authority once', async () => {
  const bearerAuthority = authority();
  const fixture = createFixture({ bearerAuthority });
  assert.equal(fixture.ports.readiness().ready, true);
  await fixture.ports.participant.connect({
    projectUrl: fixture.ports.livekitUrl,
    roomName: 'cycling-room',
    identity: 'gateway-cycling',
    token: 'opaque-participant-token',
    grants: {
      room: 'cycling-room', roomJoin: true, canPublish: false,
      canSubscribe: true, canPublishData: true, canPublishSources: [],
    },
    roomOptions: { encryption: { keyProviderOptions: {} } },
    binding: {
      realtimeSessionRef: { ref_type: 'RealtimeSession', ref_id: 'session-opaque' },
      deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: 'lease-opaque' },
      continuityId: 'continuity-opaque',
      transportAliases: ['room-opaque'],
      connectionEpoch: '1',
    },
  });
  await fixture.ports.close();
  await fixture.ports.close();
  assert.equal(fixture.ports.readiness().ready, false);
  assert.equal(bearerAuthority.closeCount(), 1);
  assert.equal(fixture.room.disconnects(), 1);
  await assert.rejects(fixture.ports.edge.authorize({
    method: 'POST', url: '/v1/realtime/bootstrap', remoteAddress: '127.0.0.1',
    rawHeaders: edgeHeaders(), controlHost: '127.0.0.1',
  }), /PERSISTENT_PUBLIC_PORTS_CLOSED/u);
  await assert.rejects(
    fixture.ports.bearer.authorize({ token: CONTROL_TOKEN, operation: 'bootstrap', request: {} }),
    /PERSISTENT_PUBLIC_PORTS_CLOSED/u,
  );
  await assert.rejects(
    fixture.ports.tokenSigner.sign({
      room: 'cycling-room', identity: 'gateway-cycling', ttlSeconds: 120,
      grants: { room: 'cycling-room', roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: true, canPublishSources: [] },
    }),
    /TOKEN_SIGNER_CLOSED/u,
  );
});

test('readiness converts an owner probe exception into not-ready without inventing a reason', async () => {
  const throwingAuthority: PersistentPublicBearerAuthorityPort = {
    isReady() { throw new Error('OWNER_INTERNAL_DETAIL'); },
    async resolve() { return undefined; },
  };
  const fixture = createFixture({ bearerAuthority: throwingAuthority });
  const current = fixture.ports.readiness();
  assert.equal(current.ready, false);
  assert.deepEqual(current.statuses.find((status) => status.name === 'bearer_authority'), {
    name: 'bearer_authority', ready: false, reason: 'bearer_authority_not_ready',
  });
  assert.equal(JSON.stringify(current).includes('OWNER_INTERNAL_DETAIL'), false);
});


test('migration hosts share bearer authority and require equal exact Host and forwarded Host', async () => {
  const canonical = 'https://bj.example.invalid:9443';
  const legacy = 'https://ai.example.invalid';
  const {ports} = createFixture({publicApiUrl: canonical, legacyPublicApiUrls: legacy});
  const headers = (host: string, forwarded = host) => edgeHeaders().map((value, index, all) =>
    all[index - 1] === 'Host' ? host : all[index - 1] === 'X-Forwarded-Host' ? forwarded : value);
  const input = {method:'POST',url:'/v1/realtime/bootstrap/reconcile',remoteAddress:'127.0.0.1',controlHost:'127.0.0.1'};
  for (const origin of [canonical, legacy]) {
    await ports.edge.authorize({...input,rawHeaders:headers(new URL(origin).host)});
    assert.equal((await ports.bearer.authorize({token:CONTROL_TOKEN,operation:'bootstrap',request:{}})).deviceId,'iphone-cycling-owner');
  }
  for (const [host, forwarded] of [
    [new URL(canonical).host,new URL(legacy).host],
    ['bj.example.invalid','bj.example.invalid'],
    ['ai.example.invalid.evil','ai.example.invalid.evil'],
    ['ai.example.invalid,evil','ai.example.invalid,evil'],
  ]) await assert.rejects(ports.edge.authorize({...input,rawHeaders:headers(host!,forwarded!)}),/PUBLIC_EDGE_HEADERS_INVALID/);
  await assert.rejects(ports.edge.authorize({...input,rawHeaders:[...headers(new URL(legacy).host),'Host',new URL(legacy).host]}),/PUBLIC_EDGE_HEADERS_INVALID/);
  const closedWindow = createFixture({publicApiUrl:canonical}).ports;
  await closedWindow.edge.authorize({...input,rawHeaders:headers(new URL(canonical).host)});
  assert.equal((await closedWindow.bearer.authorize({token:CONTROL_TOKEN,operation:'bootstrap',request:{}})).deviceId,'iphone-cycling-owner');
  await assert.rejects(closedWindow.edge.authorize({...input,rawHeaders:headers(new URL(legacy).host)}),/PUBLIC_EDGE_HEADERS_INVALID/);
  await closedWindow.close();
  await ports.close();
});

test('fresh host generated credentials satisfy public readiness and the E2EE root lease contract',async()=>{
  const root=mkdtempSync(join(tmpdir(),'paios-generated-secrets-'));
  let fixture:ReturnType<typeof createFixture>|undefined;
  try {
    execFileSync('python3',[fileURLToPath(new URL('../../../../../deploy/cloud/prepare-secrets.py',import.meta.url)),
      '--secrets-dir',root,'--public-host','fixture.invalid','--public-ipv4','192.0.2.10'],{stdio:'pipe'});
    const paths=new Map([
      [PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiKey,join(root,'livekit-api-key')],
      [PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiSecret,join(root,'livekit-api-secret')],
      [PERSISTENT_PUBLIC_SECRET_PATHS.proxyAttestation,join(root,'proxy-attestation')],
      [PERSISTENT_PUBLIC_SECRET_PATHS.e2eeRootKey,join(root,'e2ee-root-key')],
    ]);
    const files=createPersistentPublicSecretFileReader();
    const reader:PersistentPublicSecretFileReader={inspect:path=>files.inspect(paths.get(path)!),read:path=>files.read(paths.get(path)!)};
    const protection:PersistentPublicOwnerProtectionPort={isOwnerProtected:path=>
      paths.has(path)&&(statSync(paths.get(path)!).mode&0o077)===0};
    fixture=createFixture({secrets:{reader,protection,reads:[]}});
    assert.equal(fixture.ports.readiness().ready,true);
    const lease=await fixture.ports.secretResolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey);
    assert.match(lease.read(),/^[A-Za-z0-9_-]{43}$/u);
    assert.equal(Buffer.from(lease.read(),'base64url').length,32);
    lease.release?.();
    assert.throws(()=>lease.read(),/PERSISTENT_PUBLIC_SECRET_LEASE_RELEASED/u);
  } finally {
    await fixture?.ports.close();
    rmSync(root,{recursive:true,force:true});
  }
});
