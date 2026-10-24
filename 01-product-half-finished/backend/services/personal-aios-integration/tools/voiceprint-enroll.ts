// Owner voiceprint enrollment from WAV recordings (16 kHz mono; convert with `afconvert -f WAVE -d LEI16@16000 -c 1 in out.wav`).
// Embeddings are computed here with the same sherpa model the server is configured with and sent only to the local
// integration's internal endpoint; embeddings stay on the deployment host.
//   node tools/voiceprint-enroll.ts --model <speaker.onnx> --vad <silero_vad.onnx> --key-file <internal.key> \
//     [--url http://127.0.0.1:18661] [--add] [--dry-run] one.wav two.wav three.wav four.wav five.wav
//   node tools/voiceprint-enroll.ts --list --key-file <internal.key> [--url ...]
import {VAD_POLICY} from '../src/voiceprint/engine.ts';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { measureEnrollmentSpeech, enrollmentNoiseFloor, selectEnrollmentSamples, ENROLLMENT_MAX_PCM_BYTES } from '../src/voiceprint/enrollment.ts';
import { DEFAULT_VOICEPRINT_POLICY, encodeEmbedding, speakerModelIdentity, type SpeakerModel } from '../src/voiceprint/registry.ts';

interface Sherpa {
  readWave(file: string): {samples: Float32Array; sampleRate: number};
  SpeakerEmbeddingExtractor: new (config: object) => {dim: number; createStream(): {acceptWaveform(w: object): void; inputFinished(): void};
    compute(stream: object): ArrayLike<number>};
  Vad: new (config: object, bufferSeconds: number) => {acceptWaveform(samples: Float32Array): void; isEmpty(): boolean;
    front(): {start: number; samples: Float32Array}; pop(): void; flush(): void};
}
export interface VoiceSample {file: string; embedding: Float32Array; speech_ms: number; quality: number}
/** Speech-only embedding of one recording: silero VAD keeps the voiced samples, the speaker model embeds them. */
export async function embedRecordings(files: string[], paths: {model: string; vad: string}): Promise<{speaker_model: SpeakerModel; samples: VoiceSample[]}> {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa;
  const extractor = new sherpa.SpeakerEmbeddingExtractor({model: paths.model, numThreads: 1, debug: 0});
  const speaker_model = await speakerModelIdentity(paths.model, extractor.dim);
  const samples: VoiceSample[] = [];
  for (const file of files) {
    const wave = sherpa.readWave(file);
    if (wave.sampleRate !== 16000) throw new Error(`${file}: ${wave.sampleRate} Hz; convert to 16 kHz mono first`);
    if (wave.samples.length * 2 > ENROLLMENT_MAX_PCM_BYTES) throw new Error(`${file}: recording exceeds 10 minutes`);
    const vad = new sherpa.Vad({sileroVad: {model: paths.vad, threshold: VAD_POLICY.threshold, minSpeechDuration: VAD_POLICY.min_speech_ms / 1000, minSilenceDuration: VAD_POLICY.min_silence_ms / 1000, maxSpeechDuration: VAD_POLICY.max_speech_ms / 1000, windowSize: 512},
      sampleRate: 16000, debug: 0, numThreads: 1}, 60);
    const voiced: Float32Array[] = [], spans: {start_sample: number; end_sample_exclusive: number}[] = [];
    const drain = () => {while (!vad.isEmpty()) {
      const part = vad.front();
      voiced.push(Float32Array.from(part.samples));
      spans.push({start_sample: part.start, end_sample_exclusive: part.start + part.samples.length}); vad.pop();
    }};
    for (let i = 0; i < wave.samples.length; i += 512) {vad.acceptWaveform(wave.samples.subarray(i, i + 512)); drain();}
    vad.flush(); drain();
    const speech = new Float32Array(voiced.reduce((n, part) => n + part.length, 0));
    voiced.reduce((offset, part) => {speech.set(part, offset); return offset + part.length;}, 0);
    const noisePower = enrollmentNoiseFloor(wave.samples.length, spans, n => wave.samples[n]!);
    const engine = {embed: async (part: Float32Array) => {
      const stream = extractor.createStream(); stream.acceptWaveform({sampleRate: 16000, samples: part}); stream.inputFinished();
      return Float32Array.from(extractor.compute(stream));
    }};
    const measured = await measureEnrollmentSpeech(engine, speech, noisePower,
      DEFAULT_VOICEPRINT_POLICY.min_enroll_ms, DEFAULT_VOICEPRINT_POLICY.thresholds.enroll_consistency);
    if (typeof measured === 'string') throw new Error(`${file}: ${measured}`);
    samples.push(...measured.map(sample => ({file, ...sample})));
  }

  return {speaker_model, samples: selectEnrollmentSamples(samples, DEFAULT_VOICEPRINT_POLICY.max_owner_samples)};
}

async function main(argv: string[]) {
  const flag = (name: string) => {const at = argv.indexOf(name); return at >= 0 ? argv.splice(at, 2)[1] : undefined;};
  const has = (name: string) => {const at = argv.indexOf(name); if (at >= 0) argv.splice(at, 1); return at >= 0;};
  const url = (flag('--url') ?? 'http://127.0.0.1:18661').replace(/\/$/u, ''), keyFile = flag('--key-file');
  const model = flag('--model'), vad = flag('--vad'), list = has('--list'), add = has('--add'), dry = has('--dry-run');
  const request = async (method: string, body?: unknown) => {
    if (!keyFile) throw new Error('--key-file <internal key file> is required');
    const stat = await fs.stat(keyFile);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${keyFile} must be owner-only (0600)`);
    const response = await fetch(`${url}/internal/voiceprint${method === 'POST' ? '/owner' : ''}`, {method,
      headers: {Authorization: `Bearer ${(await fs.readFile(keyFile, 'utf8')).trim()}`, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    console.log(JSON.stringify({status: response.status, body: await response.json()}, null, 2));
    if (!response.ok) process.exitCode = 1;
  };
  if (list) return request('GET');
  if (!model || !vad || argv.length === 0) throw new Error('usage: --model <speaker.onnx> --vad <silero_vad.onnx> --key-file <key> [--add] [--dry-run] <wav>...');
  const {speaker_model, samples} = await embedRecordings(argv, {model, vad});
  for (const sample of samples) console.log(`${sample.file}: ${sample.speech_ms} ms speech`);
  if (dry) return;
  await request('POST', {mode: add ? 'add' : 'replace', speaker_model,
    samples: samples.map(sample => ({embedding_base64: encodeEmbedding(sample.embedding), speech_ms: sample.speech_ms, quality: sample.quality}))});
}
if (import.meta.main) await main(process.argv.slice(2)).catch(error => {console.error(error instanceof Error ? error.message : error); process.exit(2);});
