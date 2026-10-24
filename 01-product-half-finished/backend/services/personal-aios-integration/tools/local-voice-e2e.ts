// Local H-voice end-to-end runner (developer tool, not a product entry point).
// WAV (16 kHz mono s16le) → L5 stream → voice window → Qwen candidate → formal voice_send receipt → D
// → Admission → real Hermes native run → sealed OUT (text, optional Mac system TTS WAV).
// Usage: node tools/local-voice-e2e.ts <run-dir> [--fake-asr "<transcript>"]
//   <run-dir>/local-e2e.json holds paths only (no secret values). Hermes is spawned from the isolated profile.
//   --fake-asr replaces only the DashScope socket with a scripted one; Hermes, model, OUT and TTS stay real.
import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter, once} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {provisionCentralResources, type CentralProvisionConfiguration} from '../src/main.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {MediaProcessor} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';
import {createQwenVoiceResources} from '../src/voice/qwen-resources.mjs';
import {createFormalVoiceAuthority} from '../src/voice/formal-authority.ts';
import {sha256, type RawEvent, type TimeRange} from '../src/contracts.ts';
import type {ClockMap} from '../src/media/align.ts';
import type {TrackChunk} from '../src/stream-archive.ts';

interface RunConfig {
  central: CentralProvisionConfiguration; audio_file: string; session_id: string;
  hermes: {python: string; root: string; home: string; port: number; provider_key_file: string; provider_key_env: string; loader: string};
  device: {principal_id: string; device_id: string; device_type: 'phone'|'mac'|'glasses'|'watch'; output_modes: string[]};
}
// Live-call measurements use the existing encrypted subscriber probe and never start a main-agent profile.
if(process.argv.includes('--call')){await import('../../../phase0/gateway/tools/call-front-probe.ts');process.exit(process.exitCode??0);}
const runDir = process.argv[2];
if (!runDir) throw new Error('usage: local-voice-e2e.ts <run-dir> [--fake-asr text]');
const fakeIndex = process.argv.indexOf('--fake-asr');
const fakeText = fakeIndex > 0 ? process.argv[fakeIndex + 1] : undefined;
const config = JSON.parse(await readFile(join(runDir, 'local-e2e.json'), 'utf-8')) as RunConfig;
const log = (stage: string, detail: Record<string, unknown> = {}) => console.log(JSON.stringify({t: new Date().toISOString(), stage, ...detail}));
const secret = async (path: string) => (await readFile(path, 'utf-8')).trim();

// Scripted DashScope socket: same ws ABI the frontend core uses; emits one completed transcription after commit.
class ScriptedSocket extends EventEmitter {
  static OPEN = 1; readyState = 1; bufferedAmount = 0;
  constructor() {super(); queueMicrotask(() => {this.emit('open'); this.incoming({type: 'session.created'});});}
  incoming(event: unknown) {this.emit('message', Buffer.from(JSON.stringify(event)));}
  send(wire: string) {
    const event = JSON.parse(wire);
    if (event.type === 'session.update') queueMicrotask(() => this.incoming({type: 'session.updated'}));
    if (event.type === 'input_audio_buffer.commit') setTimeout(() => this.incoming({
      type: 'conversation.item.input_audio_transcription.completed', item_id: 'item:scripted', transcript: fakeText}), 50);
  }
  close() {this.readyState = 3; queueMicrotask(() => this.emit('close'));}
  terminate() {this.close();}
}

let hermes: ChildProcess | undefined, hermesClosed = Promise.resolve();
async function startHermes(): Promise<void> {
  const h = config.hermes;
  const env: Record<string, string> = {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8',
    HERMES_HOME: h.home, PYTHONPATH: h.root, API_SERVER_KEY: await secret(config.central.hermes_key_file),
    API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: String(h.port), NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    [h.provider_key_env]: await secret(h.provider_key_file)};
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'SSL_CERT_FILE'])
    if (process.env[name]) env[name] = process.env[name]!;
  const child = hermes = spawn(h.python, [h.loader], {cwd: h.root, env, stdio: ['ignore', 'pipe', 'pipe']});
  hermesClosed = new Promise(resolve => child.once('close', () => resolve()));
  const ready = Promise.withResolvers<void>();
  const timer = setTimeout(() => ready.reject(new Error('HERMES_START_TIMEOUT')), 60000);
  const scan = (data: Buffer) => {
    const text = data.toString();
    process.stderr.write(text.split('\n').filter(Boolean).map(line => `[hermes] ${line}\n`).join(''));
    if (text.includes('Hermes native API ready')) ready.resolve();
  };
  child.stdout!.on('data', scan); child.stderr!.on('data', scan);
  child.once('error', error => ready.reject(error));
  child.once('exit', code => ready.reject(new Error(`HERMES_EXITED_${code}`)));
  try {await ready.promise;} finally {clearTimeout(timer);}
}

const wav = await readFile(config.audio_file);
check16kMono(wav);
const dataOffset = wav.indexOf('data', 12) + 8;
let pcm = wav.subarray(dataOffset, dataOffset + wav.readUInt32LE(dataOffset - 4));
pcm = pcm.subarray(0, pcm.length - (pcm.length % 32)); // whole milliseconds (16 samples × 2 bytes)
const totalMs = pcm.length / 32;
log('audio', {file: config.audio_file, sha256: sha256(wav), duration_ms: totalMs, mode: fakeText ? 'scripted_asr' : 'real_qwen'});

const evidence: Record<string, unknown> = {mode: fakeText ? 'scripted_asr' : 'real_qwen', audio_sha256: sha256(wav), duration_ms: totalMs};
let exitCode = 1, provision: Awaited<ReturnType<typeof provisionCentralResources>> | undefined,
  assembly: ReturnType<typeof createPersonalAIOSAssembly> | undefined;
try {
  await startHermes();
  log('hermes_ready', {port: config.hermes.port});
  provision = await provisionCentralResources(config.central);
  const {tts, formal_voice: _formalVoice, voice: provisionedVoice, ...central} = provision.resources;
  const storage = central.storage;
  const budget = {max_chunk_bytes: 64000, max_total_bytes: 4_000_000, max_chunks: 64, max_revisions: 128, max_seq: 1000};
  const archive = new RawArchive(storage, config.central.max_event_bytes, undefined, budget);
  const processor = new MediaProcessor(storage, new Map(), {policy_version: 'local-voice-e2e-1', max_inflight: 2,
    max_input_bytes: 4_000_000, timeout_ms: 180000, allow_external: true, allow_replay: false, allow_partial: true});
  const media = new MediaService({storage, archive, streamArchive: new StreamArchive(storage, budget), processor,
    capabilities: async () => [], align: {max_chunks: 64, max_visual_refs: 1, max_frame_gap_ms: 100, max_uncertainty_ms: 20},
    max_segments: 4, max_window_ms: 60000, fixtureOnly: true});
  const voice = fakeText ? createQwenVoiceResources({configuration: {usable: true, provider: 'dashscope',
    model: 'qwen3.8-omni-flash-realtime', region: 'cn-beijing', endpoint: 'wss://scripted.invalid/api-ws/v1/realtime',
    voice: 'Tina', instructions: '只产候选。', apiKey: 'scripted-offline-only', WebSocket: ScriptedSocket},
    ...createFormalVoiceAuthority(storage), onError: error => log('voice_error', {error: String(error)})}) : provisionedVoice;
  if (!voice) throw new Error('voice_frontend config (or --fake-asr) is required');
  const token = await secret(join(runDir, 'device.key'));
  assembly = createPersonalAIOSAssembly({...central, native: provision.native, archive, media,
    devices: [{...config.device, consent_ref: 'local-e2e-consent', channel: 'local_voice_e2e', route_version: 'local-route-1',
      token_sha256: sha256(token)}],
    voice, ...(tts ? {output: {tts}} : {}),
    audio_route: async (_source, event) => ({consumer: 'voice', source_scope: 'local-voice-e2e', capture_span: event.raw_ref,
      purpose_evidence_ref: 'local-e2e-consent'})});
  const listening = once(assembly.server, 'listening');assembly.server.listen(config.central.port, '127.0.0.1');await listening;
  const {runtime} = assembly;
  const device = await runtime.authenticate(token);
  const eventId = `local-voice-${Date.now()}`, capturedAt = new Date().toISOString();
  let appended: {event: {raw_ref: string; archive_revision: string}} | undefined;
  for (let start = 0, seq = 0; start < pcm.length; start += 32000, seq++) {
    const bytes = pcm.subarray(start, Math.min(start + 32000, pcm.length));
    const startMs = start / 32, endMs = startMs + bytes.length / 32;
    const raw: RawEvent = {schema_version: 'paios.event.v1', event_id: eventId, device_id: config.device.device_id,
      device_type: config.device.device_type, captured_at: capturedAt, source: {channel: 'local_voice_e2e'},
      media_type: 'audio', mime: 'audio/pcm', representation: 'received_decoded_sample', payload: bytes};
    const chunk: TrackChunk = {track_id: 'mic', stream_epoch: 'e1', seq, modality: 'audio', format: 'pcm_s16le:16000:1',
      source_range: {kind: 'interval', timebase_id: 'capture', stream_epoch: 'e1', start_ms: startMs, end_ms: endMs}};
    appended = await runtime.appendMedia(raw, device, chunk) as typeof appended;
  }
  log('archived', {raw_ref: appended!.event.raw_ref, archive_revision: appended!.event.archive_revision});
  const clock: ClockMap = {modality: 'audio', track_id: 'mic', stream_epoch: 'e1', source_timebase_id: 'capture',
    target_timebase_id: 'local-common', offset_ms: 0, drift_ppm: 0, uncertainty_ms: 1, basis_ref: 'clock:local-e2e-synthetic'};
  const window: TimeRange = {kind: 'interval', timebase_id: 'local-common', start_ms: 0, end_ms: totalMs};
  const op = `voice-op-${Date.now()}`, session = config.session_id;
  const started = Date.now();
  const processing = runtime.processVoice(device, session, op, {...appended!.event, time_range: window, clock_maps: [clock]});
  void processing.catch(() => {});
  let candidate: Awaited<ReturnType<typeof runtime.formalVoiceCandidates>>[number] | undefined;
  for (let i = 0; i < 600 && !candidate; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {candidate = (await runtime.formalVoiceCandidates(device, session, op)).find(value => value.kind === 'transcript');}
    catch (error) {if (!/VOICE_WINDOW_CLOSED|VOICE_CANDIDATE_SNAPSHOT_CHANGED|VOICE_WINDOW_SCOPE/.test(String(error))) throw error;}
  }
  if (!candidate) throw new Error('NO_TRANSCRIPT_CANDIDATE', {cause: await processing.catch(error => error)});
  log('candidate', {transcript: candidate.transcript, asr_ms: Date.now() - started});
  evidence.transcript = candidate.transcript; evidence.asr_ms = Date.now() - started;
  const confirmed = await runtime.confirmFormalVoice(device, session, op, {candidate_ref: candidate.candidate_ref,
    candidate_revision: candidate.candidate_revision, window_ref: candidate.window_ref,
    selected_input_sha256: candidate.selected_input_sha256, transcript_sha256: candidate.transcript_sha256!});
  const result = await processing;
  const accepted = result.events[0]!;
  const dId = accepted.processed_event.processed_event_id;
  log('confirmed', {status: confirmed.status, processed_event_id: dId, admission: accepted.admission.state});
  evidence.processed_event_id = dId;
  let final: Awaited<ReturnType<typeof runtime.result>> | undefined;
  for (let i = 0; i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {final = await runtime.result(device, session, dId);} catch (error) {
      if (!/RUN_NOT_ACCEPTED|NATIVE_RUN_NOT_TERMINAL|RUN_RUNNING|not.*terminal/i.test(String(error))) log('result_poll', {error: String(error)});
      continue;
    }
    if (['completed', 'failed', 'cancelled'].includes(String(final.result?.run_status))) break;
  }
  const r = final?.result as Record<string, unknown> | undefined;
  const reply = final ? {run_status: r?.run_status, result_status: r?.result_status, reply_status: r?.reply_status,
    reply_mode: r?.reply_mode, delivery_status: r?.delivery_status, voice_status: r?.voice_status, warnings: r?.warnings,
    reply_text: final.chunks.map(chunk => chunk.text).join(''), text_chunks: final.chunks.length,
    voice_chunks: (final as {voice_chunks?: unknown[]}).voice_chunks?.length ?? 0} : undefined;
  if (final && ['voice', 'text_and_voice'].includes(String(r?.reply_mode))) {
    let voiceChunk: {audio: {ref: string; duration_ms: number}} | undefined;
    for (let i = 0; i < 90 && !voiceChunk; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const again = await runtime.result(device, session, dId);
      if (reply) reply.voice_status = again.result.voice_status;
      voiceChunk = again.voice_chunks?.[0];
      if (again.result.voice_status === 'failed') break;
    }
    if (voiceChunk) {
      const audio = await runtime.audio(device, session, dId, voiceChunk.audio.ref) as {bytes: Uint8Array; sha256: string};
      const file = join(runDir, `reply-${Date.now()}.wav`);
      await writeFile(file, audio.bytes);
      if (reply) Object.assign(reply, {voice_chunks: 1, voice_wav: file, voice_sha256: audio.sha256, voice_duration_ms: voiceChunk.audio.duration_ms});
    }
  }
  log('result', {...reply, total_ms: Date.now() - started});
  evidence.result = reply; evidence.total_ms = Date.now() - started;
  exitCode = r?.run_status === 'completed' ? 0 : 1;
} catch (error) {
  log('failed', {error: String(error), cause: String((error as Error).cause ?? '')});
  evidence.error = String(error);
} finally {
  for (const close of [() => assembly?.close(), () => provision?.release()]) {
    try {await close();} catch (error) {exitCode = 1;evidence.cleanup_error = String(error);log('close_error', {error: String(error)});}
  }
  if (hermes) {
    if (hermes.exitCode === null && hermes.signalCode === null) hermes.kill('SIGTERM');
    const timer = setTimeout(() => hermes!.kill('SIGKILL'), 5000);
    try {await hermesClosed;} finally {clearTimeout(timer);}
  }
  log('stopped', {exit: exitCode});
  process.exitCode = exitCode;
  await writeFile(join(runDir, `evidence-${Date.now()}.json`), JSON.stringify(evidence, null, 2));
}

function check16kMono(bytes: Buffer) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV_REQUIRED');
  const fmt = bytes.indexOf('fmt ', 12) + 8;
  if (bytes.readUInt16LE(fmt) !== 1 || bytes.readUInt16LE(fmt + 2) !== 1 || bytes.readUInt32LE(fmt + 4) !== 16000 ||
    bytes.readUInt16LE(fmt + 14) !== 16) throw new Error('PCM_S16LE_16K_MONO_REQUIRED');
}
