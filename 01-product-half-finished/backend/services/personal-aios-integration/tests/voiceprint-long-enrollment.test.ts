import assert from 'node:assert/strict';
import test from 'node:test';
import {embedSpeech, NATIVE_WINDOW_SAMPLES, SPEAKER_WINDOW_SAMPLES} from '../src/voiceprint/contracts.ts';
import {ENROLLMENT_MAX_PCM_BYTES, enrollmentNoiseFloor, measureEnrollmentSpeech, selectEnrollmentSamples, VoiceprintEnrollment} from '../src/voiceprint/enrollment.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {PosixStorage} from '../src/storage.ts';
import {controlledDetector} from './speech-fixture.ts';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const unit = Float32Array.of(1, 0);
const engine = {embed: async (_samples: Float32Array) => unit};

test('canonical embedding preserves short speech and balances complete long speech into bounded windows', async () => {
  assert.equal(await embedSpeech(engine, new Float32Array(16000)), unit);
  const seen: Float32Array[] = [], samples = Float32Array.from({length: 10 * 16000 + 7}, (_, i) => i / 1e6);
  const result = await embedSpeech({embed: async part => {seen.push(part); return Float32Array.of(2, 0);}}, samples);
  assert.equal(NATIVE_WINDOW_SAMPLES, 160000);
  assert.ok(seen.every(part => part.length <= SPEAKER_WINDOW_SAMPLES));
  assert.ok(Math.abs(seen.at(-1)!.length - seen.at(-2)!.length) <= 1);
  assert.ok(seen.slice(0,-2).every(p=>p.length===SPEAKER_WINDOW_SAMPLES));
  assert.deepEqual(Float32Array.from(seen.flatMap(part => [...part])), samples);
  assert.deepEqual(result, unit);
});

test('quality weighting reduces clipped-window contribution without dropping windows', async () => {
  const speech = new Float32Array(96000); speech.fill(.1, 0, 48000); speech.fill(1, 48000);
  const marker = {embed: async (part: Float32Array) => part[0] === 1 ? Float32Array.of(0, 1) : unit};
  const weighted = await embedSpeech(marker, speech), unweighted = await embedSpeech(marker, speech, undefined, {quality_weighting: false});
  assert.ok(weighted[0]! > .99 && weighted[1]! < .02);
  assert.ok(Math.abs(unweighted[0]! - unweighted[1]!) < 1e-6);
});

test('enrollment rejects noise, clipping and an inconsistent second voice before storing samples', async () => {
  assert.equal(await measureEnrollmentSpeech(engine, new Float32Array(48000).fill(.1), .01, 1500, .6), 'low_snr');
  assert.equal(await measureEnrollmentSpeech(engine, new Float32Array(48000).fill(1), 0, 1500, .6), 'clipped');
  const mixed = new Float32Array(96000); mixed.fill(.1, 0, 48000); mixed.fill(.2, 48000);
  assert.equal(await measureEnrollmentSpeech({embed: async part => part[0]! < .15 ? unit : Float32Array.of(0, 1)}, mixed, 0, 1500, .6), 'multiple_speakers');
  const speech = new Float32Array(120 * 16000).fill(.1), measured = await measureEnrollmentSpeech(engine, speech, .0001, 1500, .6);
  assert.ok(Array.isArray(measured));
  assert.equal(measured.length, 40);
  const selected = selectEnrollmentSamples(measured, 20);
  assert.equal(selected.length, 20); assert.equal(selected[0], measured[0]); assert.equal(selected.at(-1), measured.at(-1));
  assert.ok(selected.every(sample => sample.quality > 0 && sample.quality < 1));
  assert.equal(ENROLLMENT_MAX_PCM_BYTES, 10 * 60 * 16000 * 2);
});

test('one long recording commits its bounded measured set through the existing enrollment owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paios-enrollment-long-'));
  const model = {id: 'long-enroll', sha256: 'e'.repeat(64), dim: 16};
  const registry = new VoiceprintRegistry(new PosixStorage(directory), model);
  t.after(async () => {await registry.close(); await rm(directory, {recursive: true, force: true});});
  const calls: number[] = [];
  const local = {asr_model: model, speaker_model: model, transcribe: async () => ({text: ''}), close: async () => {},
    embed: async (part: Float32Array) => {calls.push(part.length); return Float32Array.from({length: 16}, (_, i) => i === 0 ? 1 : 0);}};
  const enrollment = new VoiceprintEnrollment(registry, async () => local, controlledDetector());
  const owner = {principal_id: 'owner', device_id: 'mac', device_type: 'mac'};
  const pcm = Buffer.alloc(18 * 16000 * 2);
  for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(3000, at);
  const measured = await enrollment.measure(owner, pcm);
  assert.equal(measured.quality, 'ok'); assert.equal(measured.samples!.length, 6);
  assert.ok(calls.every(size => size <= 48000));
  const outcome = await enrollment.enroll(owner, measured.samples!.map(sample => sample.sample_id));
  assert.equal(outcome.status, 'enrolled'); assert.equal(outcome.owner.samples, 6);
  assert.equal(outcome.owner.channels[0]!.channel, 'mac');
});

test('progressive whole-utterance scoring reuses completed windows with identical results and bounded inference',async()=>{
  const speech=Float32Array.from({length:60*16000},(_,i)=>i/(120*16000)),cache=new Map<number,Float32Array>();
  const vector=(part:Float32Array)=>Float32Array.of(1,part[0]!,part.length/48000);
  let nativeCalls=0,previous=0;
  for(let end=6400;end<=speech.length;end+=6400){
    const prefix=speech.subarray(0,end),actual=await embedSpeech({embed:async part=>{nativeCalls++;return vector(part);}},prefix,undefined,{cache});
    const expected=await embedSpeech({embed:async part=>vector(part)},prefix);
    assert.deepEqual(actual,expected);
    assert.ok(nativeCalls-previous<=2,'each update embeds at most the final two windows');previous=nativeCalls;
  }
  assert.equal(cache.size,20);
  assert.ok(nativeCalls<=300);
});
test('noise floor ignores brief unvoiced speech edges but retains stationary background noise', async () => {
  const samples = new Float32Array(6400).fill(.2);
  samples.fill(.01, 0, 160); // Only 10 ms of quiet onset before unvoiced/boundary speech.
  const spans = [{start_sample: 1280, end_sample_exclusive: 5120}];
  const floor = enrollmentNoiseFloor(samples.length, spans, n => samples[n]!);
  assert.ok(Math.abs(floor - .0001) < 1e-9);
  const accepted = await measureEnrollmentSpeech(engine, new Float32Array(48000).fill(.1), floor, 1500, .6);
  assert.ok(Array.isArray(accepted));
  const noisy = enrollmentNoiseFloor(6400, spans, () => .09);
  assert.equal(await measureEnrollmentSpeech(engine, new Float32Array(48000).fill(.1), noisy, 1500, .6), 'low_snr');
});
