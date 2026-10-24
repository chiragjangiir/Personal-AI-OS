import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import {
  createRayneoRealtimeVideoBridge,
  encodeRayneoRealtimeVideoRgbaPng,
  RAYNEO_REALTIME_VIDEO_DIAGNOSTIC_STAGES,
  RAYNEO_REALTIME_VIDEO_FRAME_SIZE,
  type RayneoRealtimeVideoBridge,
  type RayneoRealtimeVideoPublication,
  type RayneoRealtimeVideoRoom,
  type RayneoRealtimeVideoRuntime,
  type RayneoRealtimeVideoSample,
  type RayneoRealtimeVideoSource,
  type RayneoRealtimeVideoTrack,
} from '../src/rayneo-realtime-video-bridge.ts';

const BINDING = Object.freeze({
  sessionId: 'phase0_session_aaaaaaaaaaaaaaaaaaaa',
  deviceId: 'rayneo_device_bbbbbbbbbbbbbbbbbbbb',
  clientInstanceId: 'rayneo_client_cccccccccccccccccccc',
});

class FakeSource implements RayneoRealtimeVideoSource {
  captureCount = 0;
  closed = false;
  captureFrame(_frame: unknown): void { this.captureCount += 1; }
  async close(): Promise<void> { this.closed = true; }
}

class FakeTrack implements RayneoRealtimeVideoTrack {
  readonly sid = 'video_sid';
  private readonly source: FakeSource;
  constructor(source: FakeSource) { this.source = source; }
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
    this.source.closed = true;
  }
}

class FakeRoom implements RayneoRealtimeVideoRoom {
  readonly handlers = new Map<string, (...args: never[]) => void>();
  readonly published: Array<{ track: RayneoRealtimeVideoTrack; options: unknown }> = [];
  readonly unpublished: string[] = [];
  readonly localParticipant = {
    publishTrack: async (
      track: RayneoRealtimeVideoTrack,
      options: unknown,
    ): Promise<RayneoRealtimeVideoPublication> => {
      this.published.push({ track, options });
      return { sid: track.sid };
    },
    unpublishTrack: async (sid: string): Promise<void> => {
      this.unpublished.push(sid);
    },
  };
  on(event: string, handler: (...args: never[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args as never[]);
  }
}

function participant(): RemoteParticipant {
  return {
    identity: BINDING.deviceId,
    attributes: {
      device_id: BINDING.deviceId,
      device_class: 'rayneo',
      client_instance_id: BINDING.clientInstanceId,
      session_id: BINDING.sessionId,
    },
  } as unknown as RemoteParticipant;
}

function cameraPublication(track: RemoteTrack): RemoteTrackPublication {
  return {
    kind: TrackKind.KIND_VIDEO,
    source: TrackSource.SOURCE_CAMERA,
    sid: 'remote_camera_sid',
    track,
    subscribed: true,
  } as unknown as RemoteTrackPublication;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('bounded video bridge wait expired');
}

test('video bridge publishes official camera source, observes only bound camera frames, and stops cleanly', async () => {
  const room = new FakeRoom();
  const source = new FakeSource();
  const track = new FakeTrack(source);
  const stages: string[] = [];
  let releasedFrames = 0;
  let observedClock = 1_000;
  const runtime: RayneoRealtimeVideoRuntime = {
    createSource: () => source,
    createTrack: () => track,
    createFrame: (data, width, height) => ({ data, width, height }),
    createStream: () => (async function* () {
      yield { frame: Object.freeze({ id: 1 }) };
      yield { frame: Object.freeze({ id: 2 }) };
      yield { frame: Object.freeze({ id: 3 }) };
    })(),
    createPublishOptions: () => ({ source: TrackSource.SOURCE_CAMERA }),
    encodeSample: (frame) => ({
      width: 2,
      height: 1,
      bytes: Uint8Array.of(137, 80, 78, 71, (frame as { id: number }).id),
    }),
    releaseFrame: () => { releasedFrames += 1; },
  };
  const bridge: RayneoRealtimeVideoBridge = await createRayneoRealtimeVideoBridge(
    room, BINDING, (stage) => stages.push(stage), runtime,
    () => { const value = observedClock; observedClock += 2_000; return value; },
  );
  assert.deepEqual(RAYNEO_REALTIME_VIDEO_DIAGNOSTIC_STAGES, [
    'REMOTE_CAMERA_TRACK_SUBSCRIBED',
    'FRAME_OBSERVED',
    'VIDEO_TRACK_PUBLISHED',
    'VIDEO_STOPPED',
    'VIDEO_BRIDGE_FAILED',
  ]);
  assert.deepEqual(RAYNEO_REALTIME_VIDEO_FRAME_SIZE, {
    width: 64,
    height: 48,
    intervalMs: 500,
    sampleIntervalMs: 2_000,
    sampleMaxEdge: 640,
    sampleRingSize: 8,
  });
  assert.equal(room.published.length, 1);
  assert.deepEqual(room.published[0]!.options, { source: TrackSource.SOURCE_CAMERA });
  assert.equal(source.captureCount, 1);
  const remoteTrack = {} as RemoteTrack;
  room.emit('trackSubscribed', remoteTrack, cameraPublication(remoteTrack), participant());
  await waitUntil(() => stages.filter((stage) => stage === 'FRAME_OBSERVED').length === 3);
  assert.deepEqual(stages.slice(0, 3), [
    'VIDEO_TRACK_PUBLISHED',
    'REMOTE_CAMERA_TRACK_SUBSCRIBED',
    'FRAME_OBSERVED',
  ]);
  assert.equal(releasedFrames, 3);
  const samples = bridge.readSamples(0, 10_000, 2);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((sample) => sample.observedAtMs), [1_000, 5_000]);
  assert.deepEqual(samples.map((sample) => [...sample.bytes]), [
    [137, 80, 78, 71, 1],
    [137, 80, 78, 71, 3],
  ]);
  samples[0]!.bytes.fill(0);
  assert.deepEqual([...bridge.readSamples(0, 10_000, 1)[0]!.bytes], [137, 80, 78, 71, 3]);
  await bridge.stop();
  await bridge.stop();
  assert.deepEqual(room.unpublished, ['video_sid']);
  assert.equal(track.closed, true);
  assert.equal(source.closed, true);
  assert.equal(stages.at(-1), 'VIDEO_STOPPED');
});

test('video bridge rejects non-camera or unbound tracks without observing frames', async () => {
  const room = new FakeRoom();
  const source = new FakeSource();
  const track = new FakeTrack(source);
  const stages: string[] = [];
  const runtime: RayneoRealtimeVideoRuntime = {
    createSource: () => source,
    createTrack: () => track,
    createFrame: () => ({}),
    createStream: () => (async function* () { yield { frame: {} }; })(),
    createPublishOptions: () => ({ source: TrackSource.SOURCE_CAMERA }),
    encodeSample: () => ({ width: 1, height: 1, bytes: Uint8Array.of(1) }),
    releaseFrame: () => undefined,
  };
  const bridge = await createRayneoRealtimeVideoBridge(room, BINDING, (stage) => stages.push(stage), runtime);
  const remoteTrack = {} as RemoteTrack;
  room.emit('trackSubscribed', remoteTrack, {
    ...cameraPublication(remoteTrack),
    source: TrackSource.SOURCE_MICROPHONE,
  }, participant());
  room.emit('trackSubscribed', remoteTrack, cameraPublication(remoteTrack), {
    ...participant(), identity: 'rayneo_device_dddddddddddddddddddd',
  } as unknown as RemoteParticipant);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stages.includes('REMOTE_CAMERA_TRACK_SUBSCRIBED'), false);
  assert.equal(stages.includes('FRAME_OBSERVED'), false);
  await bridge.stop();
});

test('public-assistant video mode observes the borrowed camera without local publish or RayNeo attributes', async () => {
  const room = new FakeRoom();
  const stages: string[] = [];
  const observed: RayneoRealtimeVideoSample[] = [];
  let observedClock = 1_000;
  const runtime: RayneoRealtimeVideoRuntime = {
    createSource: () => { throw new Error('PUBLIC_VIDEO_MUST_NOT_CREATE_SOURCE'); },
    createTrack: () => { throw new Error('PUBLIC_VIDEO_MUST_NOT_CREATE_TRACK'); },
    createFrame: () => { throw new Error('PUBLIC_VIDEO_MUST_NOT_CREATE_FRAME'); },
    createStream: () => (async function* () {
      yield { frame: Object.freeze({ id: 1 }) };
      yield { frame: Object.freeze({ id: 2 }) };
    })(),
    createPublishOptions: () => { throw new Error('PUBLIC_VIDEO_MUST_NOT_PUBLISH'); },
    encodeSample: (frame) => ({
      width: 2,
      height: 1,
      bytes: Uint8Array.of(137, 80, 78, 71, (frame as { id: number }).id),
    }),
    releaseFrame: () => undefined,
  };
  const bridge = await createRayneoRealtimeVideoBridge(
    room,
    Object.freeze({ ...BINDING, mode: 'public-assistant' as const, participantIdentity: 'iphone-identity' }),
    (stage) => stages.push(stage),
    runtime,
    () => { const value = observedClock; observedClock += 2_000; return value; },
    (sample) => { observed.push(sample); },
  );
  const remoteTrack = {} as RemoteTrack;
  room.emit('trackSubscribed', remoteTrack, cameraPublication(remoteTrack), {
    identity: 'wrong-identity', attributes: {},
  } as unknown as RemoteParticipant);
  room.emit('trackSubscribed', remoteTrack, {
    ...cameraPublication(remoteTrack), source: TrackSource.SOURCE_MICROPHONE,
  }, { identity: 'iphone-identity', attributes: {} } as unknown as RemoteParticipant);
  room.emit('trackSubscribed', remoteTrack, cameraPublication(remoteTrack), {
    identity: 'iphone-identity', attributes: {},
  } as unknown as RemoteParticipant);
  await waitUntil(() => observed.length === 2);
  assert.equal(room.published.length, 0);
  assert.deepEqual(observed.map((sample) => sample.observedAtMs), [1_000, 3_000]);
  assert.equal(stages.filter((stage) => stage === 'VIDEO_TRACK_PUBLISHED').length, 0);
  assert.equal(stages.filter((stage) => stage === 'REMOTE_CAMERA_TRACK_SUBSCRIBED').length, 1);
  await bridge.stop();
  assert.deepEqual(room.unpublished, []);
  observed.forEach((sample) => sample.bytes.fill(0));
});

test('RGBA encoder emits a bounded lossless PNG without retaining mutable source bytes', () => {
  const rgba = Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255);
  const encoded = encodeRayneoRealtimeVideoRgbaPng(rgba, 2, 1);
  assert.equal(encoded.width, 2);
  assert.equal(encoded.height, 1);
  assert.deepEqual([...encoded.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(Buffer.from(encoded.bytes).readUInt32BE(16), 2);
  assert.equal(Buffer.from(encoded.bytes).readUInt32BE(20), 1);
  assert.deepEqual([...rgba], [255, 0, 0, 255, 0, 0, 255, 255]);
});

async function realCodecOwnershipBridge(count: number, onSample: (sample: RayneoRealtimeVideoSample) => void | Promise<void>,
  invalid = false) {
  const room = new FakeRoom();
  const stages: string[] = [];
  const encoded: Uint8Array[] = [];
  const expected: Buffer[] = [];
  let released = 0;
  let clock = 1_000;
  const runtime: RayneoRealtimeVideoRuntime = {
    createSource: () => { throw new Error('PUBLIC_SOURCE_NOT_EXPECTED'); },
    createTrack: () => { throw new Error('PUBLIC_TRACK_NOT_EXPECTED'); },
    createFrame: () => { throw new Error('PUBLIC_FRAME_NOT_EXPECTED'); },
    createStream: () => (async function* () {
      for (let id = 1; id <= count; id++) yield {frame: {id}};
    })(),
    createPublishOptions: () => { throw new Error('PUBLIC_PUBLISH_NOT_EXPECTED'); },
    encodeSample: (frame) => {
      const id = (frame as {id: number}).id;
      const png = encodeRayneoRealtimeVideoRgbaPng(Uint8Array.of(id, 20, 30, 255, 40, 50, 60, 255), 2, 1);
      assert(Buffer.isBuffer(png.bytes), 'actual installed graph codec returns Buffer');
      expected.push(Buffer.from(png.bytes));
      encoded.push(png.bytes);
      return invalid ? {...png, width: 641} : png;
    },
    releaseFrame: () => { released++; },
  };
  const bridge = await createRayneoRealtimeVideoBridge(room, {...BINDING, mode: 'public-assistant', participantIdentity: 'iphone-identity'},
    stage => stages.push(stage), runtime, () => {const value = clock; clock += 2_000; return value;}, onSample);
  const remoteTrack = {} as RemoteTrack;
  room.emit('trackSubscribed', remoteTrack, cameraPublication(remoteTrack), {
    identity: 'iphone-identity', attributes: {},
  } as unknown as RemoteParticipant);
  await waitUntil(() => released === count);
  return {bridge, stages, encoded, expected, released};
}

test('real Buffer codec -> production bridge keeps caller snapshots independent of cleanup, consumer clear and synchronous observer throw', async () => {
  const delivered: RayneoRealtimeVideoSample[] = [];
  const f = await realCodecOwnershipBridge(1, sample => {
    delivered.push(sample);
    sample.bytes.fill(0);
    throw new Error('CONTROLLED_CALLBACK_THROW');
  });
  try {
    const first = f.bridge.readSamples(0, 2_000)[0]!;
    assert.deepEqual(Buffer.from(first.bytes), f.expected[0], 'encoder cleanup or observer mutation must not erase the ring PNG');
    assert(Object.isFrozen(first));
    assert(Object.isFrozen(delivered[0]));
    assert(f.encoded[0]!.every(byte => byte === 0));
    first.bytes.fill(0);
    const survivor = f.bridge.readSamples(0, 2_000)[0]!;
    assert.deepEqual(Buffer.from(survivor.bytes), f.expected[0]);
    await f.bridge.stop();
    assert.deepEqual(Buffer.from(survivor.bytes), f.expected[0], 'stop clears ring, not caller-owned snapshots');
    assert.equal(f.bridge.readSamples(0, 2_000).length, 0);
  } finally { await f.bridge.stop(); }
});

test('real Buffer codec ring eviction and rejected async observer leave independent historical and read snapshots', async () => {
  const delivered: RayneoRealtimeVideoSample[] = [];
  const f = await realCodecOwnershipBridge(10, async sample => {
    delivered.push(sample);
    await Promise.resolve();
    if (sample.observedAtMs !== 1_000) sample.bytes.fill(0);
    throw new Error('CONTROLLED_ASYNC_REJECTION');
  });
  try {
    assert.equal(f.released, 10);
    assert.equal(f.stages.filter(stage => stage === 'FRAME_OBSERVED').length, 10);
    assert.equal(f.stages.includes('VIDEO_BRIDGE_FAILED'), false);
    assert.deepEqual(Buffer.from(delivered[0]!.bytes), f.expected[0], 'evicted first ring slot must not clear observer copy');
    assert.equal(f.bridge.readSamples(0, 1_000).length, 0, 'first two frames have been evicted from bounded ring');
    const snapshots = f.bridge.readSamples(0, 30_000, 3);
    assert.deepEqual(snapshots.map(s => s.observedAtMs), [5_000, 13_000, 19_000]);
    assert.deepEqual(snapshots.map(s => Buffer.from(s.bytes)), [f.expected[2], f.expected[6], f.expected[9]]);
    await f.bridge.stop();
    assert.deepEqual(snapshots.map(s => Buffer.from(s.bytes)), [f.expected[2], f.expected[6], f.expected[9]]);
    delivered[0]!.bytes.fill(0);
    assert.deepEqual(Buffer.from(snapshots[0]!.bytes), f.expected[2]);
    assert(f.encoded.every(bytes => bytes.every(byte => byte === 0)));
  } finally { await f.bridge.stop(); }
});

test('bad untrusted runtime PNG return is rejected, bytes cleared, frame released and observer not invoked', async () => {
  const f = await realCodecOwnershipBridge(1, () => assert.fail('invalid sample must not be delivered'), true);
  try {
    assert(f.stages.includes('VIDEO_BRIDGE_FAILED'));
    assert.equal(f.released, 1);
    assert(f.encoded[0]!.every(byte => byte === 0));
    assert.equal(f.bridge.readSamples(0, 2_000).length, 0);
  } finally { await f.bridge.stop(); }
});
