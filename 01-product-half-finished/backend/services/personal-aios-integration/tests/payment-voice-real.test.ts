// Local sherpa + Silero + registry on generated speech. No owner recording or network request.
// A13 coverage: I5 speaker evidence/same terminal only; no locks, grants, replay prevention or typed-request policy.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {speechSpans} from '../src/media/continuous-source.ts';
import {SherpaSileroStreamFactory} from '../src/media/silero-stream.ts';
import type {UtteranceRef} from '../src/payment/contracts.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {LocalSpeechEngine} from '../src/voiceprint/engine.ts';
import {VoiceprintEnrollment} from '../src/voiceprint/enrollment.ts';
import {VoiceprintPaymentVerifier, type PaymentVoiceVerifierOptions} from '../src/voiceprint/payment-verify.ts';
import {floats, realModelsPresent, realSpeechConfig, sayPresent, synthesize, VOICE_A, VOICE_B} from './speech-fixture.ts';

const AT = '2026-10-15T08:00:00.000Z', T0 = Date.parse(AT);
test('I5 speaker-evidence clause: real local verifier on generated Mandarin fixtures',
  {skip: !realModelsPresent || !sayPresent ? 'local sherpa models or fixture TTS voices unavailable' : false, timeout: 300000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'paios-payment-voice-real-'));
  const engine = await LocalSpeechEngine.open(realSpeechConfig), storage = new PosixStorage(join(root, 'archive'));
  const registry = new VoiceprintRegistry(new PosixStorage(join(root, 'registry')), engine.speaker_model);
  t.after(async () => {await registry.close(); await engine.close(); await rm(root, {recursive: true, force: true});});
  const detector = new SherpaSileroStreamFactory(async () => engine);
  const budget = {max_chunk_bytes: 512000, max_total_bytes: 2048000, max_chunks: 64, max_revisions: 64, max_seq: 64};
  const archive = new RawArchive(storage, budget.max_chunk_bytes, () => AT, budget), streams = new StreamArchive(storage, budget);
  const options: PaymentVoiceVerifierOptions = {archive, registry, engine: async () => engine, detector, carrier_ms: 1500, max_read_bytes: 512000,
    clock_map: async (_p, _u, record) => {
      const chunk = record.manifest.chunks[0]!;
      return {modality: 'audio', track_id: chunk.track_id, stream_epoch: chunk.stream_epoch, source_timebase_id: chunk.source_range.timebase_id,
        target_timebase_id: 'utc_epoch_ms', offset_ms: T0, drift_ppm: 0, uncertainty_ms: 0, basis_ref: 'fixture-server-clock'};
    }};
  const verifier = new VoiceprintPaymentVerifier(options);
  let serial = 0;
  const record = async (bytes: Buffer, device_id = 'glasses', device_type: 'glasses'|'phone' = 'glasses'): Promise<UtteranceRef> => {
    const epoch = `real-payment-${serial++}`;
    const {event} = await streams.append({schema_version: 'paios.event.v1', event_id: epoch, device_id, device_type, captured_at: AT,
      source: {channel: 'fixture'}, media_type: 'audio', mime: 'audio/pcm', representation: 'received_decoded_sample', payload: bytes},
    {principal_id: 'owner', device_id, device_type, channel: 'fixture', consent_ref: 'fixture', submission: 'observation'}, AT,
    {track_id: 'mic', stream_epoch: epoch, seq: 0, modality: 'audio', format: 'pcm_s16le:16000:1',
      source_range: {kind: 'interval', timebase_id: 'samples', stream_epoch: epoch, start_ms: 0, end_ms: bytes.length / 32}});
    return {device_id, device_type, raw_ref: event.raw_ref, archive_revision: event.archive_revision,
      start_ms: T0, end_ms: T0 + Math.floor(bytes.length / 32), captured_at: AT};
  };
  const enrollment = new VoiceprintEnrollment(registry, async () => engine, detector), owner = {principal_id: 'owner', device_id: 'glasses', device_type: 'glasses'};
  const samples: string[] = [];
  for (const text of ['今天下午三点提醒我去公司开会。', '帮我查一下明天北京的天气。', '我想点一杯少糖的珍珠奶茶。',
    '给妈妈发个消息说我晚一点到家。', '这个周末我们一起去附近爬山吧。']) {
    const sample = await enrollment.measure(owner, await synthesize(root, VOICE_A, text));
    assert.equal(sample.quality, 'ok'); samples.push(sample.sample_id!);
  }
  assert.equal((await enrollment.enroll(owner, samples)).status, 'enrolled');
  const initiatingBytes = await synthesize(root, VOICE_A, '请帮我买一杯奶茶，送到公司前台。');
  const payBytes = await synthesize(root, VOICE_A, '付吧。');
  const initiating = await record(initiatingBytes), pay = await record(payBytes);
  await t.test('I5 speaker-evidence clause: held-out owner initiating sentence and 付吧 pass', async () => {
    const result = await verifier.verifyPay('owner', initiating, pay);
    assert.equal(result.verdict, 'pass', JSON.stringify(result));
    assert.ok(result.initiating.speech_ms >= registry.policy.min_identify_ms);
    assert.ok(result.pay!.speech_ms >= registry.policy.min_assistant_ms);
    assert.equal(result.combined!.speech_ms, Math.min(options.carrier_ms, result.initiating.speech_ms) + result.pay!.speech_ms);
  });
  const otherBytes = await synthesize(root, VOICE_B, '我今天下午还有事情，明天再去银行吧。');
  const cut = await speechSpans(detector, otherBytes, new AbortController().signal), all = floats(otherBytes);
  const voiced = new Float32Array(cut.segments.reduce((n, s) => n + s.end_sample_exclusive - s.start_sample, 0));
  let at = 0;
  for (const span of cut.segments) {const part = all.subarray(span.start_sample, span.end_sample_exclusive); voiced.set(part, at); at += part.length;}
  const otherEmbedding = await engine.embed(voiced);
  await registry.identify(otherEmbedding, {mode: 'observe', speech_ms: voiced.length / 16, observed_at: AT});
  const other = await record(otherBytes);
  await t.test('I5 speaker-evidence clause: another initiating speaker fails despite owner pay speech', async () => {
    const result = await verifier.verifyPay('owner', other, pay);
    assert.deepEqual([result.verdict, result.reason], ['fail', 'other_speaker']);
  });
  await t.test('A6 evidence: 0.3 second audio is insufficient', async () => {
    const result = await verifier.verifyInitiating('owner', await record(initiatingBytes.subarray(0, 9600)));
    assert.equal(result.verdict, 'insufficient', JSON.stringify(result));
  });
  await t.test('I5 same-terminal clause and A6 availability: different terminal or missing audio is unavailable', async () => {
    assert.equal((await verifier.verifyPay('owner', initiating, await record(payBytes, 'phone', 'phone'))).reason, 'different_terminal');
    assert.equal((await verifier.verifyInitiating('owner', {...initiating, raw_ref: `l5:${'f'.repeat(64)}`})).reason, 'audio_missing');
  });
  await t.test('I5 speaker-evidence clause: the real registry rejects assistant voice', async () => {
    await registry.observeAssistant({voice: 'fixture_tts', embedding: otherEmbedding, speech_ms: voiced.length / 16, at: AT});
    const result = await verifier.verifyInitiating('owner', other);
    assert.deepEqual([result.verdict, result.reason], ['fail', 'assistant_voice']);
  });
  await t.test('A6 evidence: no enrollment returns unavailable', async () => {
    await registry.forgetOwner();
    const result = await verifier.verifyInitiating('owner', initiating);
    assert.deepEqual([result.verdict, result.reason], ['unavailable', 'not_enrolled']);
  });
});
