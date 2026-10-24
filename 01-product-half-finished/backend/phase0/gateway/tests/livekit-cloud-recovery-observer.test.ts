import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LiveKitCloudRecoveryObserver,
} from '../src/livekit-cloud-recovery-observer.ts';
import {
  LiveKitCloudParticipant,
  type LiveKitCloudRoomPort,
} from '../src/livekit-cloud-participant.ts';

const binding = {
  realtimeSessionRef: { ref_type: 'RealtimeSession', ref_id: 'session' },
  deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: 'lease' },
  continuityId: 'continuity',
  transportAliases: ['room-alias', 'participant-alias'],
  connectionEpoch: '7',
};
const grants = {
  room: 'gateway-room', roomJoin: true as const, canPublish: false,
  canSubscribe: true, canPublishData: true, canPublishSources: [] as const,
};
const roomOptions = { encryption: { keyProviderOptions: {} } };

type Listener = (...args: readonly unknown[]) => void;

function roomState(disconnectFails = false, disconnectReason?: unknown) {
  const listeners = new Map<string, Set<Listener>>();
  const state = {
    connects: [] as unknown[][],
    disconnects: 0,
    offCalls: 0,
    removeAllCalls: 0,
    stats: {} as unknown,
  };
  const room: LiveKitCloudRoomPort = {
    async connect(...args) { state.connects.push(args); },
    async disconnect() {
      state.disconnects += 1;
      for (const listener of [...(listeners.get('disconnected') ?? [])]) listener(disconnectReason ?? 1);
      if (disconnectFails) throw new Error('ROOM_DISCONNECT_FAILED');
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    off(event, listener) {
      state.offCalls += 1;
      listeners.get(event)?.delete(listener);
    },
    removeAllListeners() {
      state.removeAllCalls += 1;
      listeners.clear();
    },
    async getRtcStats() { return state.stats; },
  };
  const emit = (event: string, ...args: readonly unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  return { room, state, listeners, emit };
}

async function connectedParticipant(room: LiveKitCloudRoomPort): Promise<LiveKitCloudParticipant> {
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({
    projectUrl: 'wss://project.livekit.cloud',
    roomName: 'gateway-room',
    identity: 'gateway-identity',
    token: 'opaque-participant-token',
    grants,
    binding,
    roomOptions,
  });
  return participant;
}

test('observer consumes ordered SDK events passively and never duplicates connect or republish', async () => {
  const { room, state, emit } = roomState();
  const participant = await connectedParticipant(room);
  let now = 1_000;
  const observations: string[] = [];
  const observer = new LiveKitCloudRecoveryObserver(participant, room, {
    nowMs: () => now,
    onObservation: (item) => observations.push(`${item.sequence}:${item.kind}`),
  });

  emit('reconnecting');
  now = 1_050;
  emit('reconnecting');
  now = 1_130;
  emit('reconnected');
  emit('reconnected');
  emit('connectionQualityChanged', 1, {});
  const publication = { kind: 1, source: 2, sid: 'secret-track-sid' };
  emit('localTrackPublished', publication, {});
  emit('localTrackPublished', publication, {});
  emit('localTrackRepublished', publication, 'old-secret-sid', {});
  emit('trackSubscribed', { kind: 1, source: 2 }, publication, {});
  emit('trackUnsubscribed', { kind: 1, source: 2 }, publication, {});

  assert.equal(state.connects.length, 1);
  assert.equal(observer.snapshot().sequence, observations.length);
  assert.deepEqual(
    observer.snapshot().observations.map((item) => item.kind),
    [
      'reconnecting', 'reconnecting', 'reconnected', 'reconnected',
      'connection-quality-changed', 'local-track-published', 'local-track-published',
      'local-track-republished', 'track-subscribed', 'track-unsubscribed',
    ],
  );
  assert.equal(observer.snapshot().observations[1]?.duplicate, true);
  assert.equal(observer.snapshot().observations[3]?.duplicate, true);
  assert.equal(observer.snapshot().observations[5]?.trackIntent?.kind, 'audio');
  assert.equal(observer.snapshot().observations[5]?.trackIntent?.source, 'microphone');
  assert.equal(observer.snapshot().observations[5]?.trackCounters?.localPublished, 1);
  assert.equal(observer.snapshot().observations[6]?.trackCounters?.localPublished, 1);
  assert.equal(observer.snapshot().observations[7]?.trackCounters?.localPublished, 1);
  assert.equal(observer.snapshot().observations[7]?.trackCounters?.localRepublished, 1);
  assert.equal(observer.snapshot().observations[2]?.recoveryElapsedMs, 130);
  observer.close();
});

test('reconnect and track deduplication are scoped to the current cycle and safe track identity', async () => {
  const { room, emit } = roomState();
  const participant = await connectedParticipant(room);
  let now = 10_000;
  const observer = new LiveKitCloudRecoveryObserver(participant, room, { nowMs: () => now });

  emit('reconnecting');
  now = 10_125;
  emit('reconnected');
  now = 20_000;
  emit('reconnecting');
  now = 20_275;
  emit('reconnected');
  const reconnects = observer.snapshot().observations.filter((item) => item.event === 'reconnected');
  assert.deepEqual(reconnects.map((item) => item.recoveryCycle), [1, 2]);
  assert.deepEqual(reconnects.map((item) => item.recoveryElapsedMs), [125, 275]);
  assert.equal(observer.snapshot().recoveryCycle, 2);

  const first = { kind: 1, source: 2, sid: 'first' };
  const second = { kind: 1, source: 2, sid: 'second' };
  emit('localTrackPublished', first, {});
  emit('localTrackPublished', first, {});
  emit('localTrackUnpublished', first, {});
  emit('localTrackPublished', first, {});
  emit('localTrackPublished', second, {});
  emit('localTrackRepublished', first, 'old-sid', {});
  assert.equal(observer.snapshot().trackCounters.localPublished, 3);
  assert.equal(observer.snapshot().trackCounters.localUnpublished, 1);
  assert.equal(observer.snapshot().trackCounters.localRepublished, 1);
  const remotePublication = { kind: 1, source: 2, sid: 'remote' };
  const remoteTrack = { kind: 1, source: 2 };
  emit('trackSubscribed', remoteTrack, remotePublication, {});
  emit('trackUnsubscribed', remoteTrack, remotePublication, {});
  emit('trackSubscribed', remoteTrack, remotePublication, {});
  assert.equal(observer.snapshot().trackCounters.remoteSubscribed, 2);
  assert.equal(observer.snapshot().trackCounters.remoteUnsubscribed, 1);

  now = 30_000;
  emit('reconnecting');
  now = 30_050;
  emit('reconnected');
  emit('localTrackPublished', first, {});
  emit('localTrackRepublished', first, 'another-old-sid', {});
  assert.equal(observer.snapshot().trackCounters.localPublished, 4);
  assert.equal(observer.snapshot().trackCounters.localRepublished, 2);
  observer.close();
});

test('track callbacks without a safe object identity are never globally source-deduped', async () => {
  const { room, emit } = roomState();
  const participant = await connectedParticipant(room);
  const observer = new LiveKitCloudRecoveryObserver(participant, room);

  emit('localTrackPublished');
  emit('localTrackPublished');
  emit('trackSubscribed');
  emit('trackSubscribed');
  assert.equal(observer.snapshot().trackCounters.localPublished, 2);
  assert.equal(observer.snapshot().trackCounters.remoteSubscribed, 2);
  assert.equal(observer.snapshot().observations.at(-1)?.duplicate, false);
  observer.close();
});

test('terminal disconnected is classified and only requests owner authority review', async () => {
  const { room, state, emit } = roomState();
  const participant = await connectedParticipant(room);
  const observer = new LiveKitCloudRecoveryObserver(participant, room);

  emit('disconnected', 2);
  const first = observer.snapshot().observations[0];
  assert.equal(first?.kind, 'owner-bootstrap-required');
  assert.equal(first?.ownerBootstrapRequired, true);
  assert.deepEqual(first?.disconnectReason, { classification: 'duplicate-identity' });
  assert.equal(first?.ownerAuthorityCheckRequired, true);
  assert.equal(first?.bootstrapAuthorized, false);
  assert.equal(first?.binding.connectionEpoch, '7');
  assert.equal(observer.snapshot().terminal, true);
  assert.equal(observer.snapshot().active, false);
  assert.equal(observer.snapshot().observations.length, 1);
  emit('disconnected', 3);
  assert.equal(observer.snapshot().observations.length, 1);
  assert.equal(state.connects.length, 1);
  assert.equal(state.disconnects, 0);
  observer.close();
});

test('explicit participant disconnect cancels observer before SDK client event and emits no bootstrap request', async () => {
  const { room, state } = roomState(false, 1);
  const participant = await connectedParticipant(room);
  const observer = new LiveKitCloudRecoveryObserver(participant, room);

  await participant.disconnect();
  assert.equal(state.disconnects, 1);
  assert.equal(observer.snapshot().active, false);
  assert.equal(observer.snapshot().closed, true);
  assert.deepEqual(observer.snapshot().observations, []);
});

test('client terminal observation is not owner-bootstrap-required; network and state mismatch only request owner authority review', async () => {
  const clientFixture = roomState();
  const clientParticipant = await connectedParticipant(clientFixture.room);
  const clientObserver = new LiveKitCloudRecoveryObserver(clientParticipant, clientFixture.room);
  clientFixture.emit('disconnected', 1);
  const clientObservation = clientObserver.snapshot().observations[0];
  assert.equal(clientObservation?.kind, 'client-disconnected');
  assert.equal(clientObservation?.ownerBootstrapRequired, undefined);
  assert.equal(clientObservation?.ownerAuthorityCheckRequired, undefined);

  const networkFixture = roomState();
  const networkParticipant = await connectedParticipant(networkFixture.room);
  const networkObserver = new LiveKitCloudRecoveryObserver(networkParticipant, networkFixture.room);
  networkFixture.emit('disconnected', 'NETWORK_TIMEOUT');
  const networkObservation = networkObserver.snapshot().observations[0];
  assert.equal(networkObservation?.kind, 'owner-bootstrap-required');
  assert.equal(networkObservation?.disconnectReason?.classification, 'network');
  assert.equal(networkObservation?.ownerAuthorityCheckRequired, true);
  assert.equal(networkObservation?.bootstrapAuthorized, false);

  const mismatchFixture = roomState();
  const mismatchParticipant = await connectedParticipant(mismatchFixture.room);
  const mismatchObserver = new LiveKitCloudRecoveryObserver(mismatchParticipant, mismatchFixture.room);
  mismatchFixture.emit('disconnected', 'STATE_MISMATCH');
  const mismatchObservation = mismatchObserver.snapshot().observations[0];
  assert.equal(mismatchObservation?.kind, 'owner-bootstrap-required');
  assert.equal(mismatchObservation?.disconnectReason?.classification, 'state-mismatch');
  assert.equal(mismatchObservation?.ownerAuthorityCheckRequired, true);
  assert.equal(mismatchObservation?.bootstrapAuthorized, false);
});

test('stats sampling is allowlisted and redacts address, URL, token, JWT, key, and raw stats', async () => {
  const { room, state } = roomState();
  state.stats = {
    publisherStats: [
      {
        stats: {
          case: 'localCandidate',
          value: {
            candidate: {
              address: '192.0.2.99', port: 9000, url: 'turns:secret.example?token=JWT-secret',
              usernameFragment: 'jwt-secret', candidateType: 3, protocol: 'udp',
              relatedAddress: '10.0.0.3', e2eeKey: 'e2ee-secret', secret: 'raw-secret',
            },
          },
        },
      },
      {
        stats: {
          case: 'transport',
          value: {
            transport: { protocol: 'tcp', packetsSent: 4n, packetsReceived: 5n, bytesSent: 100n, bytesReceived: 200n },
            token: 'jwt-secret', key: 'e2ee-secret',
          },
        },
      },
      {
        stats: {
          case: 'candidatePair',
          value: { candidatePair: { localCandidateId: 'secret-id', remoteCandidateId: 'secret-id-2', packetsSent: 2n } },
        },
      },
    ],
    subscriberStats: [{
      type: 'remote-candidate', candidateType: 'srflx', protocol: 'tls',
      address: '203.0.113.10', url: 'https://secret.example/JWT', key: 'secret',
    }],
    rawStats: 'must-not-appear',
  };
  const participant = await connectedParticipant(room);
  const observer = new LiveKitCloudRecoveryObserver(participant, room);
  const sampled = await observer.sampleStats();
  assert.equal(sampled?.kind, 'stats-sampled');
  assert.equal(sampled?.stats?.candidateRecordCount, 2);
  assert.equal(sampled?.stats?.candidatePairRecordCount, 1);
  assert.equal(sampled?.stats?.transportRecordCount, 1);
  assert.equal(sampled?.stats?.candidateTypeCounts.relay, 1);
  assert.equal(sampled?.stats?.candidateTypeCounts.srflx, 1);
  assert.equal(sampled?.stats?.protocolCounts.udp, 1);
  assert.equal(sampled?.stats?.protocolCounts.tcp, 1);
  assert.equal(sampled?.stats?.protocolCounts.tls, 1);
  assert.equal(sampled?.stats?.packetCounters.packetsSent, 6);
  assert.equal(sampled?.stats?.candidatePairClaim, 'not-claimed');
  const serialized = JSON.stringify(sampled);
  for (const secret of ['192.0.2.99', '203.0.113.10', 'secret.example', 'JWT-secret', 'jwt-secret', 'e2ee-secret', 'raw-secret', 'must-not-appear']) {
    assert.equal(serialized.includes(secret), false, `stats leaked ${secret}`);
  }
  observer.close();
});

test('hostile stats getters and stats failures stay local and secret-free', async () => {
  const { room } = roomState();
  const participant = await connectedParticipant(room);
  const statsPort = {
    getRtcStats: async () => {
      const hostile = {} as Record<string, unknown>;
      Object.defineProperty(hostile, 'publisherStats', { get() { throw new Error('secret failure'); } });
      Object.defineProperty(hostile, 'rawStats', { get() { return 'hostile-secret'; } });
      return hostile;
    },
  };
  const observer = new LiveKitCloudRecoveryObserver(participant, room, { statsPort });
  const sampled = await observer.sampleStats();
  assert.equal(sampled?.kind, 'stats-sampled');
  assert.equal(JSON.stringify(sampled).includes('hostile-secret'), false);
  observer.close();

  const failed = new LiveKitCloudRecoveryObserver(participant, room, {
    statsPort: { async getRtcStats() { throw new Error('JWT-failure-secret'); } },
  });
  const failedSample = await failed.sampleStats();
  assert.equal(failedSample?.kind, 'stats-sample-failed');
  assert.equal(JSON.stringify(failedSample).includes('JWT-failure-secret'), false);
  failed.close();
});

test('participant disconnect failure cancels observer and participant close removes listeners', async () => {
  const { room, state } = roomState(true);
  const participant = await connectedParticipant(room);
  const observer = new LiveKitCloudRecoveryObserver(participant, room);
  await assert.rejects(participant.close(), /LIVEKIT_PARTICIPANT_DISCONNECT_FAILED/);
  assert.equal(state.disconnects, 1);
  assert.equal(state.removeAllCalls, 1);
  assert.equal(observer.snapshot().active, false);
  assert.equal(observer.snapshot().closed, true);
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
});

test('observer can be started explicitly and uses room getRtcStats when no port is injected', async () => {
  const { room, state, emit } = roomState();
  state.stats = { publisherStats: [{ type: 'transport', protocol: 'udp' }] };
  const participant = await connectedParticipant(room);
  const observer = participant.createRecoveryObserver?.({ room, autoStart: false });
  assert.ok(observer);
  assert.equal(observer.snapshot().active, false);
  observer.start();
  emit('connected');
  const sample = await observer.sample();
  assert.equal(sample?.stats?.transportRecordCount, 1);
  assert.equal(observer.snapshot().active, true);
  observer.stop();
  assert.equal(observer.snapshot().closed, true);
});
