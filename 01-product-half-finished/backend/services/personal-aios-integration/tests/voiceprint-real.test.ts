// Real ERes2NetV2 embeddings of macOS TTS voices through the enrollment CLI's embedding path and the registry. Skips without
// the sherpa models or `say`. Audio is generated at runtime; inference is kept to a handful of utterances.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PosixStorage } from '../src/storage.ts';
import { VoiceprintRegistry } from '../src/voiceprint/registry.ts';
import { embedRecordings } from '../tools/voiceprint-enroll.ts';

const models = process.env.PAIOS_SHERPA_MODELS ?? '/opt/personal-aios-runtime/models/sherpa';
const paths = {model: join(models, '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx'), vad: join(models, 'silero_vad.onnx')};
const hasSay = (() => {try {execFileSync('which', ['say', 'afconvert'], {stdio: 'ignore'}); return true;} catch {return false;}})();
const skip = !existsSync(paths.model) || !existsSync(paths.vad) ? 'sherpa speaker/VAD models unavailable' : !hasSay ? 'macOS say/afconvert unavailable' : false;

test('real embeddings: enroll a voice, verify it held out, keep other voices off the owner and cluster them', {skip, timeout: 300000}, async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'paios-voiceprint-real-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const speak = (voice: string, text: string, name: string) => {
    const aiff = join(dir, `${name}.aiff`), wav = join(dir, `${name}.wav`);
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    return wav;
  };
  const owner = ['今天下午三点提醒我去开会', '帮我查一下明天北京的天气', '我想点一杯少糖的珍珠奶茶', '给妈妈发个消息说我晚点到家',
    '这个周末我们一起去爬山吧', '请帮我叫一辆车去机场'].map((text, i) => speak('Tingting', text, `owner-${i}`));
  // Clustering needs at least 2 s in the selected canonical window, not just in the full recording.
  const others = [speak('Sinji', '你知道附近有什么好吃的餐厅吗。你知道附近有什么好吃的餐厅吗。', 'sinji-0'),
    speak('Sinji', '把客厅的灯关掉然后放点音乐。把客厅的灯关掉然后放点音乐。', 'sinji-1'),
    speak('Grandpa (中文（中国大陆）)', '你知道附近有什么好吃的餐厅吗。你知道附近有什么好吃的餐厅吗。', 'grandpa-0')];
  const files = [...owner, ...others];
  const {speaker_model, samples: windows} = await embedRecordings(files, paths);
  // Enrollment now exposes multiple canonical windows per recording; keep held-out utterances separate.
  const samples = files.map(file => windows.find(sample => sample.file === file)!);
  assert.equal(speaker_model.dim, 192); assert.match(speaker_model.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(samples.every(sample => sample.speech_ms >= 1500), JSON.stringify(samples.map(s => s.speech_ms)));
  const registry = new VoiceprintRegistry(new PosixStorage(join(dir, 'store')), speaker_model);
  assert.ok(samples.slice(6).every(sample => sample.speech_ms >= registry.policy.min_cluster_ms));
  const at = '2026-10-09T08:00:00.000Z';
  // An enrollment with another voice mixed in is refused.
  await assert.rejects(registry.enrollOwner({speaker_model, channel: 'file', mode: 'replace', samples: [...samples.slice(0, 4), samples[6]!]}),
    /VOICEPRINT_ENROLLMENT_INCONSISTENT/);
  const enrolled = await registry.enrollOwner({speaker_model, channel: 'file', mode: 'replace', samples: samples.slice(0, 5), at});
  assert.ok(enrolled.consistency!.min >= 0.6, JSON.stringify(enrolled.consistency));
  const held = await registry.identify(samples[5]!.embedding, {speech_ms: samples[5]!.speech_ms, observed_at: at, mode: 'verify'});
  assert.deepEqual([held.kind, held.kind === 'owner' && held.band], ['owner', 'verified']);
  const first = await registry.identify(samples[6]!.embedding, {speech_ms: samples[6]!.speech_ms, observed_at: at, mode: 'observe'});
  const second = await registry.identify(samples[7]!.embedding, {speech_ms: samples[7]!.speech_ms, observed_at: at, mode: 'observe'});
  const third = await registry.identify(samples[8]!.embedding, {speech_ms: samples[8]!.speech_ms, observed_at: at, mode: 'observe'});
  assert.equal(first.kind, 'speaker'); assert.deepEqual(second, {...first, score: second.kind === 'speaker' ? second.score : NaN});
  assert.equal(third.kind, 'speaker'); assert.notEqual(third.kind === 'speaker' && third.cluster_id, first.kind === 'speaker' && first.cluster_id);
});
