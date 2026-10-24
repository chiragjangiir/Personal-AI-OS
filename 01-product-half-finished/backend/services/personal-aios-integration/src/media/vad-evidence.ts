import {publishRawRecord} from '../stream-archive.ts';
import {canonical, check, digest} from '../contracts.ts';
import type {Json, MediaSegment} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {WorkerRequest} from './processing.ts';
import type {SampleAudioResult, SampleVadCandidate} from './sample-results.ts';
import {selectedAudioTimeline, projectSampleIntervals} from './sample-timeline.ts';
import type {SampleProjectionBatch} from './sample-timeline.ts';

export function legacyVadCandidate(candidate: SampleVadCandidate, request: WorkerRequest): SampleVadCandidate {
  const scope = request.time_range;
  check(scope.kind === 'interval' && candidate.semantic_status === 'open' &&
    typeof candidate.basis === 'string' && candidate.basis.length > 0 && candidate.basis.length <= 1000 &&
    Number.isFinite(candidate.start_ms) && Number.isFinite(candidate.end_ms) &&
    candidate.start_ms >= scope.start_ms && candidate.end_ms <= scope.end_ms && candidate.end_ms > candidate.start_ms,
    'MEDIA_VAD_RANGE_INVALID', 422);
  const batches: SampleProjectionBatch[] = [];
  for (const group of selectedAudioTimeline(request)) {
    const intervals: SampleProjectionBatch['intervals'][number][] = [];
    for (const piece of group.pieces) {
      const mapped = piece.view.time_range;
      check(mapped.kind === 'interval', 'MEDIA_PCM_INTERVAL_REQUIRED');
      const start = Math.max(candidate.start_ms, mapped.start_ms), end = Math.min(candidate.end_ms, mapped.end_ms);
      if (end <= start) continue;
      const count = piece.end_sample_exclusive - piece.start_sample;
      const position = (time: number) => piece.start_sample + (time - mapped.start_ms) / (mapped.end_ms - mapped.start_ms) * count;
      const first = Math.max(piece.start_sample, Math.min(piece.end_sample_exclusive, position(start)));
      const last = Math.max(piece.start_sample, Math.min(piece.end_sample_exclusive, position(end)));
      intervals.push({start_sample: first, end_sample_exclusive: last});
    }
    if (intervals.length) batches.push({group, intervals});
  }
  const sourceParts = batches.length ? projectSampleIntervals(batches, request) : [];
  check(sourceParts.length > 0, 'MEDIA_VAD_SOURCE_SUPPORT_REQUIRED', 422);
  // Legacy ports report milliseconds. Their arbitrary metadata cannot establish
  // a model identity or source provenance; both are reconstructed or left absent.
  return {start_ms: candidate.start_ms, end_ms: candidate.end_ms, semantic_status: 'open',
    basis: candidate.basis, source_parts: sourceParts};
}

export async function publishVadEvidence(storage: StoragePort, segment: MediaSegment, prepared: WorkerRequest,
  resultKind: 'sample_result' | 'legacy_candidates', candidates: SampleVadCandidate[], signal: AbortSignal,
  sampleResults: SampleAudioResult[] = []): Promise<string> {
  check(!signal.aborted, 'MEDIA_CANCELLED', 409);
  selectedAudioTimeline(prepared);
  const views = prepared.views.map(({bytes: _bytes, ...metadata}) => metadata);
  const record = {schema: 'paios.media.vad-selection.v1', authority: 'central_media_c_owner',
    selection_status: 'validated', processed_event_publication: 'not_asserted',
    input: {event_id: prepared.event_id, raw_ref: segment.raw_ref, archive_revision: prepared.archive_revision,
      segment_id: prepared.segment_id, time_range: prepared.time_range, input_contract: prepared.input_contract,
      coverage: prepared.coverage, sealed_basis_refs: segment.continuation.basis_refs.filter(ref => ref.startsWith('l5-view:')),
      selected_views: views},
    result: {kind: resultKind, semantic_status: 'open', candidates,
      producers: sampleResults.map(result => ({input_id: result.input_id, model: {
        id: result.model.id, version: result.model.version, device: result.model.device,
        ...(result.model.dtype === undefined ? {} : {dtype: result.model.dtype}),
        ...(result.model.native_metadata === undefined ? {} : {native_metadata: result.model.native_metadata})}}))}};
  const encoded = canonical(record);
  const bytes = new TextEncoder().encode(encoded);
  check(bytes.length <= 1048576, 'MEDIA_VAD_EVIDENCE_BUDGET_EXCEEDED', 413);
  const key = digest(record);
  const winner = await publishRawRecord(storage,segment.raw_ref,'media-vad-selections', key, bytes);
  check(new TextDecoder().decode(winner) === encoded, 'MEDIA_VAD_EVIDENCE_CONFLICT', 409);
  check(!signal.aborted, 'MEDIA_CANCELLED', 409);
  return `l5-vad:${key}`;
}

// Existing D remains immutable. Only its own evidence refs are restored for a
// replay; Processor still validates the record, fingerprint and cached D.
export async function vadRefsForCandidate(storage: StoragePort, segment: MediaSegment, revision: number,
  freshRef: string): Promise<string[]> {
  const key = digest([segment.raw_ref, segment.segment_id, revision]);
  try {
    const cached = JSON.parse(new TextDecoder().decode(await storage.read('processed-media', key))) as
      {continuation?: {basis_refs?: Json}};
    check(cached.continuation && Array.isArray(cached.continuation.basis_refs) &&
      cached.continuation.basis_refs.every(ref => typeof ref === 'string'), 'MEDIA_D_RECORD_CONFLICT', 409);
    return (cached.continuation.basis_refs as string[]).filter(ref => ref.startsWith('l5-vad:'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [freshRef];
    throw error;
  }
}
