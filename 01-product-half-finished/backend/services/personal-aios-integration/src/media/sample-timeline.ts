import {canonical, check, digest, sha256, validateRange} from '../contracts.ts';
import type {TimeRange} from '../contracts.ts';
import type {MediaView} from './align.ts';
import type {PcmSelection, WorkerRequest} from './processing.ts';

type Interval = Extract<TimeRange, {kind: 'interval'}>;
type SelectedView = WorkerRequest['views'][number];
export interface SelectedAudioPiece {
  view_index: number;
  start_sample: number;
  end_sample_exclusive: number;
  view: SelectedView;
}
export interface SelectedAudioGroup {
  id: string;
  scope_sha256: string;
  sample_rate: number;
  total_samples: number;
  views: SelectedView[];
  pieces: SelectedAudioPiece[];
}
export interface SampleProjection {
  view_ref: string;
  track_id: string;
  stream_epoch: string;
  seq: number;
  start_sample: number;
  end_sample_exclusive: number;
  source_range: Interval;
  mapped_range: Interval;
  clipped_scope_range: Interval | null;
}
const rounding = 'sample_starts_in_half_open_window_ceil_epsilon_snap' as const;
const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
function interval(range: TimeRange): Interval {
  validateRange(range);
  check(range.kind === 'interval', 'MEDIA_PCM_INTERVAL_REQUIRED');
  return range as Interval;
}
function support(sourceRange: TimeRange, mappedRange: TimeRange, windowRange: TimeRange,
  sampleRate: number, sourceSamples: number) {
  const source = interval(sourceRange), mapped = interval(mappedRange), window = interval(windowRange);
  check(Number.isSafeInteger(sampleRate) && sampleRate > 0 && Number.isSafeInteger(sourceSamples) &&
    sourceSamples > 0 && Math.abs(source.end_ms - source.start_ms - sourceSamples * 1000 / sampleRate) < 0.001,
    'MEDIA_PCM_FORMAT_TIME_MISMATCH');
  check(mapped.timebase_id === window.timebase_id &&
    (mapped.stream_epoch === undefined || window.stream_epoch === mapped.stream_epoch), 'MEDIA_PCM_CLOCK_SCOPE_MISMATCH');
  const samplePeriod = 1000 / sampleRate;
  const scale = (mapped.end_ms - mapped.start_ms) / (source.end_ms - source.start_ms);
  check(Number.isFinite(scale) && scale > 0, 'MEDIA_PCM_CLOCK_SCOPE_MISMATCH');
  const mappedPeriod = samplePeriod * scale;
  const overlapStart = Math.max(window.start_ms, mapped.start_ms);
  const overlapEnd = Math.min(window.end_ms, mapped.end_ms);
  check(overlapEnd > overlapStart, 'MEDIA_PCM_WINDOW_OUTSIDE_VIEW');
  const boundary = (time: number): number => {
    const position = (time - mapped.start_ms) / mappedPeriod;
    const nearest = Math.round(position);
    const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(position));
    return Math.min(sourceSamples, Math.max(0,
      Math.ceil(Math.abs(position - nearest) <= tolerance ? nearest : position)));
  };
  const first = boundary(overlapStart), end = boundary(overlapEnd);
  check(end > first, 'MEDIA_PCM_WINDOW_NO_SAMPLES');
  return {first, end, source, mapped, samplePeriod, mappedPeriod,
    selectedSource: {...source, start_ms: source.start_ms + first * samplePeriod,
      end_ms: source.start_ms + end * samplePeriod},
    selectedMapped: {...mapped, start_ms: mapped.start_ms + first * mappedPeriod,
      end_ms: mapped.start_ms + end * mappedPeriod}};
}

// The source owner selects sample starts in C; binary support remains explicit even
// when its last sample boundary extends beyond C. Consumers never recrop bytes.
export function selectPcmView(view: MediaView, bytes: Uint8Array, window: TimeRange,
  sealedViewRef: string): SelectedView {
  const format = /^pcm_s16le:(\d+):1$/u.exec(view.chunk.format);
  check(view.chunk.modality === 'audio' && format && bytes.length % 2 === 0,
    'MEDIA_PCM_FORMAT_TIME_MISMATCH');
  check(bytes.length === view.chunk.bytes && sha256(bytes) === view.chunk.object_hash,
    'MEDIA_OBJECT_INTEGRITY', 500);
  check(/^l5-view:[a-f0-9]{64}$/u.test(sealedViewRef) && view.chunk.source_range.stream_epoch === view.chunk.stream_epoch,
    'MEDIA_PCM_CLOCK_SCOPE_MISMATCH');
  const sampleRate = Number(format![1]), sourceSamples = bytes.length / 2;
  const selected = support(view.chunk.source_range, view.mapped_range, window, sampleRate, sourceSamples);
  const selectedBytes = bytes.slice(selected.first * 2, selected.end * 2);
  return {modality: 'audio', format: view.chunk.format, ref: view.ref,
    time_range: selected.selectedMapped, bytes: selectedBytes,
    pcm_selection: {view_ref: sealedViewRef, track_id: view.chunk.track_id, stream_epoch: view.chunk.stream_epoch,
      seq: view.chunk.seq, source_range: {...selected.source}, mapped_range: {...selected.mapped},
      selected_source_range: selected.selectedSource, sample_rate: sampleRate,
      first_sample: selected.first, end_sample_exclusive: selected.end, source_samples: sourceSamples,
      selected_sha256: sha256(selectedBytes), rounding}};
}
function validateSelected(view: SelectedView, request: WorkerRequest): PcmSelection {
  const selection = view.pcm_selection;
  check(request.input_contract === 'paios.media.selected-pcm.v1' && selection &&
    view.format === `pcm_s16le:${selection.sample_rate}:1` && view.bytes.length % 2 === 0 &&
    sha256(view.bytes) === selection.selected_sha256, 'REPLAY_AUDIO_SELECTION_REQUIRED');
  check(/^l5-view:[a-f0-9]{64}$/u.test(selection!.view_ref) && selection!.track_id.length > 0 &&
    selection!.stream_epoch.length > 0 && Number.isSafeInteger(selection!.seq) && selection!.seq >= 0 &&
    selection!.source_range.stream_epoch === selection!.stream_epoch && selection!.rounding === rounding,
    'MEDIA_PCM_SELECTION_PROVENANCE_INVALID');
  const selected = support(selection!.source_range, selection!.mapped_range, request.time_range,
    selection!.sample_rate, selection!.source_samples);
  check(selection!.first_sample === selected.first && selection!.end_sample_exclusive === selected.end &&
    view.bytes.length / 2 === selected.end - selected.first &&
    canonical(selection!.selected_source_range) === canonical(selected.selectedSource) &&
    canonical(view.time_range) === canonical(selected.selectedMapped), 'MEDIA_PCM_SELECTION_SUPPORT_MISMATCH');
  return selection!;
}
function contiguous(a: SelectedView, b: SelectedView): boolean {
  const x = a.pcm_selection!, y = b.pcm_selection!;
  const xs = interval(x.selected_source_range), ys = interval(y.selected_source_range);
  const xm = interval(a.time_range), ym = interval(b.time_range);
  return x.track_id === y.track_id && x.stream_epoch === y.stream_epoch && x.sample_rate === y.sample_rate &&
    xs.timebase_id === ys.timebase_id && xm.timebase_id === ym.timebase_id && xm.stream_epoch === ym.stream_epoch &&
    close(xs.end_ms, ys.start_ms) && close(xm.end_ms, ym.start_ms);
}
// This validates the prepared selection contract. Authenticating the original sealed
// L5 view and full object remains MediaProcessor.prepareRequest's storage boundary.
export function selectedAudioTimeline(request: WorkerRequest): SelectedAudioGroup[] {
  validateRange(request.time_range);
  const audio = request.views.map((view, view_index) => ({view, view_index})).filter(p => p.view.modality === 'audio');
  if (!audio.length) return [];
  interval(request.time_range);
  for (const {view} of audio) validateSelected(view, request);
  const scope = digest([request.event_id, request.segment_id, request.archive_revision, request.time_range,
    request.input_contract, request.coverage, audio.map(({view, view_index}) => ({view_index, ...view, bytes: sha256(view.bytes)}))]);
  const groups: SelectedAudioGroup[] = [];
  for (const {view, view_index} of audio) {
    let group = groups.at(-1);
    if (!group || !contiguous(group.views.at(-1)!, view)) {
      group = {id: '', scope_sha256: scope, sample_rate: view.pcm_selection!.sample_rate,
        total_samples: 0, views: [], pieces: []};
      groups.push(group);
    }
    const count = view.bytes.length / 2;
    group.views.push(view);
    group.pieces.push({view_index, view, start_sample: group.total_samples,
      end_sample_exclusive: group.total_samples + count});
    group.total_samples += count;
    check(Number.isSafeInteger(group.total_samples), 'MEDIA_PCM_SAMPLE_BUDGET_INVALID');
  }
  for (const group of groups) group.id = `media-audio-group:${digest([scope, group.pieces.map(p => p.view_index)])}`;
  return groups;
}
export interface SampleProjectionBatch {
  group: SelectedAudioGroup;
  intervals: readonly {start_sample: number; end_sample_exclusive: number}[];
}
// Every call verifies fresh request provenance. No verified state escapes this call.
export function projectSampleIntervals(batches: readonly SampleProjectionBatch[],
  request: WorkerRequest): SampleProjection[] {
  const groups = selectedAudioTimeline(request), result: SampleProjection[] = [];
  const identity = (candidate: SelectedAudioGroup): string => canonical({...candidate,
    views: candidate.views.map(view => ({...view, bytes: sha256(view.bytes)})),
    pieces: candidate.pieces.map(piece => ({...piece, view: {...piece.view, bytes: sha256(piece.view.bytes)}}))});
  for (const {group, intervals} of batches) {
    const authoritative = groups.find(candidate => candidate.id === group.id);
    check(authoritative && identity(authoritative) === identity(group), 'MEDIA_PCM_GROUP_PROVENANCE_MISMATCH');
    for (const bounds of intervals) result.push(...projectVerifiedInterval(authoritative!,
      bounds.start_sample, bounds.end_sample_exclusive, interval(request.time_range)));
  }
  return result;
}
export function projectSampleInterval(group: SelectedAudioGroup, startSample: number, endSample: number,
  request: WorkerRequest): SampleProjection[] {
  return projectSampleIntervals([{group, intervals: [{start_sample: startSample,
    end_sample_exclusive: endSample}]}], request);
}
function projectVerifiedInterval(authoritative: SelectedAudioGroup, startSample: number,
  endSample: number, scope: Interval): SampleProjection[] {
  check(Number.isFinite(startSample) && Number.isFinite(endSample) && startSample >= 0 &&
    endSample > startSample && endSample <= authoritative.total_samples, 'MEDIA_PCM_PROJECTION_BOUNDS_INVALID');
  const result: SampleProjection[] = [];
  let covered = 0;
  for (const piece of authoritative.pieces) {
    const start = Math.max(startSample, piece.start_sample), end = Math.min(endSample, piece.end_sample_exclusive);
    if (end <= start) continue;
    const selection = piece.view.pcm_selection!;
    const source = interval(selection.source_range), mapped = interval(selection.mapped_range);
    const first = selection.first_sample + start - piece.start_sample;
    const last = selection.first_sample + end - piece.start_sample;
    const samplePeriod = 1000 / selection.sample_rate;
    const mappedPeriod = samplePeriod * (mapped.end_ms - mapped.start_ms) / (source.end_ms - source.start_ms);
    const sourceRange = {...source, start_ms: source.start_ms + first * samplePeriod, end_ms: source.start_ms + last * samplePeriod};
    const mappedRange = {...mapped, start_ms: mapped.start_ms + first * mappedPeriod, end_ms: mapped.start_ms + last * mappedPeriod};
    const clippedStart = Math.max(scope.start_ms, mappedRange.start_ms), clippedEnd = Math.min(scope.end_ms, mappedRange.end_ms);
    result.push({view_ref: piece.view.ref, track_id: selection.track_id, stream_epoch: selection.stream_epoch,
      seq: selection.seq, start_sample: first, end_sample_exclusive: last, source_range: sourceRange,
      mapped_range: mappedRange, clipped_scope_range: clippedEnd > clippedStart ?
        {...scope, start_ms: clippedStart, end_ms: clippedEnd} : null});
    covered += end - start;
  }
  check(close(covered, endSample - startSample), 'MEDIA_PCM_PROJECTION_COVERAGE_INVALID');
  return result;
}
