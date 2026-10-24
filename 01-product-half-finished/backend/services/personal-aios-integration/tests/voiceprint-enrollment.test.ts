// Owner enrollment from the paired phone: archived windows are cut to speech by the engine's detector and embedded by the
// same engine; only the registry judges the set. Through the actual archive, Runtime and registry (marker engine, no model).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAIOSRuntime, RunAdmission, type NativeClient } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { ContractError, EVENT_SCHEMA, sha256, type RawEvent } from '../src/contracts.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { StreamArchive, type TrackChunk } from '../src/stream-archive.ts';
import { VoiceprintRegistry, type SpeakerModel } from '../src/voiceprint/registry.ts';
import {ConversationVoiceprintEnrollment} from '../src/voiceprint/enrollment.ts';
import type { SpeechEngine } from '../src/voiceprint/contracts.ts';
import {SherpaSileroStreamFactory, type SpeechVad} from '../src/media/silero-stream.ts';
import { controlledVad } from './speech-fixture.ts';

const MODEL: SpeakerModel = {id: 'enroll-speaker', sha256: 'e'.repeat(64), dim: 16};
const vector = (seed: number, jitter: number) => Float32Array.from({length: 16}, (_, i) => Math.sin(seed * 31 + i * 7) + (i === seed % 16 ? 3 : 0) + jitter * Math.cos(i));
/** Marker engine: the speech's first amplitude names the voice; its length adds a little per-utterance jitter. */
function engine(): SpeechEngine & SpeechVad & {embedded: number[]} {
  const vad = controlledVad(), embedded: number[] = [];
  return {vad_model: vad.vad_model, openVad: signal => vad.openVad(signal), embedded,
    asr_model: {id: 'none', sha256: 'f'.repeat(64)}, speaker_model: {...MODEL},
    transcribe: async () => ({text: ''}), close: async () => {},
    embed: async samples => {
      embedded.push(samples.length);
      if (samples.length < 1600) throw new ContractError('SPEECH_INPUT_TOO_SHORT');
      return vector(Math.round(samples[0]! * 32768), (samples.length % 7) * 0.02);
    }};
}
/** One window: silence, `ms` of the voice's marker speech (whole 512-sample frames), silence. */
const sentence = (voice: number, ms: number) => {
  const frames = Math.round(ms * 16 / 512), pcm = Buffer.alloc((frames + 8) * 512 * 2);
  for (let n = 4 * 512; n < (4 + frames) * 512; n++) pcm.writeInt16LE(voice, n * 2);
  return pcm;
};

async function fixture(t: test.TestContext, withSpeech = true,owner_override_active?:()=>Promise<boolean>) {
  const directory = await mkdtemp(join(tmpdir(), 'paios-voiceprint-enroll-'));
  const storage = new PosixStorage(directory);
  const budget = {max_chunk_bytes: 700000, max_total_bytes: 2000000, max_chunks: 200, max_revisions: 200, max_seq: 200};
  const archive = new RawArchive(storage, 700000, undefined, budget), streams = new StreamArchive(storage, budget);
  const native: NativeClient = {create: async () => {throw new Error('no runs');}, status: async () => {throw new Error('no runs');},
    cancel: async () => {throw new Error('no runs');}};
  const admission = new RunAdmission(storage, native, {max_pending_events: 2, max_pending_bytes: 100000, max_event_age_ms: 10000,
    poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'enroll'});
  const registry = new VoiceprintRegistry(storage, MODEL,owner_override_active?{owner_override_active}:{}), speech = engine();
  const device = (principal_id: string, device_id: string, device_type: 'glasses' | 'phone') => ({principal_id, device_id, device_type,
    consent_ref: 'c', channel: 'fixture', route_version: 'r', output_modes: ['text'], token_sha256: sha256(`${device_id}-token`)});
  const runtime = new PersonalAIOSRuntime({storage, archive, admission, native, output: new OutputAuthority(storage), skill: 'fixed',
    max_read_bytes: 100000, voiceprint: registry, ...(withSpeech ? {speech: async () => speech} : {}),
    devices: [device('owner', 'phone', 'phone'), device('owner', 'glasses', 'glasses'), device('stranger', 'their-phone', 'phone')]});
  t.after(async () => {await runtime.close(); await registry.close(); await rm(directory, {recursive: true, force: true});});
  const phone = await runtime.authenticate('phone-token'), glasses = await runtime.authenticate('glasses-token');
  const stranger = await runtime.authenticate('their-phone-token');
  let windows = 0;
  /** A window the PCM reader archived for `source` (one event, one epoch, 100 ms chunks), as the media append stores it. */
  const record = async (pcm: Buffer, source = phone) => {
    const event_id = `pcm:window-${windows++}`, epoch = event_id.slice(4);
    let last: Awaited<ReturnType<typeof streams.append>> | undefined;
    for (let seq = 0, at = 0; at < pcm.length; seq++, at += 3200) {
      const part = pcm.subarray(at, at + 3200);
      const chunk: TrackChunk = {track_id: 'microphone', stream_epoch: epoch, seq, modality: 'audio', format: 'pcm_s16le:16000:1',
        source_range: {kind: 'interval', timebase_id: `received-pcm:${epoch}`, stream_epoch: epoch, start_ms: at / 32, end_ms: (at + part.length) / 32}};
      const raw: RawEvent = {schema_version: EVENT_SCHEMA, event_id, device_id: source.device_id, device_type: source.device_type,
        captured_at: '2026-10-09T08:00:00.000Z', source: {channel: 'fixture'}, media_type: 'audio', mime: 'audio/pcm',
        representation: 'received_decoded_sample', payload: Buffer.from(part)};
      last = await streams.append(raw, {...source, submission: 'observation'}, '2026-10-09T08:00:01.000Z', chunk);
    }
    return {raw_ref: last!.event.raw_ref, archive_revision: last!.event.archive_revision};
  };
  return {runtime, registry, speech, phone, glasses, stranger, record};
}

test('each recorded sentence is measured from its archived window: speech only, too short and silence say so', async t => {
  const f = await fixture(t);
  const ok = await f.runtime.voiceprintSample(f.phone, await f.record(sentence(7, 2400)));
  assert.equal(ok.quality, 'ok'); assert.match(ok.sample_id!, /^vps-/u);
  assert.equal(ok.speech_ms, Math.round(Math.round(2400 * 16 / 512) * 512 / 16), 'only the detector\'s speech counts, never the silence around it');
  assert.equal(f.speech.embedded.at(-1), Math.round(2400 * 16 / 512) * 512);
  assert.deepEqual(await f.runtime.voiceprintSample(f.phone, await f.record(sentence(7, 900))), {sample_id: null, speech_ms: 896, quality: 'too_short'});
  assert.deepEqual(await f.runtime.voiceprintSample(f.phone, await f.record(sentence(0, 2000))), {sample_id: null, speech_ms: 0, quality: 'no_speech'});
  // Only the paired phone enrolls, only from its own principal's windows.
  await assert.rejects(f.runtime.voiceprintSample(f.glasses, await f.record(sentence(7, 2400), f.glasses)), /VOICEPRINT_DEVICE_REQUIRED/);
  await assert.rejects(f.runtime.voiceprintSample(f.stranger, await f.record(sentence(7, 2400))), /RAW_ACCESS_DENIED/);
  const noSpeech = await fixture(t, false);
  await assert.rejects(noSpeech.runtime.voiceprintOwner(noSpeech.phone), /VOICEPRINT_ENROLLMENT_NOT_CONFIGURED/);
});

test('the registry judges the set: an odd voice is named for re-recording; the profile commits from five good samples', async t => {
  const f = await fixture(t);
  // A set enrolled from WAV files is another channel's: the phone shows its own channel, not enrolled yet.
  const wav = Array.from({length: 5}, (_, i) => ({embedding: vector(3, i * 0.02), speech_ms: 2000}));
  await f.registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace', samples: wav, at: '2026-10-09T07:00:00.000Z'});
  const before = await f.runtime.voiceprintOwner(f.phone);
  assert.deepEqual([before.enrolled, before.samples, before.channels.map(c => c.channel)], [false, 0, ['file']]);
  const take = async (voice: number, ms: number) => (await f.runtime.voiceprintSample(f.phone, await f.record(sentence(voice, ms)))).sample_id!;
  const owner = [await take(7, 2000), await take(7, 2300), await take(7, 2600), await take(7, 2900)];
  const odd = await take(11, 2400);
  const refused = await f.runtime.voiceprintEnroll(f.phone, [...owner, odd]);
  assert.equal(refused.status, 'inconsistent'); assert.equal(refused.owner.enrolled, false);
  assert.deepEqual(refused.samples!.map(s => [s.sample_id, s.ok]), [...owner.map(id => [id, true]), [odd, false]]);
  assert.ok(refused.samples![4]!.consistency < f.registry.policy.thresholds.enroll_consistency);
  await assert.rejects(f.runtime.voiceprintEnroll(f.phone, owner), /VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES/);
  await assert.rejects(f.runtime.voiceprintEnroll(f.phone, [...owner, 'vps-missing']), /VOICEPRINT_SAMPLE_NOT_FOUND/);
  await assert.rejects(f.runtime.voiceprintEnroll(f.stranger, [...owner, odd]), /VOICEPRINT_SAMPLE_NOT_FOUND/, 'samples belong to the phone that recorded them');
  await assert.rejects(f.runtime.voiceprintEnroll(f.phone, [...owner, owner[0]!]), /VOICEPRINT_ENROLLMENT_INVALID/);
  const again = await take(7, 3200);
  const enrolled = await f.runtime.voiceprintEnroll(f.phone, [...owner, again]);
  assert.equal(enrolled.status, 'enrolled'); assert.equal(enrolled.samples, undefined);
  assert.deepEqual([enrolled.owner.enrolled, enrolled.owner.samples], [true, 5]);
  // The phone enrolled the phone_app set; the WAV set is untouched.
  assert.deepEqual(enrolled.owner.channels.map(c => [c.channel, c.samples, c.enrolled_at === '2026-10-09T07:00:00.000Z']),
    [['file', 5, true], ['phone_app', 5, false]]);
  assert.equal((await f.runtime.voiceprintOwner(f.phone)).enrolled, true);
  // Committed samples are spent; later samples extend the same capture channel.
  await assert.rejects(f.runtime.voiceprintEnroll(f.phone, [...owner, again]), /VOICEPRINT_SAMPLE_NOT_FOUND/);
  const identity = await f.registry.identify(vector(7, 0.04), {speech_ms: 2000, observed_at: '2026-10-09T08:00:00.000Z', mode: 'verify'});
  assert.equal(identity.kind, 'owner');
  const extended = await f.runtime.voiceprintEnroll(f.phone, [await take(7, 2200)]);
  assert.deepEqual([extended.status, extended.owner.samples], ['enrolled', 6]);
  const other = await take(11, 2400);
  const rejected = await f.runtime.voiceprintEnroll(f.phone, [other]);
  assert.equal(rejected.status, 'inconsistent');
  assert.deepEqual(rejected.samples!.map(s => [s.sample_id, s.ok]), [[other, false]]);
  assert.equal(rejected.owner.samples, 6);
  // "忘记我的声音": the profile is gone, every channel's set.
  const forgotten = await f.runtime.voiceprintForget(f.phone);
  assert.deepEqual([forgotten.enrolled, forgotten.channels], [false, []]);
  await assert.rejects(f.runtime.voiceprintForget(f.glasses), /VOICEPRINT_DEVICE_REQUIRED/);
});


test('natural enrollment bootstraps clean owner speech, pauses/resumes, checks then commits without changing payment', async t => {
  const f = await fixture(t), owner = {...f.phone, device_type: 'phone'};
  await f.registry.enrollOwner({speaker_model: MODEL, channel: 'file', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: vector(3, 0), speech_ms: 2000}))});
  const payment = await f.registry.owner('file');
  const create = () => new ConversationVoiceprintEnrollment(f.registry, async () => f.speech, new SherpaSileroStreamFactory(async () => f.speech), true);
  const enrollment = create();
  let state = await enrollment.control(owner, 'start', undefined, 'call-1');
  const id = state.session_id!;
  assert.match(await enrollment.instructions(owner, id, 'call-1'), /自然聊天/);
  state = await enrollment.collect(owner, id, 'call-1', 0, {start_ms: 0, end_ms: 5000}, async () => sentence(7, 4000));
  assert.ok(state.clean_speech_ms >= 3900); assert.equal(state.owner.enrolled, false);
  const progress = state.clean_speech_ms;
  state = await enrollment.control(owner, 'pause', id);
  assert.equal(state.phase, 'paused'); assert.equal(state.call_id, 'call-1');
  state = await enrollment.control(owner, 'check', id);
  assert.equal(state.issue, 'VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED');
  state = await enrollment.control(owner, 'resume', id, 'call-2');
  assert.equal(state.clean_speech_ms, progress);
  for (let turn = 1; state.phase === 'collecting'; turn++)
    state = await enrollment.collect(owner, id, 'call-2', turn, {start_ms: turn * 5000, end_ms: (turn + 1) * 5000}, async () => sentence(7, 4000));
  assert.equal(state.phase, 'checked'); assert.equal(state.can_use, true); assert.ok(state.clean_speech_ms >= state.target_speech_ms);
  assert.deepEqual(await f.registry.owner('file'), payment);
  state = await enrollment.control(owner, 'check', id);
  assert.equal(state.phase, 'checked'); assert.equal(state.can_use, true); assert.equal(state.owner.enrolled, false);
  const preview = await enrollment.control(owner, 'preview', id);
  const wav = Buffer.from(preview.preview_audio_base64!, 'base64');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.byteLength, 8044);
  assert.equal(wav.readUInt32LE(24), 8000); assert.equal(wav.readUInt16LE(34), 8);
  assert.ok(Buffer.byteLength(JSON.stringify({operation: 'voice_enrollment_state', session_id: 'connection', enrollment: preview})) < 12288);
  assert.equal(state.preview_audio_base64, undefined); assert.ok(state.recorded_ms >= state.clean_speech_ms);
  assert.deepEqual(await f.registry.owner('file'), payment);
  state = await enrollment.control(owner, 'commit', id);
  assert.equal(state.phase, 'committed'); assert.equal(state.owner.enrolled, true);
  assert.deepEqual(await f.registry.owner('file'), payment);
  const call = await f.registry.identify(vector(7, 0), {mode: 'call', speech_ms: 2500, observed_at: new Date().toISOString(), learning: false});
  assert.equal(call.kind, 'owner');
  const paymentIdentity = await f.registry.identify(vector(7, 0), {mode: 'payment', speech_ms: 2500, observed_at: new Date().toISOString()});
  assert.ok(paymentIdentity.kind !== 'owner' || paymentIdentity.band !== 'verified');
  const restarted = await create().control(owner, 'status');
  assert.equal(restarted.phase, 'idle'); assert.equal(restarted.owner.enrolled, true);
  assert.deepEqual(restarted.source_device, {device_id: owner.device_id, device_type: 'phone'});
  assert.equal(restarted.updated_at, restarted.owner.updated_at);
  const first = await f.registry.owner('phone_app', true);
  const repeated = create();
  let next = await repeated.control(owner, 'start', undefined, 'call-3');
  const nextId = next.session_id!;
  for (let turn = 0; next.phase === 'collecting'; turn++)
    next = await repeated.collect(owner, nextId, 'call-3', turn, {start_ms: turn * 5000, end_ms: (turn + 1) * 5000}, async () => sentence(7, 4000));
  next = await repeated.control(owner, 'commit', nextId);
  assert.equal(next.phase, 'committed');
  assert.equal(next.owner.samples, Math.min(first.samples * 2, f.registry.policy.max_owner_samples),'repeat natural enrollment accumulates samples');
  assert.equal(next.owner.enrolled_at, first.enrolled_at,'repeat natural enrollment preserves the first enrollment');
  const previous = await f.registry.owner('phone_app', true);
  await assert.rejects(f.registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace', purpose: 'conversation',
    samples: [7, 7, 7, 7, 9].map(seed => ({embedding: vector(seed, 0), speech_ms: 2000}))}), /VOICEPRINT_ENROLLMENT_INCONSISTENT/);
  assert.deepEqual(await f.registry.owner('phone_app', true), previous);
  state = await enrollment.control(owner, 'start', undefined, 'call-3');
  state = await enrollment.collect(owner, state.session_id!, 'call-3', 0, {start_ms: 0, end_ms: 5000}, async () => sentence(9, 4000));
  assert.equal(state.clean_speech_ms, 0); assert.equal(state.issue, 'VOICE_ENROLLMENT_OTHER_SPEAKER');
  assert.deepEqual(state.owner, previous);
  state = await enrollment.control(owner, 'check', state.session_id!);
  assert.equal(state.issue, 'VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED');
  assert.deepEqual(state.owner, previous);
  await enrollment.control(owner, 'discard', state.session_id!);
  assert.equal((await enrollment.control(owner, 'status')).owner.enrolled, true);
  const disabled = new ConversationVoiceprintEnrollment(f.registry, async () => f.speech, new SherpaSileroStreamFactory(async () => f.speech), false);
  assert.equal((await disabled.control(owner, 'status')).available, false);
  await assert.rejects(disabled.control(owner, 'start', undefined, 'disabled-call'), /VOICE_ENROLLMENT_UNAVAILABLE/);
  await enrollment.forget(owner.principal_id);
  await assert.rejects(enrollment.control(owner, 'commit', state.session_id!), /VOICE_ENROLLMENT_SESSION_NOT_FOUND/);
});

test('natural collection rejects assistant, known other speaker, silence and cross-turn contamination', async t => {
  const f = await fixture(t), owner = {...f.phone, device_type: 'phone'};
  await f.registry.observeAssistant({voice: 'test', embedding: vector(11, 0), speech_ms: 2500, at: new Date().toISOString()});
  await f.registry.identify(vector(13, 0), {mode: 'observe', speech_ms: 2500, observed_at: new Date().toISOString()});
  await f.registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: vector(7, 0), speech_ms: 2000}))});
  const enrollment = new ConversationVoiceprintEnrollment(f.registry, async () => f.speech, new SherpaSileroStreamFactory(async () => f.speech), true);
  let state = await enrollment.control(owner, 'start', undefined, 'call');
  const id = state.session_id!;
  for (const [turn, voice] of [11, 13, 9, 0].entries()) {
    state = await enrollment.collect(owner, id, 'call', turn, {start_ms: turn * 5000, end_ms: (turn + 1) * 5000}, async () => sentence(voice, 4000));
    assert.equal(state.clean_speech_ms, 0); assert.ok(state.recorded_ms > 0);
  }
  state = await enrollment.collect(owner, id, 'call', 4, {start_ms: 20000, end_ms: 25000}, async () => sentence(7, 4000));
  const progress = state.clean_speech_ms;
  assert.ok(progress > 0);
  state = await enrollment.collect(owner, id, 'call', 5, {start_ms: 25000, end_ms: 30000}, async () => sentence(9, 4000));
  assert.equal(state.clean_speech_ms, progress); assert.equal(state.issue, 'VOICE_ENROLLMENT_OTHER_SPEAKER');
  state = await enrollment.collect(owner, id, 'call', 4, {start_ms: 20000, end_ms: 25000}, async () => {throw new Error('duplicate read');});
  assert.equal(state.clean_speech_ms, progress);
  await enrollment.control(owner, 'discard', id);
  await assert.rejects(enrollment.control(owner, 'commit', id), /VOICE_ENROLLMENT_PHASE_INVALID/);
});


test('natural bootstrap claims the owner ambient cluster but excludes named people and a dominant assistant', async t => {
  const f = await fixture(t), owner = {...f.phone, device_type: 'phone'};
  await f.registry.identify(vector(7, .10), {mode: 'observe', speech_ms: 2500, observed_at: new Date().toISOString()});
  const other = await f.registry.identify(vector(13, 0), {mode: 'observe', speech_ms: 2500, observed_at: new Date().toISOString()});
  assert.equal(other.kind, 'speaker');
  if (other.kind === 'speaker') await f.registry.renameCluster(other.cluster_id, {display_name: '访客'});
  await f.registry.observeAssistant({voice: 'test', embedding: vector(11, 0), speech_ms: 2500});
  const enrollment = new ConversationVoiceprintEnrollment(f.registry, async () => f.speech, new SherpaSileroStreamFactory(async () => f.speech), true);
  let state = await enrollment.control(owner, 'start', undefined, 'ambient-bootstrap');
  const id = state.session_id!;
  for (const [turn, voice] of [13, 11].entries()) {
    state = await enrollment.collect(owner, id, 'ambient-bootstrap', turn, {start_ms: turn * 5000, end_ms: (turn + 1) * 5000}, async () => sentence(voice, 4000));
    assert.equal(state.clean_speech_ms, 0);
  }
  for (let turn = 2; state.phase === 'collecting'; turn++)
    state = await enrollment.collect(owner, id, 'ambient-bootstrap', turn, {start_ms: turn * 5000, end_ms: (turn + 1) * 5000}, async () => sentence(7, turn % 2 ? 4400 : 4000));
  assert.equal(state.phase, 'checked'); assert.equal(state.owner.enrolled, false);
  state = await enrollment.control(owner, 'commit', id);
  assert.equal(state.owner.enrolled, true);
});

test('natural re-enrollment accepts the verified owner beside an adjacent assistant centroid', async t => {
  const f = await fixture(t), owner = {...f.phone, device_type: 'phone'}, base = vector(7, 0);
  const norm = Math.hypot(...base), unit = Float32Array.from(base, value => value / norm);
  const noise = vector(11, 0), along = noise.reduce((sum, value, i) => sum + value * unit[i]!, 0);
  const orthogonal = Float32Array.from(noise, (value, i) => value - along * unit[i]!);
  const orthogonalNorm = Math.hypot(...orthogonal);
  const adjacent = Float32Array.from(unit, (value, i) => .55 * value + Math.sqrt(1 - .55 ** 2) * orthogonal[i]! / orthogonalNorm);
  await f.registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: base, speech_ms: 2000}))});
  await f.registry.observeAssistant({voice: 'adjacent', embedding: adjacent, speech_ms: 2500});
  const enrollment = new ConversationVoiceprintEnrollment(f.registry, async () => f.speech, new SherpaSileroStreamFactory(async () => f.speech), true);
  let state = await enrollment.control(owner, 'start', undefined, 'adjacent-owner');
  state = await enrollment.collect(owner, state.session_id!, 'adjacent-owner', 0, {start_ms: 0, end_ms: 5000}, async () => sentence(7, 4000));
  assert.ok(state.clean_speech_ms > 3900); assert.equal(state.issue, null);
});


test('natural enrollment status keeps a live same-channel legacy profile through a draft and failed check', async t => {
  const f = await fixture(t), owner = {...f.phone, device_type: 'phone'};
  await f.registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: vector(7, 0), speech_ms: 2000}))});
  const legacy = await f.registry.owner('phone_app');
  const enrollment = new ConversationVoiceprintEnrollment(f.registry, async () => f.speech, new SherpaSileroStreamFactory(async () => f.speech), true);
  let state = await enrollment.control(owner, 'status');
  assert.deepEqual(state.owner, legacy); assert.equal(state.source_device, null);
  assert.equal((await f.registry.owner('phone_app', true)).enrolled, false);
  state = await enrollment.control(owner, 'start', undefined, 'legacy-draft');
  const id = state.session_id!;
  assert.deepEqual(state.owner, legacy); assert.deepEqual(state.source_device, {device_id: owner.device_id, device_type: 'phone'});
  state = await enrollment.collect(owner, id, 'legacy-draft', 0, {start_ms: 0, end_ms: 5000}, async () => sentence(7, 4000));
  state = await enrollment.control(owner, 'check', id);
  assert.equal(state.issue, 'VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED'); assert.deepEqual(state.owner, legacy);
  assert.deepEqual(await f.registry.owner('phone_app'), legacy);
  assert.equal((await f.registry.owner('phone_app', true)).enrolled, false);
});

test('override refuses enrollment capture before embedding or retaining a draft and off resumes clean collection',async t=>{
 let active=true;const f=await fixture(t,true,async()=>active),window=await f.record(sentence(7,2400));
 await assert.rejects(f.runtime.voiceprintSample(f.phone,window),/VOICEPRINT_LEARNING_FROZEN/);assert.deepEqual(f.speech.embedded,[]);
 const enrollment=new ConversationVoiceprintEnrollment(f.registry,async()=>f.speech,new SherpaSileroStreamFactory(async()=>f.speech),true);
 const owner={principal_id:'owner',device_id:'phone',device_type:'phone'},started=await enrollment.control(owner,'start',undefined,'override-call');let reads=0;
 const collect=()=>enrollment.collect(owner,started.session_id!,'override-call',0,{start_ms:0,end_ms:2400},async()=>{reads++;return sentence(7,2400);});
 await assert.rejects(collect(),/VOICEPRINT_LEARNING_FROZEN/);assert.equal(reads,0);assert.deepEqual(f.speech.embedded,[]);
 active=false;const measured=await f.runtime.voiceprintSample(f.phone,window);assert.equal(measured.quality,'ok');
 const collected=await collect();assert.equal(reads,1);assert.ok(collected.clean_speech_ms>0);assert.equal((await f.registry.owner()).samples,0);
});
