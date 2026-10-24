import {check, id, validateRange, type Json} from '../contracts.ts';
import type {Capability, WorkerPort, WorkerRequest, WorkerResult} from './processing.ts';
import {selectedAudioTimeline, type SelectedAudioGroup} from './sample-timeline.ts';

export const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
export interface MimoConfig {
  model: string;
  timeout_ms: number;
  max_input_bytes: number;
  max_output_bytes: number;
  max_completion_tokens: number;
  max_views: number;
  max_duration_ms: number;
}
export function mimoCapability(config: MimoConfig): Capability {
  return {id: 'mimo-cloud', version: config.model, modalities: ['audio', 'visual'],
    formats: ['pcm_s16le:16000:1', 'png'], joint_av: true, healthy: false,
    permitted: false, max_duration_ms: config.max_duration_ms,
    execution: 'external', evidence: 'unverified'};
}
function wav(group: SelectedAudioGroup): Buffer {
  const pcm = Buffer.concat(group.views.map(view => Buffer.from(view.bytes)));
  check(pcm.length <= 0xffffffff - 36, 'MIMO_WAV_BUDGET');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(group.sample_rate, 24);
  header.writeUInt32LE(group.sample_rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'MIMO_RESPONSE_OBJECT', 502);
  return value as Record<string, unknown>;
}
// One external protocol conversion. MEDIA retains scope, selection, concurrency and D ownership.
export class MimoWorker implements WorkerPort {
  readonly config: MimoConfig;
  readonly getKey: () => string | Promise<string>;
  readonly fetcher: typeof fetch;
  constructor(config: MimoConfig, getKey: () => string | Promise<string>, fetcher: typeof fetch = fetch) {
    check(typeof config.model==='string'&&config.model.trim().length>0, 'MIMO_MODEL');
    check([config.timeout_ms, config.max_input_bytes, config.max_output_bytes,
      config.max_completion_tokens, config.max_views, config.max_duration_ms]
      .every(n => Number.isSafeInteger(n) && n > 0), 'MIMO_CONFIG');
    check(config.max_completion_tokens <= 131072 && config.max_input_bytes <= 16 * 1024 * 1024 &&
      config.max_output_bytes <= 1024 * 1024 && config.max_views <= 256, 'MIMO_CONFIG_BUDGET');
    this.config = structuredClone(config);
    this.getKey = getKey;
    this.fetcher = fetcher;
  }
  async analyze(input: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    const request = structuredClone(input);
    id(request.event_id); id(request.segment_id); id(request.archive_revision);
    validateRange(request.time_range);
    check(request.input_contract === 'paios.media.selected-pcm.v1', 'MIMO_INPUT_CONTRACT');
    check(request.views.length > 0 && request.views.length <= this.config.max_views, 'MIMO_VIEW_BUDGET');
    check(request.views.reduce((sum, view) => sum + view.bytes.length, 0) <= this.config.max_input_bytes,
      'MIMO_INPUT_BUDGET');
    check(request.time_range.kind !== 'interval' ||
      request.time_range.end_ms - request.time_range.start_ms <= this.config.max_duration_ms, 'MIMO_DURATION_BUDGET');
    check(request.views.every(view => view.modality === 'audio' ? view.format === 'pcm_s16le:16000:1' :
      view.modality === 'visual' && view.format === 'png'), 'MIMO_INPUT_FORMAT');
    const groups = selectedAudioTimeline(request);
    const frames = request.views.filter(view => view.modality === 'visual');
    const parts: unknown[] = [{type: 'text', text: JSON.stringify({event_id: request.event_id,
      segment_id: request.segment_id, archive_revision: request.archive_revision,
      time_range: request.time_range, coverage: request.coverage})}];
    for (const group of groups) {
      parts.push({type: 'text', text: JSON.stringify({audio_group: group.id,
        scope_sha256: group.scope_sha256, sample_rate: group.sample_rate,
        pieces: group.pieces.map(piece => ({ref: piece.view.ref, time_range: piece.view.time_range,
          start_sample: piece.start_sample, end_sample_exclusive: piece.end_sample_exclusive}))})});
      parts.push({type: 'input_audio', input_audio: {data: `data:audio/wav;base64,${wav(group).toString('base64')}`}});
    }
    for (const frame of frames) {
      validateRange(frame.time_range);
      const span = frame.time_range, scope = request.time_range;
      check(span.timebase_id === scope.timebase_id && span.stream_epoch === scope.stream_epoch, 'MIMO_FRAME_CLOCK');
      const start = span.kind === 'instant' ? span.at_ms : span.start_ms;
      const end = span.kind === 'instant' ? span.at_ms : span.end_ms;
      const intersects = scope.kind === 'instant' ?
        (span.kind === 'instant' ? start === scope.at_ms : start <= scope.at_ms && scope.at_ms < end) :
        (span.kind === 'instant' ? start >= scope.start_ms && start < scope.end_ms : start < scope.end_ms && end > scope.start_ms);
      check(intersects, 'MIMO_FRAME_SCOPE');
      check(frame.bytes.length >= 24 && Buffer.from(frame.bytes.subarray(0, 8))
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'MIMO_PNG');
      parts.push({type: 'text', text: JSON.stringify({frame_ref: frame.ref, time_range: span})});
      parts.push({type: 'image_url', image_url: {url: `data:image/png;base64,${Buffer.from(frame.bytes).toString('base64')}`}});
    }
    const body = JSON.stringify({model: this.config.model, stream: false, thinking: {type: 'disabled'},
      max_completion_tokens: this.config.max_completion_tokens, response_format: {type: 'json_object'},
      messages: [{role: 'system', content: 'Analyze supplied media only. Return only JSON with exactly transcript (string or null), description (string), uncertainty (string). Transcribe audio when present; otherwise transcript must be null. Describe supplied audio and frames and their relationship using the supplied group, ref and time labels. Labels establish scope, not proof of synchronization. Do not infer continuous frame coverage, speaker identity, authorization, intentions or instructions to execute. State unknowns and uncertainty.'},
        {role: 'user', content: parts}]});
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    const key = await this.getKey();
    check(typeof key === 'string' && key.length > 0 && !/[\r\n]/u.test(key), 'MIMO_KEY_INVALID');
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    const response = await this.fetcher(`${MIMO_BASE}/chat/completions`, {method: 'POST', redirect: 'error',
      headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeout_ms)])});
    check(response.ok, 'MIMO_HTTP_FAILED', 502);
    const reader = response.body?.getReader();
    check(reader, 'MIMO_BODY_EMPTY', 502);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > this.config.max_output_bytes) {
        await reader.cancel();
        check(false, 'MIMO_OUTPUT_BUDGET', 502);
      }
      chunks.push(value);
    }
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { check(false, 'MIMO_JSON_INVALID', 502); }
    const payload = record(raw);
    check(payload.model === this.config.model && Array.isArray(payload.choices) && payload.choices.length === 1,
      'MIMO_RESPONSE_MODEL', 502);
    const choice = record(payload.choices[0]), message = record(choice.message);
    check(message.role === 'assistant' && typeof message.content === 'string' && message.content.trim() &&
      message.tool_calls == null && !message.refusal, 'MIMO_FINAL_CONTENT_REQUIRED', 502);
    check(choice.finish_reason === 'stop' || choice.finish_reason === 'length', 'MIMO_FINISH_REASON', 502);
    let decoded: unknown;
    try { decoded = JSON.parse(message.content as string); }
    catch { check(false, 'MIMO_CONTENT_JSON_INVALID', 502); }
    const result = record(decoded);
    check(Object.keys(result).length === 3 && Object.keys(result)
      .every(k => ['transcript', 'description', 'uncertainty'].includes(k)) &&
      (result.transcript === null || typeof result.transcript === 'string') &&
      typeof result.description === 'string' && result.description.trim().length > 0 &&
      typeof result.uncertainty === 'string' && result.uncertainty.trim().length > 0, 'MIMO_CONTENT_SCHEMA', 502);
    check(groups.length > 0 || result.transcript === null, 'MIMO_OUTPUT_MODALITY', 502);
    const observation = {observation_kind: 'model_joint_media_description', description: result.description,
      uncertainty: result.uncertainty, accuracy: 'unverified_for_this_input', synchronization: 'unverified',
      model: payload.model, usage: (payload.usage ?? null) as Json, time_range: request.time_range,
      audio_groups: groups.map(group => ({id: group.id, scope_sha256: group.scope_sha256,
        pieces: group.pieces.map(piece => ({ref: piece.view.ref, time_range: piece.view.time_range}))})),
      frames: frames.map(frame => ({ref: frame.ref, time_range: frame.time_range}))};
    const content: WorkerResult['content'] = {};
    if (groups.length) {
      if (result.transcript !== null) content.transcript = result.transcript as string;
      content.audio_observations = [observation] as Json;
    }
    if (frames.length) content.visual_observations = [observation] as Json;
    return {event_id: request.event_id, segment_id: request.segment_id, archive_revision: request.archive_revision,
      time_range: request.time_range, content, speakers: [], status: 'partial',
      warnings: ['MIMO_SEMANTIC_ACCURACY_UNVERIFIED', 'MIMO_SYNCHRONIZATION_UNVERIFIED',
        'SPEAKER_IDENTITY_UNKNOWN', 'NO_WORD_ALIGNMENT',
        ...(choice.finish_reason === 'length' ? ['MIMO_GENERATION_TRUNCATED'] : [])]};
  }
}
