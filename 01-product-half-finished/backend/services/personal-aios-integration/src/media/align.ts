import {publishRawRecord,streamManifestRevision} from '../stream-archive.ts';
import {canonical, check, digest, validateRange} from '../contracts.ts';
import type {ArchivedEvent, MediaSegment, TimeRange} from '../contracts.ts';
import type {StoredChunk, StreamManifest} from '../stream-archive.ts';
import type {DerivedManifest} from '../derived-archive.ts';
import type {DerivedTrack} from './tracks.ts';
import type {StoragePort} from '../storage.ts';

export interface ClockMap {
  modality: 'audio' | 'visual';
  track_id: string; stream_epoch: string; source_timebase_id: string; target_timebase_id: string;
  offset_ms: number; drift_ppm: number; uncertainty_ms: number; basis_ref: string;
}
export interface AlignConfig {max_chunks: number; max_visual_refs: number; max_frame_gap_ms: number; max_uncertainty_ms: number}
export interface MediaView {chunk: StoredChunk|DerivedTrack; mapped_range: TimeRange; ref: string}
export function mappedRange(range: TimeRange, map: ClockMap): TimeRange {
  validateRange(range);
  check(range.timebase_id === map.source_timebase_id && range.stream_epoch === map.stream_epoch &&
    [map.offset_ms,map.drift_ppm,map.uncertainty_ms].every(Number.isFinite) && map.uncertainty_ms >= 0 &&
    1+map.drift_ppm/1e6 > 0 && map.basis_ref.length>0, 'CLOCK_MAP_INVALID');
  const value=(n:number)=>n*(1+map.drift_ppm/1e6)+map.offset_ms;
  return range.kind === 'instant' ? {kind:'instant',timebase_id:map.target_timebase_id,at_ms:value(range.at_ms)} :
    {kind:'interval',timebase_id:map.target_timebase_id,start_ms:value(range.start_ms),end_ms:value(range.end_ms)};
}
const overlaps=(a:TimeRange,b:TimeRange):boolean => b.kind === 'instant' ?
  a.kind === 'instant' ? a.at_ms===b.at_ms : b.at_ms>=a.start_ms&&b.at_ms<a.end_ms :
  a.kind === 'instant' ? a.at_ms>=b.start_ms&&a.at_ms<b.end_ms : b.start_ms<a.end_ms&&b.end_ms>a.start_ms;
function missingAudio(window: TimeRange, views: MediaView[]): TimeRange[] {
  if (window.kind === 'instant') return views.length ? [] : [window];
  const ranges=views.map(v=>v.mapped_range).filter(r=>r.kind==='interval').sort((a,b)=>a.start_ms-b.start_ms);
  const gaps: TimeRange[]=[]; let cursor=window.start_ms;
  for (const r of ranges) {if(r.start_ms>cursor)gaps.push({...window,start_ms:cursor,end_ms:Math.min(r.start_ms,window.end_ms)}); cursor=Math.max(cursor,r.end_ms);}
  if(cursor<window.end_ms)gaps.push({...window,start_ms:cursor}); return gaps;
}
function missingVisual(window: TimeRange, views: MediaView[], cadence: number): TimeRange[] {
  if(window.kind==='instant') return views.length ? [] : [window];
  if(!views.length) return [window];
  const intervals=views.filter(v=>v.mapped_range.kind==='interval');
  if(intervals.length===views.length) return missingAudio(window,views);
  const points=views.map(v=>v.mapped_range).filter(r=>r.kind==='instant').map(r=>r.at_ms).sort((a,b)=>a-b);
  const gaps: TimeRange[]=[]; let cursor=window.start_ms;
  for(const point of points) {if(point-cursor>cadence)gaps.push({...window,start_ms:cursor,end_ms:point});cursor=point;}
  if(window.end_ms-cursor>cadence)gaps.push({...window,start_ms:cursor}); return gaps;
}
export async function alignSegment(archive: ArchivedEvent, manifest: StreamManifest|DerivedManifest, window: TimeRange,
  basis: MediaSegment['segment_basis'] | 'source_window', maps: ClockMap[], storage: StoragePort, config: AlignConfig,
  previousProcessedIds: string[] = [], derivationRef?:string): Promise<{segment: MediaSegment; views: MediaView[]}> {
  validateRange(window);
  check(Object.values(config).every(n=>Number.isFinite(n)&&n>0), 'INVALID_ALIGN_CONFIG');
  check(manifest.raw_ref===archive.raw_ref&&(manifest.schema!=='paios.derived.v1'?
    streamManifestRevision(manifest)===archive.archive_revision&&!derivationRef:manifest.archive_revision===archive.archive_revision&&
    manifest.payload_sha256===archive.payload_sha256&&derivationRef?.endsWith(`:${digest(manifest)}`)), 'ALIGN_REVISION_MISMATCH');
  check(manifest.chunks.length<=config.max_chunks, 'ALIGN_CHUNK_BUDGET_EXCEEDED',413);
  const relevantMaps=maps.filter(m=>m.target_timebase_id===window.timebase_id);
  check(new Set(relevantMaps.map(m=>digest([m.track_id,m.stream_epoch]))).size===relevantMaps.length, 'DUPLICATE_CLOCK_MAP');
  const views: MediaView[]=[];
  const missingByTrack: {track_id:string;stream_epoch:string;ranges:TimeRange[]}[]=[];
  let uncertainty=0;
  check(relevantMaps.length>0, 'CLOCK_MAP_REQUIRED');
  for (const map of relevantMaps) {
    uncertainty=Math.max(uncertainty,map.uncertainty_ms);
    const trackViews=manifest.chunks.filter(c=>c.track_id===map.track_id&&c.stream_epoch===map.stream_epoch)
      .map(chunk=>({chunk,mapped_range:mappedRange(chunk.source_range,map),ref:`l5-object:${chunk.object_hash}`}))
      .filter(v=>overlaps(window,v.mapped_range));
    views.push(...trackViews);
    check(trackViews.every(v=>v.chunk.modality===map.modality),'CLOCK_TRACK_MODALITY_MISMATCH');
    const missing=map.modality==='audio'?missingAudio(window,trackViews):missingVisual(window,trackViews,config.max_frame_gap_ms);
    if(missing.length)missingByTrack.push({track_id:map.track_id,stream_epoch:map.stream_epoch,ranges:missing});
  }
  const audio=views.filter(v=>v.chunk.modality==='audio'), visual=views.filter(v=>v.chunk.modality==='visual');
  if(basis==='source_window')basis=audio.length?'speech_candidate':window.kind==='instant'?'still_image':'visual_window';
  check(visual.length<=config.max_visual_refs, 'ALIGN_FRAME_BUDGET_EXCEEDED',413);
  check(basis==='speech_candidate'||basis==='wake_turn'?audio.length>0:audio.length===0&&visual.length>0,'SEGMENT_BASIS_MODALITY_MISMATCH');
  const viewData={raw_ref:manifest.raw_ref,archive_revision:archive.archive_revision,window,views,...(derivationRef?{derivation_ref:derivationRef}:{})};
  const hash=digest(viewData), viewBytes=new TextEncoder().encode(canonical(viewData));
  const published=await publishRawRecord(storage,manifest.raw_ref,'media-views',hash,viewBytes);
  check(new TextDecoder().decode(published)===canonical(viewData),'MEDIA_VIEW_CONFLICT',409);
  const missing=missingByTrack.flatMap(t=>t.ranges);
  const segment: MediaSegment={...archive,time_range:window,segment_id:`segment:${digest([archive.event_id,window,basis])}`,
    segment_basis:basis,audio_ref:audio.length?`l5-view:${hash}`:null,visual_refs:visual.map(v=>v.ref),
    continuation_hint:'open',continuation:{continuity_ref:archive.raw_ref,previous_processed_event_ids:previousProcessedIds,
      relation:previousProcessedIds.length?'continues':'new',semantic_status:'open',basis_refs:[`l5-view:${hash}`,...(derivationRef?[derivationRef]:[])],policy_version:'media.candidate.v1'},
    coverage:{status:missing.length||uncertainty>config.max_uncertainty_ms?'partial':'complete',missing_ranges:missing,
      alignment_uncertainty_ms:uncertainty,missing_by_track:missingByTrack}};
  return {segment,views};
}
