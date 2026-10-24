import {canonical, check, sha256} from '../contracts.ts';
import type {Json, VoiceprintSpeaker} from '../contracts.ts';
import {SOUND_EVENTS,SPEECH_EMOTIONS,type SoundEvent,type SpeechEmotion,parseSpeakerLabel} from '../voiceprint/contracts.ts';
import type {Capability, WorkerRequest, WorkerResult} from './processing.ts';
import {selectedAudioTimeline, projectSampleInterval} from './sample-timeline.ts';
import type {SelectedAudioGroup, SampleProjection} from './sample-timeline.ts';

export interface SampleAudioResult {
  schema: 'paios.media.audio-sample-result.v1';
  kind: 'transcription' | 'speech_signal';
  input_id: string;
  scope_sha256: string;
  pcm_sha256: string;
  sample_rate: number;
  sample_count: number;
  model: {id: string; version: string; device: string; dtype?: string; native_metadata?: Json};
  raw_text?: string;
  /** `speaker`/`speaker_score` from a local voiceprint capability are speakerLabel(identify()) and its score; `wake` is the
   *  keyword a local keyword spotter heard in the segment and the segment-relative sample where the wake word ends;
   *  `lang` the recognizer's language code. */
  segments: {start_sample: number; end_sample_exclusive: number; text?: string; speaker?: string; speaker_score?: number; call_only?: true;
    wake?: {keyword: string; end_sample: number}; lang?: string; event?: SoundEvent; emotion?: SpeechEmotion}[];
  generation?: Json;
}
export interface SampleVadCandidate {
  start_ms: number;
  end_ms: number;
  semantic_status: 'open';
  basis: string;
  source_parts?: SampleProjection[];
  model?: SampleAudioResult['model'];
}
export function sampleInput(group: SelectedAudioGroup) {
  return {input_id: group.id, scope_sha256: group.scope_sha256,
    pcm_sha256: sha256(Buffer.concat(group.views.map(view => Buffer.from(view.bytes)))),
    sample_rate: group.sample_rate, sample_count: group.total_samples};
}
function validateResult(result: SampleAudioResult, request: WorkerRequest,
  kind: SampleAudioResult['kind']): {group: SelectedAudioGroup; parts: SampleProjection[][]} {
  check(result.schema === 'paios.media.audio-sample-result.v1' && result.kind === kind,
    'MEDIA_SAMPLE_RESULT_KIND_INVALID');
  const group = selectedAudioTimeline(request).find(candidate => candidate.id === result.input_id);
  check(group && canonical(sampleInput(group)) === canonical({input_id: result.input_id,
    scope_sha256: result.scope_sha256, pcm_sha256: result.pcm_sha256,
    sample_rate: result.sample_rate, sample_count: result.sample_count}), 'MEDIA_SAMPLE_RESULT_INPUT_MISMATCH');
  check(result.model && [result.model.id, result.model.version, result.model.device].every(value =>
    typeof value === 'string' && value.length > 0) &&
    (result.model.dtype === undefined || typeof result.model.dtype === 'string' && result.model.dtype.length > 0),
    'MEDIA_SAMPLE_RESULT_MODEL_INVALID');
  check(canonical(result.model).length <= 1048576, 'MEDIA_SAMPLE_RESULT_METADATA_BUDGET_EXCEEDED');
  if (result.model.native_metadata !== undefined)
    check(canonical(result.model.native_metadata).length <= 1048576, 'MEDIA_SAMPLE_RESULT_METADATA_BUDGET_EXCEEDED');
  if (result.generation !== undefined)
    check(canonical(result.generation).length <= 1048576, 'MEDIA_SAMPLE_RESULT_METADATA_BUDGET_EXCEEDED');
  check(result.raw_text === undefined || typeof result.raw_text === 'string' && result.raw_text.length <= 1048576, 'MEDIA_SAMPLE_RESULT_TEXT_INVALID');
  check(Array.isArray(result.segments) && result.segments.length <= 10000, 'MEDIA_SAMPLE_RESULT_SEGMENTS_INVALID');
  check(canonical(result.segments).length <= 1048576, 'MEDIA_SAMPLE_RESULT_METADATA_BUDGET_EXCEEDED');
  const parts = result.segments.map(segment => {
    check(segment && (segment.text === undefined || typeof segment.text === 'string') &&
      (segment.speaker === undefined || typeof segment.speaker === 'string' && segment.speaker.length > 0) &&
      (segment.call_only === undefined || segment.call_only === true && segment.speaker === 'owner') &&
      (segment.speaker_score === undefined || segment.speaker !== undefined && Number.isFinite(segment.speaker_score) &&
        segment.speaker_score >= -1 && segment.speaker_score <= 1) &&
      (segment.wake === undefined || segment.wake !== null && typeof segment.wake === 'object' && Object.keys(segment.wake).sort().join(',') === 'end_sample,keyword' &&
        typeof segment.wake.keyword === 'string' && /^\S{1,32}$/u.test(segment.wake.keyword) && Number.isSafeInteger(segment.wake.end_sample) &&
        segment.wake.end_sample >= 0 && segment.wake.end_sample <= segment.end_sample_exclusive - segment.start_sample) &&
      (segment.event === undefined || SOUND_EVENTS.includes(segment.event)) &&
      (segment.emotion === undefined || SPEECH_EMOTIONS.includes(segment.emotion)) &&
      (segment.lang === undefined || typeof segment.lang === 'string' && /^[a-z]{2,8}$/u.test(segment.lang)),
      'MEDIA_SAMPLE_RESULT_ANNOTATION_INVALID');
    return projectSampleInterval(group!, segment.start_sample, segment.end_sample_exclusive, request);
  });
  return {group: group!, parts};
}

function modelMetadata(model: SampleAudioResult['model']): SampleAudioResult['model'] {
  return {id: model.id, version: model.version, device: model.device,
    ...(model.dtype === undefined ? {} : {dtype: model.dtype}),
    ...(model.native_metadata === undefined ? {} : {native_metadata: model.native_metadata})};
}

// Processor owns classification and identities. Native EOS/parser markers are raw
// metadata and cannot upgrade model accuracy or establish a user's identity.
export function finalizeSampleTranscription(result: SampleAudioResult, request: WorkerRequest,
  capability: Capability): WorkerResult {
  const {parts} = validateResult(result, request, 'transcription');
  check(selectedAudioTimeline(request).length === 1 && capability.modalities.includes('audio'),
    'MEDIA_SAMPLE_TRANSCRIPTION_SCOPE_INVALID');
  check(result.model.id === capability.id && result.model.version === capability.version,
    'MEDIA_SAMPLE_RESULT_CAPABILITY_MISMATCH');
  check(typeof result.raw_text === 'string', 'MEDIA_SAMPLE_RESULT_RAW_TEXT_REQUIRED');
  // Only the configured local voiceprint worker's labels name people; any other model's labels stay model-local.
  const voiceprint = capability.speaker_identity === 'local_voiceprint' && capability.execution === 'local';
  if (voiceprint) check(result.segments.every(segment => segment.speaker === undefined || parseSpeakerLabel(segment.speaker)),
    'MEDIA_SAMPLE_RESULT_SPEAKER_INVALID');
  // A wake word starts a request run: only an on-device keyword spotter may report one.
  check(capability.execution === 'local' || result.segments.every(segment => segment.wake === undefined), 'MEDIA_SAMPLE_RESULT_WAKE_INVALID');
  check(voiceprint || result.segments.every(segment=>segment.call_only===undefined),'MEDIA_SAMPLE_RESULT_SPEAKER_INVALID');
  const scope = voiceprint ? 'local_voiceprint' : 'model_local';
  const segments = result.segments.map((segment, index) => ({
    start_sample: segment.start_sample, end_sample_exclusive: segment.end_sample_exclusive,
    ...(segment.text === undefined ? {} : {text: segment.text}),
    ...(segment.lang === undefined ? {} : {lang: segment.lang}),
    ...(segment.event === undefined ? {} : {event: segment.event}),
    ...(segment.emotion === undefined ? {} : {emotion: segment.emotion}),
    ...(segment.wake === undefined ? {} : {wake: segment.wake}),
    ...(segment.speaker === undefined ? {} : {speaker: segment.speaker}),
    ...(segment.speaker === undefined ? {} : {speaker_identity: voiceprint ? parseSpeakerLabel(segment.speaker)!.kind : 'unknown', identity_scope: scope}),
    ...(segment.speaker_score === undefined ? {} : {speaker_score: segment.speaker_score}),
    ...(segment.call_only?{call_only:true}:{}),
    source_parts: parts[index]}));
  const labels = [...new Set(result.segments.flatMap(segment => segment.speaker === undefined ? [] : [segment.speaker]))];
  const observation = {observation_kind: 'sample_transcription', segments, model: modelMetadata(result.model),
    ...(result.generation === undefined ? {} : {generation: result.generation}),
    evidence: {annotation_coverage: 'unverified', accuracy: 'unaccepted', speaker_identity: voiceprint ? 'local_voiceprint' : 'unknown'}};
  return {event_id: request.event_id, segment_id: request.segment_id, archive_revision: request.archive_revision,
    time_range: request.time_range, content: {transcript: result.raw_text, audio_observations: [observation as unknown as Json]},
    speakers: voiceprint ? voiceprintSpeakers(result) as unknown as Json[] :
      labels.map(label => ({model_local_label: label, user_identity: 'unknown', identity_scope: 'model_local'})),
    warnings: ['SAMPLE_ANNOTATION_COVERAGE_UNVERIFIED', 'TRANSCRIPTION_ACCURACY_UNACCEPTED',
      ...(labels.length && !voiceprint ? ['MODEL_LOCAL_SPEAKERS_ARE_NOT_USER_IDENTITIES'] : [])], status: 'partial'};
}
/** Per-label speech totals; unlabeled segments are `unknown` speech, never silently dropped. */
function voiceprintSpeakers(result: SampleAudioResult): VoiceprintSpeaker[] {
  const totals = new Map<string, VoiceprintSpeaker>();
  for (const segment of result.segments) {
    const label = segment.speaker ?? 'unknown', ms = Math.round((segment.end_sample_exclusive - segment.start_sample) * 1000 / result.sample_rate);
    const entry = totals.get(label) ?? {identity_scope: 'local_voiceprint', voiceprint: label as VoiceprintSpeaker['voiceprint'], score: null, speech_ms: 0, segments: 0};
    if(segment.call_only)entry.call_only=true;
    entry.speech_ms += ms; entry.segments += 1;
    // The weakest segment speaks for the label: one low-confidence stretch must not hide behind a strong one.
    if (segment.speaker_score !== undefined) entry.score = entry.score === null ? segment.speaker_score : Math.min(entry.score, segment.speaker_score);
    totals.set(label, entry);
  }
  return [...totals.values()];
}

// Service owns logical speech candidates: one native interval produces one open C
// across contiguous source pieces, never one candidate per chunk or semantic Stop.
export function finalizeSampleSignals(results: SampleAudioResult[], request: WorkerRequest,
  maxCandidates: number): SampleVadCandidate[] {
  check(Number.isSafeInteger(maxCandidates) && maxCandidates > 0, 'MEDIA_SEGMENT_BUDGET_INVALID');
  const groups = selectedAudioTimeline(request);
  check(results.length === groups.length && new Set(results.map(result => result.input_id)).size === results.length,
    'MEDIA_SAMPLE_SIGNAL_COVERAGE_INVALID');
  const candidates: SampleVadCandidate[] = [];
  for (const group of groups) {
    const result = results.find(candidate => candidate.input_id === group.id);
    check(result, 'MEDIA_SAMPLE_SIGNAL_COVERAGE_INVALID');
    const {parts} = validateResult(result, request, 'speech_signal');
    for (const sourceParts of parts) {
      const clipped = sourceParts.flatMap(part => part.clipped_scope_range ? [part.clipped_scope_range] : []);
      if (!clipped.length) continue;
      candidates.push({start_ms: clipped[0]!.start_ms, end_ms: clipped.at(-1)!.end_ms,
        semantic_status: 'open', basis: 'sample_speech_signal', source_parts: sourceParts, model: modelMetadata(result.model)});
      check(candidates.length <= maxCandidates, 'MEDIA_SEGMENT_BUDGET_EXCEEDED', 413);
    }
  }
  return candidates;
}
