import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {basename, join} from 'node:path';
import {tmpdir} from 'node:os';
import {inflateSync} from 'node:zlib';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive, type TrackChunk} from '../src/stream-archive.ts';
import {MediaService} from '../src/media/service.ts';
import {MediaProcessor, type WorkerPort, type Capability, type WorkerRequest} from '../src/media/processing.ts';
import {controlledDetector, testJournal} from './speech-fixture.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
import {sha256, type RawEvent, type ProcessedEvent} from '../src/contracts.ts';
import type {NativeClient, NativeRun} from './native-source-fixture.ts';
import type {ClockMap} from '../src/media/align.ts';
import type {ContinuousBudget, ContinuousCandidate} from '../src/media/continuous-source.ts';

const evidenceRoot = process.env.MEDIA_CONTINUOUS_EVIDENCE_ROOT;
const validPng = await fs.readFile(new URL('./fixtures/continuous-coverage-rgba2x1.png', import.meta.url));
const diagnostic = 'CONTINUOUS_VISUAL_ALIGNMENT_UNKNOWN:';
// Controlled marker detector (speech-fixture). No real model is loaded and PCM markers are not speech. Continuous D are
// ambient (journaled, never a run), so their coverage is read from the processor's published D.

class ControlledNative implements NativeClient {
  calls = 0;
  readonly runs = new Map<string, NativeRun>();

  async create(body: {input: string; instructions: string; session_id: string}, key: string) {
    this.calls++;
    assert(!this.runs.has(key));
    const run = {
      run_id: `controlled-run-${this.calls}`,
      session_id: body.session_id,
      conversation_session_id: body.session_id,
      status: 'running',
    };
    this.runs.set(key, run);
    return {...run};
  }

  async status(id: string) {
    const run = [...this.runs.values()].find(value => value.run_id === id);
    assert(run);
    return {...run};
  }

  async cancel(id: string) {
    return this.status(id);
  }

  finish() {
    for (const run of this.runs.values()) run.status = 'completed';
  }
}

const budget: ContinuousBudget = {
  max_streams: 2,
  max_pending_chunks: 8,
  max_pending_candidates: 16,
  max_chunk_bytes: 1_000_000,
  block_samples: 160_000,
  overlap_samples: 8_000,
};

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('condition did not settle');
}

interface FixtureOptions {
  worker?: WorkerPort;
  maps?: ClockMap[];
  av?: boolean;
  authorize?: (maps: ClockMap[]) => Promise<void>;
  strict?: boolean;
  branchComplete?: boolean;
}

async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'paios-coverage-controlled-'));
  let runtime: PersonalAIOSRuntime | undefined;
  t.after(async () => {
    await runtime?.close();
    if (evidenceRoot) {
      await fs.mkdir(evidenceRoot, {recursive: true});
      await fs.cp(directory, join(evidenceRoot, basename(directory)), {recursive: true});
    }
    await fs.rm(directory, {recursive: true, force: true});
  });

  const storage = new PosixStorage(join(directory, 'storage'));
  const archiveBudget = {
    max_chunk_bytes: 1_000_000,
    max_total_bytes: 3_000_000,
    max_chunks: 100,
    max_revisions: 100,
    max_seq: 100,
  };
  const archive = new RawArchive(storage, 1_000_000, undefined, archiveBudget);
  const streamArchive = new StreamArchive(storage, archiveBudget);
  const detector = controlledDetector();

  let analyses = 0;
  const errors: {error: unknown; ref?: string}[] = [];
  const worker: WorkerPort = {
    analyze: async (request, signal) => {
      analyses++;
      if (options.worker) return options.worker.analyze(request, signal);
      return {
        event_id: request.event_id,
        segment_id: request.segment_id,
        archive_revision: request.archive_revision,
        time_range: request.time_range,
        content: {audio_observations: ['CONTROLLED_BYTE_WORKER']},
        speakers: [],
        warnings: ['CONTROLLED_NOT_MODEL'],
        status: 'partial',
      };
    },
  };
  // These labels isolate policy branches; they do not establish model or physical clock acceptance.
  const capability: Capability = {
    id: 'controlled',
    version: 'fixture',
    modalities: options.av ? ['audio', 'visual'] : ['audio'],
    formats: ['pcm_s16le:16000:1', 'png'],
    joint_av: !!options.av,
    healthy: true,
    permitted: true,
    max_duration_ms: 10_000,
    execution: 'local',
    evidence: options.branchComplete ? 'real_verified' : 'deterministic_replay',
  };
  const processor = new MediaProcessor(storage, new Map([['controlled', worker]]), {
    policy_version: 'continuous-test',
    max_inflight: 1,
    max_input_bytes: 1_000_000,
    timeout_ms: 10_000,
    allow_external: false,
    allow_replay: true,
    allow_partial: !options.strict,
  });
  const service = new MediaService({
    storage,
    archive,
    streamArchive,
    processor,
    capabilities: async () => [capability],
    align: {max_chunks: 100, max_visual_refs: 10, max_frame_gap_ms: 100, max_uncertainty_ms: 2},
    max_segments: 16,
    max_window_ms: 10_000,
    ...(options.authorize ? {authorizeClockMaps: async (_principal, maps) => options.authorize!(maps)} : {}),
    fixtureOnly: true,
    clockEvidence: options.branchComplete ? 'calibrated' : 'synthetic',
    continuous: {
      detector,
      budget,
      onError: (error, ref) => errors.push({error, ...(ref ? {ref} : {})}),
    },
  });
  const native = new ControlledNative();
  const admission = new RunAdmission(storage, native, {
    max_pending_events: 16,
    max_pending_bytes: 1_000_000,
    max_event_age_ms: 100_000,
    poll_interval_ms: 5,
    native_idempotency_retention_ms: 86_400_000,
    policy_version: 'controlled',
  });
  const deviceRecord = {
    principal_id: 'owner',
    device_id: 'mac',
    device_type: 'mac' as const,
    consent_ref: 'fixture',
    channel: 'controlled',
    route_version: 'fixture',
    output_modes: ['text'],
    token_sha256: sha256('token'),
  };
  const journal = await testJournal(t);
  runtime = new PersonalAIOSRuntime({
    storage,
    archive,
    ambient_journal: journal,
    admission,
    native,
    output: new OutputAuthority(storage),
    media: service,
    devices: [deviceRecord],
    skill: 'controlled',
    max_read_bytes: 1_000_000,
    continuous_context: async (_source, _event, chunk) => ({
      session: 'same-continuity',
      clock_maps: [{
        modality: 'audio',
        track_id: chunk.track_id,
        stream_epoch: chunk.stream_epoch,
        source_timebase_id: 'samples',
        target_timebase_id: 'common',
        offset_ms: 0,
        drift_ppm: 0,
        uncertainty_ms: 1,
        basis_ref: 'fixture-clock',
      }, ...structuredClone(options.maps ?? [])],
    }),
  });
  const device = await runtime.authenticate('token');
  const ownedRuntime = runtime;
  const raw = (payload: Buffer): RawEvent => ({
    schema_version: 'paios.event.v1',
    event_id: 'raw',
    device_id: 'mac',
    device_type: 'mac',
    captured_at: '2026-10-02T00:00:00.000Z',
    source: {channel: 'controlled'},
    media_type: options.av ? 'livekit_tracks' : 'audio',
    mime: 'audio/pcm',
    representation: 'received_decoded_sample',
    payload,
  });
  const append = (payload: Buffer, seq: number, start: number) => {
    const chunk: TrackChunk = {
      track_id: 'mic',
      stream_epoch: 'source-epoch',
      seq,
      modality: 'audio',
      format: 'pcm_s16le:16000:1',
      source_range: {
        kind: 'interval',
        timebase_id: 'samples',
        stream_epoch: 'source-epoch',
        start_ms: start / 16,
        end_ms: (start + payload.length / 2) / 16,
      },
    };
    return ownedRuntime.appendMedia(raw(payload), device, chunk);
  };
  const visual = (seq: number, start: number, epoch = 'camera-epoch') => ownedRuntime.appendMedia(
    {...raw(validPng), mime: 'image/png'},
    device,
    {
      track_id: 'camera',
      stream_epoch: epoch,
      seq,
      modality: 'visual',
      format: 'png',
      source_range: {kind: 'instant', timebase_id: 'camera-clock', stream_epoch: epoch, at_ms: start},
    },
  );
  const records = async <T>(namespace: string): Promise<T[]> => Promise.all(
    (await storage.list(namespace)).map(async key => JSON.parse(
      Buffer.from(await storage.read(namespace, key)).toString(),
    )),
  );
  return {storage, runtime: ownedRuntime, native, append, visual, records, errors, analyses: () => analyses};
}

function marker(samples: number, speech: boolean) {
  const pcm = Buffer.alloc(samples * 2);
  if (speech) {
    for (let sample = 0; sample < samples; sample++) pcm.writeInt16LE(1, sample * 2);
  }
  return pcm;
}

const speech = () => Buffer.concat([marker(1_024, true), marker(512, false)]);
const visualMap = (): ClockMap => ({
  modality: 'visual',
  track_id: 'camera',
  stream_epoch: 'camera-epoch',
  source_timebase_id: 'camera-clock',
  target_timebase_id: 'common',
  offset_ms: 32,
  drift_ppm: 1_000,
  uncertainty_ms: 1,
  basis_ref: 'controlled-camera-clock',
});
const completeWorker: WorkerPort = {
  analyze: async request => ({
    ...request,
    content: {audio_observations: ['CONTROLLED_AUDIO']},
    speakers: [],
    warnings: ['CONTROLLED_NOT_MODEL'],
    status: 'complete',
  }),
};

function assertValidFixturePng(bytes: Buffer) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.readUInt32BE(16), 2);
  assert.equal(bytes.readUInt32BE(20), 1);
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  // Fixed two-pixel RGBA fixture, filter byte0, red then blue; this is not a general image/model decoder.
  assert.deepEqual([...inflateSync(Buffer.concat(compressed))], [0, 255, 0, 0, 255, 0, 0, 255, 255]);
}

test('missing clock preserves audio and identifies unknown visual alignment', async t => {
  const f = await fixture(t, {av: true});
  await f.visual(0, 100000);
  await f.append(speech(), 0, 0);
  await f.runtime.continuousMedia().drain();
  assert.deepEqual(f.errors, []);
  await until(async () => (await f.storage.list('media-continuous-admitted')).length === 1);
  const [d] = await f.records<ProcessedEvent>('processed-media');
  assert(d);
  assert.equal(d.coverage.status, 'partial');
  assert.equal(d.quality.status, 'partial');
  assert(d.content.audio_observations);
  assert.equal(d.content.visual_observations, undefined);
  assert.deepEqual(d.coverage.missing_ranges, []);
  assert.deepEqual(d.coverage.missing_by_track, []);
  assert.equal(d.coverage.alignment_uncertainty_ms, undefined);
  const warnings = d.quality.warnings.filter(w => w.startsWith(diagnostic));
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0]!.slice(diagnostic.length)), {
    reason: 'clock_map_missing',
    track_id: 'camera',
    stream_epoch: 'camera-epoch',
    source_timebase_id: 'camera-clock',
    aligned_range: 'unknown',
  });
  const candidate = (await f.records<ContinuousCandidate>('media-continuous-candidates'))[0]!;
  const views = await f.records<{archive_revision: string; views: {chunk: {modality: string}}[]}>
    ('media-views');
  assert(views.every(v => v.archive_revision === candidate.event.archive_revision
    && v.views.every(view => view.chunk.modality === 'audio')));
  const before = structuredClone(d);
  await f.visual(1, 1);
  await f.append(speech(), 0, 0);
  const key = (await f.storage.list('media-continuous-candidates'))[0]!;
  await f.runtime.continuousMedia().retry(`l5-continuous:${key}`);
  await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(), 1);
  assert.equal(f.native.calls, 0);
  assert.deepEqual((await f.records<ProcessedEvent>('processed-media'))[0], before);
});

test('strict partial policy rejects missing clock and accepts controlled complete pure audio', async t => {
  // These capability and clock labels test policy branches, not actual model/physical clock acceptance.
  const pure = await fixture(t, {strict: true, branchComplete: true, worker: completeWorker});
  await pure.append(speech(), 0, 0);
  await pure.runtime.continuousMedia().drain();
  assert.deepEqual(pure.errors, []);
  const [audio] = await pure.records<ProcessedEvent>('processed-media');
  assert(audio);
  assert.equal(audio.quality.status, 'complete');
  assert(!audio.quality.warnings.some(w => w.startsWith(diagnostic)));
  const f = await fixture(t, {av: true, strict: true, branchComplete: true, worker: completeWorker});
  await f.visual(0, 0);
  await f.append(speech(), 0, 0);
  await f.runtime.continuousMedia().drain();
  assert.equal(f.native.calls, 0);
  assert.equal((await f.storage.list('processed-media')).length, 0);
  assert(f.errors.some(item => String(item.error).includes('MEDIA_PARTIAL_NOT_ACCEPTED')));
});

test('mapped AV uses continuous SOURCE and preserves valid original PNG bytes at Worker', async t => {
  const requests: WorkerRequest[] = [];
  const f = await fixture(t, {
    av: true,
    maps: [visualMap()],
    worker: {
      analyze: async request => {
        requests.push(structuredClone(request));
        return {
          ...request,
          content: {audio_observations: ['audio'], visual_observations: ['visual']},
          speakers: [],
          warnings: ['CONTROLLED'],
          status: 'partial',
        };
      },
    },
  });
  await f.visual(0, 0);
  await f.append(speech(), 0, 0);
  await f.runtime.continuousMedia().drain();
  assert.deepEqual(f.errors, []);
  const [c] = await f.records<ContinuousCandidate>('media-continuous-candidates');
  assert(c);
  assert.equal(c.context.clock_maps.length, 2);
  assert.deepEqual(requests[0]!.views.map(v => v.modality), ['audio', 'visual']);
  assert.equal(requests[0]!.archive_revision, c.event.archive_revision);
  assert(Buffer.from(requests[0]!.views[1]!.bytes).equals(validPng));
  assertValidFixturePng(validPng);
  const [d] = await f.records<ProcessedEvent>('processed-media');
  assert(d);
  assert(d.content.visual_observations);
  assert(!d.quality.warnings.some(w => w.startsWith(diagnostic)));
});

test('supplied invalid and foreign clock maps remain denied at original owners', async t => {
  const invalid = await fixture(t, {
    av: true,
    maps: [{...visualMap(), source_timebase_id: 'wrong-source-clock'}],
  });
  await invalid.visual(0, 0);
  await invalid.append(speech(), 0, 0);
  await invalid.runtime.continuousMedia().drain();
  assert.equal(invalid.native.calls, 0);
  assert(invalid.errors.some(item => String(item.error).includes('CLOCK_MAP_INVALID')));
  let calls = 0;
  const foreign = await fixture(t, {
    av: true,
    maps: [{...visualMap(), basis_ref: 'foreign-basis'}],
    authorize: async maps => {
      calls++;
      assert(maps.some(map => map.basis_ref === 'foreign-basis'));
      throw new Error('CONTROLLED_SOURCE_CLOCK_BASIS_DENIED');
    },
  });
  await foreign.visual(0, 0);
  await foreign.append(speech(), 0, 0);
  await foreign.runtime.continuousMedia().drain();
  assert.equal(calls, 1);
  assert.equal(foreign.native.calls, 0);
  assert(foreign.errors.some(item => String(item.error).includes('BASIS_DENIED')));
});

test('queued candidates retain their own map scope while an earlier candidate is still processing', async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let entered = false;
  const maps: ClockMap[] = [];
  const requests: WorkerRequest[] = [];
  const f = await fixture(t, {
    av: true,
    maps,
    worker: {
      analyze: async request => {
        entered = true;
        await gate.promise;
        requests.push(structuredClone(request));
        return {
          ...request,
          content: {audio_observations: ['controlled']},
          speakers: [],
          warnings: [],
          status: 'partial',
        };
      },
    },
  });
  await f.visual(0, 0);
  await f.append(speech(), 0, 0);
  await until(() => entered);
  maps.push(visualMap());
  await f.visual(1, 80);
  await f.append(speech(), 1, 1536);
  await until(async () => (await f.storage.list('media-continuous-candidates')).length === 2);
  const candidates = await f.records<ContinuousCandidate>('media-continuous-candidates');
  assert.deepEqual(candidates.map(c => c.context.clock_maps.length).sort(), [1, 2]);
  assert.equal(new Set(candidates.map(c => c.detection_epoch)).size, 1);
  gate.resolve();
  await f.runtime.continuousMedia().drain();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(requests.map(request => request.views.map(view => view.modality)),
    [['audio'], ['audio', 'visual']]);
  const ds = await f.records<ProcessedEvent>('processed-media');
  assert.equal(ds.length, 2);
  assert.equal(ds.filter(d => d.quality.warnings.some(w => w.startsWith(diagnostic))).length, 1);
  assert.equal((await f.storage.list('media-continuous-admitted')).length, 2);
  assert.equal(f.native.calls, 0);
  assert.equal(f.analyses(), 2);
  assert.equal((await f.storage.list('media-continuous-candidates')).length, 2);
});
