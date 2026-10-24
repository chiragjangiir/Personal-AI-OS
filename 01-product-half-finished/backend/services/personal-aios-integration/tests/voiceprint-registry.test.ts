import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import { PosixStorage } from '../src/storage.ts';
import { VoiceprintRegistry, decodeEmbedding, deviceChannel, encodeEmbedding, type SpeakerModel } from '../src/voiceprint/registry.ts';
import { digest } from '../src/contracts.ts';
import {DatabaseSync} from 'node:sqlite';
import {getLoadablePath} from 'sqlite-vec';
import {VisualMemory} from '../src/visual/store.ts';
import { CALL_INTERRUPT_MIN_SPEECH_MS, parseSpeakerLabel, speakerLabel } from '../src/voiceprint/contracts.ts';

const DIM = 32;
const MODEL: SpeakerModel = {id: 'eres2netv2-test', sha256: 'a'.repeat(64), dim: DIM};
const AT = '2026-10-09T08:00:00.000Z';
// Deterministic synthetic voices: a vector at an exact cosine to a base direction.
function rng(seed: number) {let x = seed >>> 0 || 1; return () => {x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296) - 0.5;};}
function unit(v: Float32Array) {const n = Math.hypot(...v); return Float32Array.from(v, x => x / n);}
function voice(seed: number) {const r = rng(seed); return unit(Float32Array.from({length: DIM}, r));}
function near(base: Float32Array, cosine: number, seed: number) {
  const r = rng(seed * 7919 + 1), noise = Float32Array.from({length: DIM}, r);
  const along = noise.reduce((s, x, i) => s + x * base[i]!, 0);
  const orthogonal = unit(Float32Array.from(noise, (x, i) => x - along * base[i]!));
  return Float32Array.from(base, (b, i) => cosine * b + Math.sqrt(1 - cosine * cosine) * orthogonal[i]!);
}
const samples = (base: Float32Array, n: number, cosine = 0.95, seed = 1) =>
  Array.from({length: n}, (_, i) => ({embedding: near(base, cosine, seed + i), speech_ms: 2500}));
async function setup(t: test.TestContext, options: ConstructorParameters<typeof VoiceprintRegistry>[2] = {}, model = MODEL, frameIds: string[] = []) {
  const root = await fs.mkdtemp(join(tmpdir(), 'paios-voiceprint-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const storage = new PosixStorage(root);
  const frameStore = frameIds.length ? await VisualMemory.open(join(root,'visual'), {
    embedImage:async()=>[],embedQuery:async()=>[],describe:async()=>({caption:'',ocr:''})}) : undefined;
  const frameDb = frameStore ? new DatabaseSync(join(root,'visual','visual.sqlite'),{allowExtension:true}) : undefined;
  if(frameDb){
    frameDb.loadExtension(getLoadablePath());frameDb.exec('PRAGMA foreign_keys=ON');
    const insert=frameDb.prepare("INSERT INTO frames(principal_id,device_id,frame_id,captured_ms,original,thumbnail,signature,keyframe,bytes,state,frame_key) VALUES('owner','fixture',?,0,'','',?,0,0,'indexing',?)");
    for(const frame of frameIds)insert.run(frame,Buffer.alloc(64),frame);
    frameDb.exec("UPDATE frames SET state='ready'");
    t.after(async()=>{frameDb.close();await frameStore!.close();});
  }
  const open = (m = model, o = options) => {const registry=new VoiceprintRegistry(storage,m,o);registry.setVisualMemory(frameStore);return registry;};
  return {root, storage, open, registry: open(), frameDb, frameStore};
}
const observe = (speech_ms = 2500, observed_at = AT) => ({speech_ms, observed_at, mode: 'observe' as const});
const verify = (speech_ms = 2500) => ({speech_ms, observed_at: AT, mode: 'verify' as const});

test('labels round-trip and nothing else parses as a voiceprint label', () => {
  for (const identity of [{kind: 'owner', band: 'verified', score: 0.9}, {kind: 'owner', band: 'uncertain', score: 0.5},
    {kind: 'speaker', cluster_id: '12', score: 0.8}, {kind: 'assistant', score: 0.7}] as const) assert.ok(parseSpeakerLabel(speakerLabel(identity)));
  assert.deepEqual(parseSpeakerLabel('assistant'), {kind: 'assistant'});
  for (const label of ['SPEAKER_00', 'owner ', 'speaker:', 'speaker:../x', 'Owner', 1]) assert.equal(parseSpeakerLabel(label), undefined);
  const vector = voice(3);
  assert.deepEqual(decodeEmbedding(encodeEmbedding(vector), DIM), vector);
  assert.throws(() => decodeEmbedding(encodeEmbedding(vector), DIM + 1), /VOICEPRINT_EMBEDDING_INVALID/);
});

test('owner bands follow the thresholds; short, degenerate and wrong-model input never identifies', async t => {
  const {registry} = await setup(t);
  const owner = voice(1);
  const enrolled = await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 5), at: AT});
  assert.equal(enrolled.enrolled, true); assert.equal(enrolled.samples, 5); assert.ok(enrolled.consistency!.min > 0.9);
  const verified = await registry.identify(near(owner, 0.8, 50), verify());
  assert.equal(verified.kind, 'owner'); assert.equal(verified.kind === 'owner' && verified.band, 'verified');
  const uncertain = await registry.identify(near(owner, 0.55, 51), verify());
  assert.deepEqual([uncertain.kind, uncertain.kind === 'owner' && uncertain.band], ['owner', 'uncertain']);
  assert.deepEqual(await registry.identify(near(owner, 0.2, 52), verify()), {kind: 'unknown', reason: 'unmatched'});
  assert.deepEqual(await registry.identify(near(owner, 0.99, 53), verify(999)), {kind: 'unknown', reason: 'too_short'});
  assert.deepEqual(await registry.identify(new Float32Array(DIM), verify()), {kind: 'unknown', reason: 'low_quality'});
  await assert.rejects(registry.identify(new Float32Array(DIM + 1), verify()), /VOICEPRINT_EMBEDDING_INVALID/);
  await assert.rejects(registry.identify(owner, {speech_ms: 2000, observed_at: 'yesterday', mode: 'verify'}), /INVALID_CAPTURED_AT/);
  // Threshold configuration moves the bands.
  const strict = new VoiceprintRegistry((registry as unknown as {storage: PosixStorage}).storage, MODEL, {policy: {thresholds: {owner_verified: 0.9, owner_uncertain: 0.7}}});
  const strictBand = await strict.identify(near(owner, 0.8, 50), verify());
  assert.equal(strictBand.kind === 'owner' && strictBand.band, 'uncertain');
  assert.throws(() => new VoiceprintRegistry((registry as unknown as {storage: PosixStorage}).storage, MODEL,
    {policy: {thresholds: {owner_verified: 0.4, owner_uncertain: 0.6}}}), /VOICEPRINT_THRESHOLDS_INVALID/);
});

test('enrollment needs five consistent utterances of at least 1.5 s from the configured speaker model', async t => {
  const {registry} = await setup(t);
  const owner = voice(1), other = voice(2);
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 4)}), /VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES/);
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace',
    samples: [...samples(owner, 4), {embedding: near(owner, 0.95, 9), speech_ms: 1400}]}), /VOICEPRINT_ENROLLMENT_SAMPLE_TOO_SHORT/);
  await assert.rejects(registry.enrollOwner({speaker_model: {...MODEL, sha256: 'b'.repeat(64)}, channel: 'file', mode: 'replace', samples: samples(owner, 5)}),
    (error: Error & {status?: number}) => error.message === 'VOICEPRINT_SPEAKER_MODEL_MISMATCH' && error.status === 409);
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: [...samples(owner, 4), ...samples(other, 1, 0.95, 40)]}),
    (error: Error & {sample_consistency?: number[]}) => error.message === 'VOICEPRINT_ENROLLMENT_INCONSISTENT' &&
      error.sample_consistency!.length === 5 && error.sample_consistency![4]! < 0.6 && error.sample_consistency![0]! > 0.6);
  assert.equal((await registry.owner()).enrolled, false);
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'add', samples: samples(owner, 2)}), /VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES/);
  await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 5), at: AT});
  const added = await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'add', samples: samples(owner, 2, 0.95, 20), at: '2026-10-09T09:00:00.000Z'});
  assert.deepEqual([added.samples, added.enrolled_at, added.updated_at], [7, AT, '2026-10-09T09:00:00.000Z']);
  const forgotten = await registry.forgetOwner();
  assert.equal(forgotten.enrolled, false);
  assert.deepEqual(await registry.identify(near(owner, 0.9, 60), verify()), {kind: 'unknown', reason: 'no_enrollment'});
});

test('other voices: observe creates and updates numbered clusters, verify never mutates, the owner is never claimed', async t => {
  const {registry} = await setup(t);
  const a = voice(11), b = voice(12);
  // No owner enrolled: others still cluster.
  const first = await registry.identify(near(a, 0.95, 1), observe());
  assert.deepEqual(first, {kind: 'speaker', cluster_id: '1', score: 1});
  const again = await registry.identify(near(a, 0.95, 2), observe(3000, '2026-10-09T08:05:00.000Z'));
  assert.equal(again.kind === 'speaker' && again.cluster_id, '1');
  // Under 2 s speech, or in verify mode, nothing is created.
  assert.deepEqual(await registry.identify(near(b, 0.95, 3), observe(1500)), {kind: 'unknown', reason: 'no_enrollment'});
  const before = await registry.clusters();
  assert.deepEqual(await registry.identify(near(b, 0.95, 4), verify()), {kind: 'unknown', reason: 'no_enrollment'});
  const known = await registry.identify(near(a, 0.95, 5), verify());
  assert.equal(known.kind === 'speaker' && known.cluster_id, '1');
  assert.deepEqual(await registry.clusters(), before);
  assert.deepEqual([before[0]!.count, before[0]!.speech_ms, before[0]!.last_seen, before[0]!.label], [2, 5500, '2026-10-09T08:05:00.000Z', '说话人#1']);
  const second = await registry.identify(near(b, 0.95, 6), observe());
  assert.equal(second.kind === 'speaker' && second.cluster_id, '2');
});

test('rename, merge and forget; numbers are never reused', async t => {
  const {registry, open} = await setup(t);
  const a = voice(21), b = voice(22), c = voice(23);
  await registry.identify(near(a, 0.95, 1), observe());
  await registry.identify(near(b, 0.95, 2), observe());
  const named = await registry.renameCluster('1', {display_name: ' 老王 ', known_person_id: 'person:wang'});
  assert.deepEqual([named.label, named.display_name, named.known_person_id], ['老王', '老王', 'person:wang']);
  const heard = await registry.identify(near(a, 0.95, 3), verify());
  assert.deepEqual(heard.kind === 'speaker' && [heard.cluster_id, heard.display_name], ['1', '老王']);
  const before = await registry.clusters();
  await assert.rejects(registry.renameCluster('1', {display_name: ''}, '2'), /VOICEPRINT_DISPLAY_NAME_INVALID/);
  await assert.rejects(registry.renameCluster('1', {known_person_id: '../person'}, '2'), /INVALID_ID/);
  const reopened = open();
  assert.deepEqual(await reopened.clusters(), before, 'rejected merge-and-name preserves both persisted people');
  await reopened.close();
  await assert.rejects(registry.renameCluster('1', {display_name: ''}), /VOICEPRINT_DISPLAY_NAME_INVALID/);
  await assert.rejects(registry.renameCluster('9', {display_name: 'x'}), /VOICEPRINT_CLUSTER_NOT_FOUND/);
  assert.equal((await registry.renameCluster('1', {known_person_id: null})).known_person_id, null);
  const merged = await registry.mergeClusters('1', '2');
  assert.deepEqual([merged.cluster_id, merged.count, merged.label], ['1', 2, '老王']);
  assert.deepEqual((await registry.clusters()).map(cluster => cluster.cluster_id), ['1']);
  await assert.rejects(registry.mergeClusters('1', '1'), /VOICEPRINT_MERGE_INVALID/);
  const third = await registry.identify(near(c, 0.95, 4), observe());
  assert.equal(third.kind === 'speaker' && third.cluster_id, '3');
  assert.deepEqual(await registry.forgetCluster('3'), {forgotten: '3'});
  assert.deepEqual((await registry.clusters()).map(cluster => cluster.cluster_id), ['1']);
});

test('cluster storage is bounded: the least recently heard unnamed profile is evicted, named ones never', async t => {
  const {registry} = await setup(t, {policy: {max_clusters: 2}});
  await registry.identify(near(voice(31), 0.95, 1), observe(2500, '2026-10-09T08:00:00.000Z'));
  await registry.identify(near(voice(32), 0.95, 2), observe(2500, '2026-10-09T08:01:00.000Z'));
  await registry.identify(near(voice(33), 0.95, 3), observe(2500, '2026-10-09T08:02:00.000Z'));
  assert.deepEqual((await registry.clusters()).map(cluster => cluster.cluster_id).sort(), ['2', '3']);
  await registry.renameCluster('2', {display_name: '小李'}); await registry.renameCluster('3', {display_name: '小张'});
  assert.deepEqual(await registry.identify(near(voice(34), 0.95, 4), observe()), {kind: 'unknown', reason: 'no_enrollment'});
  assert.equal((await registry.clusters()).length, 2);
});

test('an uncertain-band voice that matches a known person better is that person; enrollment absorbs owner clusters', async t => {
  const {registry} = await setup(t);
  const owner = voice(41);
  // Ambient speech of the owner before enrollment formed a cluster; a similar-sounding friend has their own.
  await registry.identify(near(owner, 0.97, 1), observe());
  const friend = near(owner, 0.5, 77);
  await registry.identify(near(friend, 0.97, 2), observe());
  const enrolled = await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 5), at: AT});
  assert.deepEqual(enrolled.absorbed_clusters, ['1']);
  const heard = await registry.identify(near(friend, 0.95, 3), observe());
  assert.equal(heard.kind, 'speaker');
  // Owner-adjacent speech never moves another person's centroid.
  const clusters = await registry.clusters();
  assert.equal(clusters.find(cluster => cluster.cluster_id === '2')!.count, 1);
});

test('persistence: owner-only files, atomic replace, write-behind flush, durable creation and model mismatch', async t => {
  const {root, storage, open, registry} = await setup(t, {policy: {flush_ms: 3600000}});
  const owner = voice(51), a = voice(52);
  await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 5), at: AT});
  await registry.identify(near(a, 0.95, 1), observe());
  const dir = join(root, 'voiceprints'), files = await fs.readdir(dir);
  assert.equal(files.length, 1); assert.match(files[0]!, /^[a-f0-9]{64}$/u);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(dir, files[0]!))).mode & 0o777, 0o600);
  // Creation is durable at once; a centroid update waits for the flush.
  assert.equal((await open().clusters())[0]!.count, 1);
  await registry.identify(near(a, 0.95, 2), observe());
  assert.equal((await open().clusters())[0]!.count, 1);
  await registry.close();
  assert.equal((await open().clusters())[0]!.count, 2);
  await assert.rejects(registry.identify(owner, verify()), /VOICEPRINT_REGISTRY_CLOSED/);
  const document = JSON.parse(await fs.readFile(join(dir, files[0]!), 'utf8'));
  assert.equal(document.schema, 'paios.voiceprint.registry.v2');
  assert.deepEqual(document.owner_sets.map((set: {channel: string; samples: unknown[]}) => [set.channel, set.samples.length]), [['file', 5]]);
  // Another speaker model: every stored embedding is invalid until re-enrolled; names and history stay listable.
  const other = open({...MODEL, sha256: 'c'.repeat(64)});
  const status = await other.owner();
  assert.deepEqual([status.enrolled, status.reenrollment_required], [false, true]);
  assert.deepEqual(await other.identify(near(owner, 0.95, 3), verify()), {kind: 'unknown', reason: 'no_enrollment'});
  assert.equal((await other.clusters())[0]!.stale_model, true);
  await assert.rejects(other.enrollOwner({speaker_model: {...MODEL, sha256: 'c'.repeat(64)}, channel: 'file', mode: 'add', samples: samples(owner, 1)}),
    /VOICEPRINT_REENROLLMENT_REQUIRED/);
  const reenrolled = await other.enrollOwner({speaker_model: {...MODEL, sha256: 'c'.repeat(64)}, channel: 'file', mode: 'replace', samples: samples(owner, 5)});
  assert.equal(reenrolled.enrolled, true);
  // A stale profile never matches; new speech of that voice gets a fresh number.
  const fresh = await other.identify(near(a, 0.95, 4), observe());
  assert.equal(fresh.kind === 'speaker' && fresh.cluster_id, '2');
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('.pending-')).length, 0);
  await fs.writeFile(join(dir, files[0]!), '{"schema":"other"}');
  await assert.rejects(open().owner(), /VOICEPRINT_REGISTRY_CORRUPT/);
});

test('concurrent identify calls serialize: one new voice heard twice at once creates one cluster', async t => {
  const {registry} = await setup(t);
  const a = voice(61);
  const results = await Promise.all([registry.identify(near(a, 0.95, 1), observe()), registry.identify(near(a, 0.95, 2), observe()),
    registry.identify(near(a, 0.95, 3), observe())]);
  assert.deepEqual(results.map(result => result.kind === 'speaker' && result.cluster_id), ['1', '1', '1']);
  assert.equal((await registry.clusters()).length, 1);
});

test('the assistant\'s own voice: learned from its outgoing speech, never the owner, a person or a cluster; short speech too', async t => {
  const {registry, open} = await setup(t, {policy: {flush_ms: 3600000}});
  const owner = voice(71), tts = voice(72), call = voice(73), stranger = voice(74);
  await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 5), at: AT});
  assert.deepEqual(await registry.identify(near(tts, 0.9, 1), observe(600)), {kind: 'unknown', reason: 'too_short'}, 'no profile yet');
  const created = await registry.observeAssistant({voice: 'system_tts', embedding: near(tts, 0.97, 2), speech_ms: 3000, at: AT});
  assert.deepEqual([created.voice, created.count, created.stale_model], ['system_tts', 1, false]);
  await registry.observeAssistant({voice: 'system_tts', embedding: near(tts, 0.97, 3), speech_ms: 3000, at: '2026-10-09T08:01:00.000Z'});
  // A reply heard back: labelled assistant in ambient listening and in a turn, at full length or short; no cluster grows.
  for (const input of [observe(), observe(600), verify()]) {
    const heard = await registry.identify(near(tts, 0.7, 10 + input.speech_ms), input);
    assert.equal(heard.kind, 'assistant'); assert.ok(heard.kind === 'assistant' && heard.score >= 0.5);
  }
  assert.deepEqual(await registry.clusters(), []);
  // Below the floor nothing is checked; the owner and other people keep their own rules (short owner speech stays too short).
  assert.deepEqual(await registry.identify(near(tts, 0.95, 20), observe(399)), {kind: 'unknown', reason: 'too_short'});
  assert.deepEqual(await registry.identify(near(owner, 0.9, 21), observe(600)), {kind: 'unknown', reason: 'too_short'});
  assert.equal((await registry.identify(near(owner, 0.9, 22), verify())).kind, 'owner');
  assert.equal((await registry.identify(near(stranger, 0.95, 23), observe())).kind, 'speaker');
  // A voice between the owner and the assistant that is nearer the owner is never the assistant.
  const between = Float32Array.from(owner, (o, i) => 0.75 * o + 0.6 * tts[i]!);
  assert.notEqual((await registry.identify(between, verify())).kind, 'assistant');
  // Each source keeps its own profile; a sample that does not sound like its profile restarts it (the voice was changed).
  await registry.observeAssistant({voice: 'realtime_call', embedding: near(call, 0.97, 30), speech_ms: 2000, at: AT});
  assert.equal((await registry.identify(near(call, 0.75, 31), observe())).kind, 'assistant');
  const changed = await registry.observeAssistant({voice: 'system_tts', embedding: near(stranger, 0.97, 32), speech_ms: 2000,
    at: '2026-10-09T08:02:00.000Z'});
  assert.equal(changed.count, 1);
  assert.notEqual((await registry.identify(near(tts, 0.7, 33), verify())).kind, 'assistant');
  await assert.rejects(registry.observeAssistant({voice: 'System TTS', embedding: tts, speech_ms: 2000}), /VOICEPRINT_ASSISTANT_VOICE_INVALID/);
  await assert.rejects(registry.observeAssistant({voice: 'system_tts', embedding: tts, speech_ms: 1000}), /VOICEPRINT_ENROLLMENT_SAMPLE_TOO_SHORT/);
  await assert.rejects(registry.observeAssistant({voice: 'system_tts', embedding: new Float32Array(DIM), speech_ms: 2000}), /VOICEPRINT_EMBEDDING_INVALID/);
  // A new profile is durable at once; another speaker model never matches it.
  assert.deepEqual((await open().assistantVoices()).map(v => [v.voice, v.count]), [['realtime_call', 1], ['system_tts', 1]]);
  const other = open({...MODEL, sha256: 'c'.repeat(64)});
  assert.deepEqual((await other.assistantVoices()).map(v => v.stale_model), [true, true]);
  assert.notEqual((await other.identify(near(call, 0.9, 34), observe())).kind, 'assistant');
});

test('assistant profiles are bounded and absorb ambient clusters of their voice formed before them', async t => {
  const {registry} = await setup(t, {policy: {max_assistant_voices: 2}});
  const tts = voice(81), friend = voice(82);
  const early = await registry.identify(near(tts, 0.95, 1), observe());
  const named = await registry.identify(near(friend, 0.95, 2), observe());
  assert.deepEqual([early.kind, named.kind], ['speaker', 'speaker']);
  await registry.renameCluster('2', {display_name: '小李'});
  await registry.observeAssistant({voice: 'system_tts', embedding: near(tts, 0.97, 3), speech_ms: 2000, at: AT});
  assert.deepEqual((await registry.clusters()).map(c => c.cluster_id), ['2'], 'the unnamed cluster of the assistant\'s voice is gone');
  assert.equal((await registry.identify(near(tts, 0.9, 4), observe())).kind, 'assistant');
  await registry.observeAssistant({voice: 'realtime_call', embedding: voice(83), speech_ms: 2000, at: '2026-10-09T08:01:00.000Z'});
  await registry.observeAssistant({voice: 'other_source', embedding: voice(84), speech_ms: 2000, at: '2026-10-09T08:02:00.000Z'});
  assert.deepEqual((await registry.assistantVoices()).map(v => v.voice), ['realtime_call', 'other_source']);
});

test('a wake turn identified with its short request verifies the owner only if the request alone sounds like the owner', async t => {
  const {registry} = await setup(t);
  const owner = voice(91), other = voice(92), turn = near(owner, 0.85, 1);
  await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(owner, 5), at: AT});
  const turnOf = (request: Float32Array | null, speech_ms?: number) =>
    registry.identify(turn, {...verify(1100), request: {embedding: request, ...(speech_ms === undefined ? {} : {speech_ms})}});
  assert.deepEqual([(await turnOf(near(owner, 0.6, 2))).kind, (await turnOf(near(owner, 0.6, 2)) as {band: string}).band], ['owner', 'verified']);
  // The owner's wake word lending its voice to someone else's request, or a request too short to embed: in doubt.
  for (const request of [near(other, 0.95, 3), near(owner, 0.3, 4), null])
    assert.deepEqual(await turnOf(request), {kind: 'owner', band: 'uncertain', score: (await registry.identify(turn, verify(1100)) as {score: number}).score});
  // Below the verified band the request changes nothing; ambient listening never carries one.
  assert.deepEqual(await registry.identify(near(owner, 0.55, 5), {...verify(), request: {embedding: null}}),
    await registry.identify(near(owner, 0.55, 5), verify()));
  // Such a turn may be shorter than a plain identification (wake word + "关灯" is under a second), not shorter than its floor.
  assert.deepEqual(await registry.identify(turn, verify(900)), {kind: 'unknown', reason: 'too_short'});
  assert.equal((await registry.identify(turn, {...verify(900), request: {embedding: near(owner, 0.6, 2)}})).kind, 'owner');
  assert.deepEqual(await registry.identify(turn, {...verify(799), request: {embedding: near(owner, 0.6, 2)}}), {kind: 'unknown', reason: 'too_short'});
  // The request alone counts from 0.4 s of speech (min_assistant_ms); shorter, it cannot vouch for the voice.
  assert.equal((await turnOf(near(owner, 0.6, 2), 399) as {band: string}).band, 'uncertain');
  assert.equal((await turnOf(near(owner, 0.6, 2), 400) as {band: string}).band, 'verified');
  await assert.rejects(registry.identify(turn, {...verify(1100), request: {embedding: null, speech_ms: -1}}), /VOICEPRINT_IDENTIFY_INPUT_INVALID/);
  await assert.rejects(registry.identify(turn, {...observe(), request: {embedding: null}}), /VOICEPRINT_IDENTIFY_INPUT_INVALID/);
  await assert.rejects(registry.identify(turn, {...verify(), request: {embedding: new Float32Array(3)}}), /VOICEPRINT_IDENTIFY_INPUT_INVALID/);
});

test('owner channel sets: each capture channel enrolls and is judged on its own; the owner scores as the best set', async t => {
  const {registry, open} = await setup(t);
  // The owner's voice through two capture chains that move its embedding apart (the field: 0.42 between Voice Memos and
  // the app's LiveKit audio).
  const file = voice(101), phone = near(file, 0.42, 102);
  await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: samples(file, 5), at: AT});
  // Heard through the app before the app set exists: below the uncertain floor, so ambient listening made it a new person.
  const before = await registry.identify(near(phone, 0.97, 1), observe());
  assert.deepEqual([before.kind, before.kind === 'speaker' && before.cluster_id], ['speaker', '1']);
  assert.equal((await registry.identify(near(phone, 0.95, 2), verify())).kind, 'speaker');
  // One set never mixes channels: both channels' utterances together are refused as inconsistent.
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace',
    samples: [...samples(file, 3, 0.95, 20), ...samples(phone, 2, 0.95, 30)]}), /VOICEPRINT_ENROLLMENT_INCONSISTENT/);
  // Enrolling in the app adds its own set and absorbs the owner's mislabelled cluster.
  const app = await registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace', samples: samples(phone, 5, 0.95, 40),
    at: '2026-10-09T09:00:00.000Z'});
  assert.deepEqual(app.absorbed_clusters, ['1']); assert.deepEqual(await registry.clusters(), []);
  assert.deepEqual([app.enrolled, app.samples, app.enrolled_at], [true, 5, '2026-10-09T09:00:00.000Z'], 'the status is the channel\'s');
  assert.deepEqual(app.channels.map(c => [c.channel, c.samples, c.stale_model]), [['file', 5, false], ['phone_app', 5, false]]);
  for (const heard of [near(phone, 0.85, 3), near(file, 0.85, 4)]) {
    const identity = await registry.identify(heard, verify());
    assert.deepEqual([identity.kind, identity.kind === 'owner' && identity.band], ['owner', 'verified']);
  }
  // A wake turn's request check also takes the best set.
  const turn = await registry.identify(near(phone, 0.85, 5), {...verify(1100), request: {embedding: near(phone, 0.6, 6)}});
  assert.equal(turn.kind === 'owner' && turn.band, 'verified');
  // Re-enrolling one channel replaces only that channel's set; `add` extends it.
  await registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace', samples: samples(phone, 6, 0.95, 50), at: '2026-10-09T10:00:00.000Z'});
  const added = await registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'add', samples: samples(file, 1, 0.95, 60), at: '2026-10-09T11:00:00.000Z'});
  assert.deepEqual([added.samples, added.enrolled_at, added.updated_at], [6, AT, '2026-10-09T11:00:00.000Z']);
  const whole = await open().owner();
  assert.deepEqual([whole.enrolled, whole.samples, whole.enrolled_at, whole.updated_at], [true, 12, AT, '2026-10-09T11:00:00.000Z']);
  assert.deepEqual(whole.channels.map(c => [c.channel, c.samples]), [['file', 6], ['phone_app', 6]]);
  assert.deepEqual([(await registry.owner('glasses')).enrolled, (await registry.owner('glasses')).samples], [false, 0]);
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'glasses', mode: 'add', samples: samples(file, 1)}), /VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES/);
  await assert.rejects(registry.enrollOwner({speaker_model: MODEL, channel: 'bluetooth' as 'file', mode: 'replace', samples: samples(file, 5)}),
    /VOICEPRINT_CHANNEL_INVALID/);
  await assert.rejects(registry.owner('bluetooth' as 'file'), /VOICEPRINT_CHANNEL_INVALID/);
  assert.deepEqual([deviceChannel('phone'), deviceChannel('glasses')], ['phone_app', 'glasses']);
  assert.equal(deviceChannel('mac'), 'mac');
  assert.throws(() => deviceChannel('watch'), /VOICEPRINT_CHANNEL_INVALID/);
  // "忘记我的声音" forgets every channel.
  const forgotten = await registry.forgetOwner();
  assert.deepEqual([forgotten.enrolled, forgotten.channels], [false, []]);
  assert.deepEqual(await registry.identify(near(phone, 0.9, 7), verify()), {kind: 'unknown', reason: 'no_enrollment'});
});

test('a v1 document (one owner profile) migrates in place: its samples are the file channel\'s set', async t => {
  const {root, storage, open} = await setup(t, {policy: {flush_ms: 3600000}});
  const owner = voice(111), stranger = voice(112), enrolled = samples(owner, 5);
  const v1 = {schema: 'paios.voiceprint.registry.v1', revision: 7, next_number: 2,
    owner: {model: MODEL, samples: enrolled.map(s => ({embedding: encodeEmbedding(s.embedding), speech_ms: s.speech_ms, added_at: AT})),
      centroid: encodeEmbedding(unit(enrolled.reduce((sum, s) => sum.map((x, i) => x + s.embedding[i]!), new Float32Array(DIM)))),
      enrolled_at: AT, updated_at: AT, consistency: {min: 0.9, mean: 0.95}},
    clusters: [{cluster_id: '1', model_sha256: MODEL.sha256, centroid: encodeEmbedding(stranger), count: 3, speech_ms: 5710, created_at: AT, last_seen: AT}],
    assistant: [{voice: 'system_tts', model_sha256: MODEL.sha256, centroid: encodeEmbedding(voice(113)), count: 1, speech_ms: 3000, created_at: AT, last_seen: AT}]};
  await storage.replace!('voiceprints', digest('paios.voiceprint.registry.v1'), Buffer.from(JSON.stringify(v1)));
  const registry = open(), status = await registry.owner();
  assert.deepEqual([status.enrolled, status.samples, status.consistency], [true, 5, {min: 0.9, mean: 0.95}]);
  assert.deepEqual(status.channels.map(c => [c.channel, c.samples, c.enrolled_at]), [['file', 5, AT]]);
  assert.equal((await registry.identify(near(owner, 0.85, 1), verify())).kind, 'owner');
  assert.equal((await registry.identify(near(stranger, 0.9, 2), verify())).kind, 'speaker');
  const file = join(root, 'voiceprints', (await fs.readdir(join(root, 'voiceprints')))[0]!);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).schema, 'paios.voiceprint.registry.v1', 'load preserves deployed plaintext until a durable mutation');
  // The next durable change keeps the same plaintext document under the same key.
  await registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace', samples: samples(near(owner, 0.42, 3), 5), at: AT});
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual([written.schema, written.revision, written.owner, written.next_number], ['paios.voiceprint.registry.v2', 8, undefined, 2]);
  assert.deepEqual(written.owner_sets.map((set: {channel: string; samples: unknown[]}) => [set.channel, set.samples.length]), [['file', 5], ['phone_app', 5]]);
  assert.deepEqual(written.owner_sets[0].samples, v1.owner.samples);
  assert.deepEqual([written.clusters.length, written.assistant.length], [1, 1]);
});

test('interrupt evidence preserves owner bands at 200 ms, rejects echo and others, and never mutates the registry',async t=>{
  const {registry,storage}=await setup(t),owner=voice(201),other=voice(202),assistant=voice(203);
  await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'replace',samples:samples(owner,5),at:AT});
  await registry.identify(other,observe());
  await registry.observeAssistant({voice:'realtime_call',embedding:assistant,speech_ms:2500,at:AT});
  const key=(await storage.list('voiceprints'))[0]!,before=await storage.read('voiceprints',key);
  const interrupt=(speech_ms=CALL_INTERRUPT_MIN_SPEECH_MS)=>({speech_ms,observed_at:AT,mode:'interrupt' as const});
  const verified=await registry.identify(near(owner,.8,301),interrupt());
  assert.equal(verified.kind==='owner'&&verified.band,'verified');
  const uncertain=await registry.identify(near(owner,.55,302),interrupt());
  assert.equal(uncertain.kind==='owner'&&uncertain.band,'uncertain','short playback evidence never promotes the band');
  assert.equal((await registry.identify(other,interrupt())).kind,'speaker');
  assert.equal((await registry.identify(assistant,interrupt())).kind,'assistant');
  assert.deepEqual(await registry.identify(owner,interrupt(CALL_INTERRUPT_MIN_SPEECH_MS-1)),{kind:'unknown',reason:'too_short'});
  const shortOwner=await registry.identify(near(owner,.55,303),interrupt(320));
  assert.equal(shortOwner.kind==='owner'&&shortOwner.band,'uncertain');
  assert.deepEqual(await registry.identify(owner,verify(320)),{kind:'unknown',reason:'too_short'});
  assert.deepEqual(await registry.identify(owner,observe(320)),{kind:'unknown',reason:'too_short'});
  await registry.identify(voice(204),interrupt(3000));
  const call=(speech_ms:number)=>({speech_ms,observed_at:AT,mode:'call' as const});
  const callOwner=await registry.identify(near(owner,.8,304),call(400));assert.deepEqual(callOwner,{kind:'unknown',reason:'too_short'});
  assert.deepEqual(await registry.identify(voice(204),call(400)),{kind:'unknown',reason:'too_short'});
  assert.deepEqual(await registry.identify(voice(204),call(1200)),{kind:'unknown',reason:'unmatched'});
  assert.deepEqual(await registry.identify(other,call(400)),{kind:'unknown',reason:'too_short'});
  await assert.rejects(registry.identify(owner,{...interrupt(),request:{embedding:owner,speech_ms:400}}),/VOICEPRINT_IDENTIFY_INPUT_INVALID/);
  await registry.flush();assert.deepEqual(await storage.read('voiceprints',key),before);await registry.close();
});


test('faces are off by default, persist the owner setting, share naming/merge authority, and retract exact frame evidence', async t => {
  const {registry, open, storage, root, frameDb} = await setup(t,{},MODEL,Array.from({length:5},(_,i)=>`frame-${i+1}`));
  const face = new Float32Array(128); face[0] = 1;
  const observeFace = async (r: VoiceprintRegistry, frame_id: string, at = AT, embedding = face) => {
    const generation = await r.beginFaceFrame();
    if (generation === null) return null;
    await r.commitFaceFrame({frame_id,at},[embedding],generation);
    return (await r.peopleInFrames([frame_id]))[0] ?? null;
  };
  assert.deepEqual(await registry.faceRecognition(), {enabled: false});
  // Off returns before examining an embedding or writing a registry/key.
  assert.equal(await observeFace(registry, 'frame-1', 'invalid', new Float32Array()), null);
  assert.deepEqual(await storage.list('voiceprints'), []);
  await registry.faceRecognition(true);
  assert.deepEqual(await open().faceRecognition(), {enabled: true});
  const first = (await observeFace(registry, 'frame-1', AT, face))!;
  await registry.renameCluster(first.cluster_id, {display_name: '小林', known_person_id: 'person-lin'});
  assert.equal((await observeFace(open(), 'frame-2', AT, face))!.display_name, '小林');
  // Reopen the authority after this test's deliberately separate writer; production has one process owner.
  const authority = open();
  const voiced = await authority.identify(voice(201), observe());
  assert.equal(voiced.kind, 'speaker');
  const merged = await authority.renameCluster(first.cluster_id, {display_name: ' 林老师 '}, (voiced as {cluster_id: string}).cluster_id);
  assert.equal(merged.known_person_id, 'person-lin');
  const reopened = open();
  assert.deepEqual(await reopened.clusters(), await authority.clusters(), 'merged voice, face and new name persist together');
  await reopened.close();
  assert.equal((await authority.identify(voice(201), verify()) as {display_name: string}).display_name, '林老师');
  assert.equal((await observeFace(authority, 'frame-3', AT, face))!.known_person_id, 'person-lin');
  assert.equal((await authority.peopleInFrames(['frame-1']))[0]!.display_name, '林老师');
  assert.deepEqual(await authority.deleteFrameEvidence(['frame-1', 'frame-2']), {removed: 2});
  assert.deepEqual(await authority.peopleInFrames(['frame-1', 'frame-2']), []);
  const key = digest('paios.voiceprint.registry.v1'), beforePrune = await storage.read('voiceprints',key);
  assert.deepEqual(await authority.pruneFaceEvidence(frameId => frameId === 'frame-3'),{removed:0});
  assert.deepEqual(await storage.read('voiceprints',key),beforePrune,'unchanged ready-frame checks never rewrite registry');
  const beforePeople = await authority.clusters();
  frameDb!.prepare("UPDATE frames SET state='deleting' WHERE frame_key='frame-3'").run();
  assert.deepEqual(await authority.pruneFaceEvidence(() => false),{removed:1});
  assert.deepEqual(await authority.clusters(),beforePeople,'pruning face evidence preserves voice identity, name and aliases');
  assert.equal((await open().identify(voice(201),verify()) as {display_name:string}).display_name,'林老师');
  assert.equal((await authority.clusters()).length, 1, 'voice survives removal of all face evidence');
  const fresh = (await observeFace(authority, 'frame-4', AT, face))!;
  assert.notEqual(fresh.cluster_id, first.cluster_id, 'deleted face embedding cannot identify the voice person');
  frameDb!.prepare("UPDATE frames SET state='deleting' WHERE frame_key='frame-4'").run();
  assert.deepEqual(await authority.pruneFaceEvidence(() => false),{removed:1});
  assert.equal((await open().clusters()).some(p=>p.cluster_id===fresh.cluster_id),false,'pruning absent frames durably removes their face-only person');
  await authority.faceRecognition(false);
  const bytes = await storage.read('voiceprints', digest('paios.voiceprint.registry.v1'));
  assert.equal(await observeFace(authority, 'frame-5', AT, face), null);
  assert.deepEqual(await storage.read('voiceprints', digest('paios.voiceprint.registry.v1')), bytes);
  assert.equal(Buffer.from(bytes).includes(Buffer.from(encodeEmbedding(face))), false);
  const file = join(root, 'voiceprints', digest('paios.voiceprint.registry.v1'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).clusters.every((c: {count:number;centroid:string}) => c.count > 0 && c.centroid), true);
  assert.deepEqual(await authority.forgetAll(), {forgotten: 1});
  assert.deepEqual(await open().clusters(), []);
});

test('new plaintext registry remains readable and enrollable by deployed 0dd85cf4', async t => {
  const {registry, storage, root, open} = await setup(t,{},MODEL,['rollback-face']);
  const face = new Float32Array(128); face[0] = 1;
  await registry.faceRecognition(true);
  await registry.commitFaceFrame({frame_id:'rollback-face',at:AT},[face],(await registry.beginFaceFrame())!);
  const owner = voice(211);
  await registry.enrollOwner({speaker_model:MODEL, channel:'file', mode:'replace', samples:samples(owner,5), at:AT});
  await registry.enrollOwner({speaker_model:MODEL, channel:'phone_app', mode:'replace', purpose:'conversation', samples:samples(voice(212),5), at:AT});
  await registry.close();
  const directory = await fs.mkdtemp(join(tmpdir(), 'paios-rollback-reader-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const legacy = execFileSync('git', ['show', '0dd85cf4:01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/registry.ts'], {encoding:'utf8'});
  const file = join(directory, 'registry.ts');
  await fs.writeFile(file, legacy.replace("'../contracts.ts'", JSON.stringify(join(sourceRoot,'contracts.ts')))
    .replace("'../storage.ts'", JSON.stringify(join(sourceRoot,'storage.ts')))
    .replace("'./contracts.ts'", JSON.stringify(join(sourceRoot,'voiceprint/contracts.ts'))));
  const {VoiceprintRegistry: LegacyRegistry} = await import(pathToFileURL(file).href);
  const old = new LegacyRegistry(storage, MODEL);
  assert.equal((await old.identify(owner, verify())).kind, 'owner');
  assert.equal((await old.owner()).samples, 5);
  await old.enrollOwner({speaker_model:MODEL, channel:'phone_app', mode:'replace', samples:samples(owner,5), at:AT});
  await old.close();
  const written = JSON.parse(Buffer.from(await storage.read('voiceprints', digest('paios.voiceprint.registry.v1'))).toString());
  assert.equal(written.schema, 'paios.voiceprint.registry.v2');
  assert.equal(written.face_people.length, 1, 'legacy save preserves optional metadata');
  assert.equal(written.conversation_owner.length, 1, 'legacy reader preserves isolated conversational sets');
  assert.equal((await open().owner('phone_app', true)).enrolled, true);
  assert.equal((await open().owner('phone_app')).enrolled, true);
  assert.equal((await fs.stat(join(root,'voiceprints',digest('paios.voiceprint.registry.v1')))).mode & 0o777, 0o600);
});

test('slow face inference leaves voice usable and setting/deletion generations discard late evidence', async t => {
  const {registry, open} = await setup(t,{},MODEL,['late','before-restore','deleted']), face = new Float32Array(128); face[0] = 1;
  await registry.faceRecognition(true);
  let release!: (vectors: Float32Array[]) => void;
  const inferenceGeneration = (await registry.beginFaceFrame())!;
  const vectors = new Promise<Float32Array[]>(resolve => {release=resolve;});
  const producing = vectors.then(result => registry.commitFaceFrame({frame_id:'late',at:AT},result,inferenceGeneration));
  await new Promise(resolve => setImmediate(resolve));
  const spoken = await registry.identify(voice(221), observe());
  assert.equal(spoken.kind, 'speaker');
  await registry.faceRecognition(false); await registry.faceRecognition(true);
  release([face]); await producing;
  assert.deepEqual(await registry.peopleInFrames(['late']),[]);
  const beforePrune = (await registry.beginFaceFrame())!;
  await registry.pruneFaceEvidence(() => true);
  assert.deepEqual(await registry.commitFaceFrame({frame_id:'before-restore',at:AT},[face],beforePrune),[],'restore prune fences already-running inference');
  const generation = (await registry.beginFaceFrame())!;
  await registry.forgetAll();
  await registry.commitFaceFrame({frame_id:'deleted',at:AT},[face],generation);
  assert.deepEqual(await open().clusters(), []);
});

test('face frames commit together; capped evidence persists while voice/face presence stays transient', async t => {
  const {registry, open, storage} = await setup(t,{},MODEL,[...Array.from({length:23},(_,i)=>`face-${i}`),'after-prune']), face = new Float32Array(128); face[0] = 1;
  await registry.faceRecognition(true);
  const generation = (await registry.beginFaceFrame())!;
  let writes = 0; const replace = storage.replace.bind(storage);
  storage.replace = async (...args) => {writes++;return replace(...args);};
  const other = new Float32Array(128); other[1] = 1;
  const matches = await registry.commitFaceFrame({frame_id:'face-0',at:AT},[face,other,face],generation);
  assert.equal(writes,1,'all faces share one atomic registry write');
  assert.equal(matches.length,2,'frame returns distinct canonical people, including unnamed people');
  const first = matches[0]!;
  assert.equal(first.display_name,null);
  await registry.renameCluster(first.cluster_id,{display_name:'小林'});
  for(let i=1;i<23;i++) await registry.commitFaceFrame({frame_id:`face-${i}`,at:AT},[face],generation);
  assert.equal((await registry.peopleInFrames(['face-0','face-1','face-2'])).some(p=>p.cluster_id===first.cluster_id),true);
  const key = digest('paios.voiceprint.registry.v1'), before = await storage.read('voiceprints',key), beforeWrites = writes;
  assert.equal((await registry.newPersonNearby(first.cluster_id,AT))?.display_name,'小林');
  assert.equal(await registry.newPersonNearby(first.cluster_id,'2026-10-09T08:01:00.000Z'),undefined);
  assert.equal(await registry.newPersonNearby(first.cluster_id,'2026-10-09T08:02:30.000Z'),undefined,'renewed presence prevents duplicate hints');
  assert.equal((await registry.nearbyPeople('2026-10-09T08:03:00.000Z')).length,1);
  assert.equal(writes,beforeWrites,'presence renewals never write the registry');
  assert.deepEqual(await storage.read('voiceprints',key),before);
  assert.deepEqual(await open().nearbyPeople('2026-10-09T08:03:00.000Z'),[],'restart does not restore stale presence');
  await registry.recognitionHints(false);
  assert.deepEqual(await open().recognitionHints(),{enabled:false});
  assert.equal(await registry.newPersonNearby(first.cluster_id,'2026-10-09T08:06:00.000Z'),undefined);
  await registry.recognitionHints(true);
  assert.equal((await registry.newPersonNearby(first.cluster_id,'2026-10-09T08:09:00.000Z'))?.cluster_id,first.cluster_id);
  assert.deepEqual(await registry.deleteFrameEvidence(Array.from({length:20},(_,n)=>`face-${n+3}`)),{removed:20});
  const reopened=open();
  assert.ok((await reopened.peopleInFrames(['face-0','face-1','face-2'])).some(p=>p.cluster_id===first.cluster_id),'old links keep the person after all its exemplars are deleted');
  await reopened.deleteFrameEvidence(['face-1']);
  assert.deepEqual(await reopened.peopleInFrames(['face-1']),[]);
  const fresh=(await reopened.commitFaceFrame({frame_id:'after-prune',at:AT},[face],(await reopened.beginFaceFrame())!))[0]!;
  assert.notEqual(fresh.cluster_id,first.cluster_id,'deleted exemplars cannot recognize a later frame');
  await reopened.close();
});

test('person deletion isolates owner catalogues even when frame and person IDs coincide',async t=>{
  const a=await setup(t,{},MODEL,['same']),b=await setup(t,{},MODEL,['same']),face=new Float32Array(128);face[0]=1;
  for(const {registry} of [a,b]){await registry.faceRecognition(true);await registry.commitFaceFrame({frame_id:'same',at:AT},[face],(await registry.beginFaceFrame())!);}
  await b.registry.renameCluster('1',{display_name:'另一位'});await b.registry.close();
  await a.registry.forgetAll();await a.registry.close();
  assert.deepEqual(await a.open().peopleInFrames(['same']),[]);
  const isolated=b.open();assert.equal((await isolated.peopleInFrames(['same']))[0]!.display_name,'另一位');await isolated.close();
});

test('interrupted person merge and deletion reconcile their persisted link rows on restart',async t=>{
  const {registry,open,frameStore,frameDb}=await setup(t,{},MODEL,['first','second']),a=new Float32Array(128),b=new Float32Array(128);a[0]=1;b[1]=1;
  await registry.faceRecognition(true);
  for(const [frame,face] of [['first',a],['second',b]] as const)await registry.commitFaceFrame({frame_id:frame,at:AT},[face],(await registry.beginFaceFrame())!);
  let current=registry;
  for(const action of ['merge','delete']){
    const fault=t.mock.method(frameStore!,'remapFramePeople',()=>{throw new Error('link write failed');});
    await assert.rejects(action==='merge'?current.mergeClusters('1','2'):current.forgetAll(),/link write failed/);fault.mock.restore();
    await current.close();current=open();await current.reconcileFramePeople();
    assert.deepEqual(frameDb!.prepare('SELECT DISTINCT person_id FROM frame_people').all().map(row=>row.person_id),action==='merge'?['1']:[]);
  }
  await current.close();
});
