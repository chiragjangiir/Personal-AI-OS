import {streamManifestRevision} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import { canonical, check, digest, validateRange, type ArchivedEvent, type CaptureTiming, type RawEvent, type TimeRange } from '../../../services/personal-aios-integration/src/contracts.ts';
import { mappedRange, type ClockMap } from '../../../services/personal-aios-integration/src/media/align.ts';
import type { StoragePort } from '../../../services/personal-aios-integration/src/storage.ts';
import type { TrackChunk, StreamManifest } from '../../../services/personal-aios-integration/src/stream-archive.ts';
import type { SourceMediaClockAuthority } from './source-media-admission.ts';
import type { SourceMediaCaptureBinding } from './source-media-permission.ts';
import { pcmEventId } from './personal-aios-formal-pcm.ts';

export class SourceClockUnavailableError extends Error {
  readonly code:string;
  constructor(code:string,cause?:unknown){super(code,cause===undefined?undefined:{cause});this.code=code;this.name='SourceClockUnavailableError';}
}
/** Filesystem failures at capture metadata boundaries; authorization errors are never classified here. */
export const sourceStorageUnavailable=(error:unknown)=>['ENOSPC','EDQUOT','EIO','EROFS','EACCES','EMFILE','ENFILE','EBUSY','ETIMEDOUT']
  .includes((error as NodeJS.ErrnoException)?.code??'');
export interface SourceSpanDeclaration {
  span_id: string; modalities: ('audio'|'visual')[]; anchor_range: TimeRange;
}
export interface SealedSourceSpan {
  event_id: string; media_type: 'livekit_tracks';
  metadata: Pick<RawEvent,'captured_at'|'time_range'>; capture_timing: CaptureTiming;
}
export interface SourceClockProvider {
  /** calibrated: host-owned calibration; receipt_estimated: server receipt anchor with explicit uncertainty; synthetic: fixtures only. */
  evidence: 'calibrated' | 'receipt_estimated' | 'synthetic';
  /** Host-owned source. Receipt time / client claims cannot calibrate received-sample ordinals. */
  resolveSpan?(binding: SourceMediaCaptureBinding, span: SourceSpanDeclaration): Promise<ClockMap | undefined>;
  resolve(binding: SourceMediaCaptureBinding, chunk: TrackChunk): Promise<ClockMap | undefined>;
}
export interface ArchivedSourceClock extends SourceMediaClockAuthority {
  evidence: SourceClockProvider['evidence'];
  capture(binding:SourceMediaCaptureBinding,chunk:TrackChunk,reported?:{captured_at_ms:number;received_at_ms:number}):Promise<{
    metadata:Pick<RawEvent,'captured_at'|'time_range'>;capture_timing:CaptureTiming}>;
  sealSpan(binding: SourceMediaCaptureBinding, declaration: SourceSpanDeclaration): Promise<SealedSourceSpan>;
  captureTrack(binding: SourceMediaCaptureBinding, chunk: TrackChunk, span: SealedSourceSpan): Promise<TrackChunk>;
  archivedReceiptClockMaps(principal:string,event:ArchivedEvent,binding:SourceMediaCaptureBinding):Promise<ClockMap[]>;
  archivedClockMaps(event: ArchivedEvent, manifest: StreamManifest): Promise<ClockMap[]>;
  authorizeClockMaps(principal: string, maps: ClockMap[], event: ArchivedEvent, manifest?: StreamManifest): Promise<void>;
}
interface Basis {
  schema: 'paios.source-clock.v1'; binding: SourceMediaCaptureBinding;
  event_id: string; map: ClockMap; evidence: SourceClockProvider['evidence'];
  reported_capture?:{captured_at_ms:number;received_at_ms:number};
}
interface SpanBasis {
  schema: 'paios.source-span.v2'; binding: SourceMediaCaptureBinding; declaration: SourceSpanDeclaration;
  event_id: string; map: ClockMap; evidence: SourceClockProvider['evidence'];
}
interface TrackBasis {
  schema: 'paios.source-clock.v2'; binding: SourceMediaCaptureBinding;
  event_id: string; anchor_ref: string; map: ClockMap; evidence: SourceClockProvider['evidence'];
}
// Source evidence owner; no calibration algorithm, permission cache, or probe-log parser.
export function createSourceMediaClock(storage: StoragePort, provider: SourceClockProvider, readHeader?: (event:ArchivedEvent)=>Promise<{event:ArchivedEvent;tracks:TrackChunk[]}>): ArchivedSourceClock {
  check(provider && ['calibrated','receipt_estimated','synthetic'].includes(provider.evidence) && typeof provider.resolve === 'function',
    'MEDIA_SOURCE_CLOCK_AUTHORITY_NOT_CONFIGURED', 503);
  const evidence = provider.evidence;
  const capturedAt = (map:ClockMap) => new Date(map.offset_ms).toISOString();
  const timing = (map:ClockMap,basisEvidence=evidence):CaptureTiming => ({basis_ref:map.basis_ref,
    quality:basisEvidence==='synthetic'?'synthetic':'estimated',uncertainty_ms:map.uncertainty_ms+Math.abs(map.offset_ms-Date.parse(capturedAt(map)))});
  const load = async (ref:string) => {
    const key = /^source-clock:([a-f0-9]{64})$/u.exec(ref)?.[1];
    check(key, 'MEDIA_CLOCK_BASIS_REQUIRED', 403);
    const basis = JSON.parse(Buffer.from(await storage.read('source-clock-bases',key)).toString()) as Basis | SpanBasis | TrackBasis;
    check(digest(basis)===key && ['paios.source-clock.v1','paios.source-span.v2','paios.source-clock.v2'].includes(basis.schema) && (basis.evidence===evidence||basis.schema==='paios.source-clock.v1'&&basis.evidence==='receipt_estimated'&&!!basis.reported_capture),
      'MEDIA_CLOCK_BASIS_DENIED',403);
    return {basis,map:{...basis.map,basis_ref:ref}};
  };
  const persist = async (key:string,bytes:Buffer) => {
    try{return await (storage.publishIngressMeta
      ?storage.publishIngressMeta('source-clock-bases',key,bytes):storage.publish('source-clock-bases',key,bytes));}
    catch(error){if(!sourceStorageUnavailable(error))throw error;
      throw new SourceClockUnavailableError('MEDIA_CLOCK_BASIS_STORAGE_UNAVAILABLE',error);}
  };
  const publish = async (basis: SpanBasis | TrackBasis) => {
    const key=digest(basis), bytes=Buffer.from(canonical(basis));
    check(bytes.length<=16384,'MEDIA_CLOCK_BASIS_BUDGET',413);
    const saved=await persist(key,bytes);
    check(canonical(JSON.parse(Buffer.from(saved).toString()))===canonical(basis),'MEDIA_CLOCK_BASIS_CONFLICT',409);
    return `source-clock:${key}`;
  };
  const anchor = async (event: Pick<RawEvent,'event_id'|'captured_at'|'source'|'time_range'|'media_type'>) => {
    check(event.source.capture_timing,'MEDIA_CAPTURE_TIMING_REQUIRED',403);
    const sealed=await load(event.source.capture_timing.basis_ref), basis=sealed.basis;
    check(basis.schema==='paios.source-span.v2' && event.media_type==='livekit_tracks' &&
      event.event_id===basis.event_id,'MEDIA_SPAN_ANCHOR_DENIED',403);
    const range=mappedRange(basis.declaration.anchor_range,basis.map);
    const at=range.kind==='instant'?range.at_ms:range.start_ms;
    const capture={basis_ref:event.source.capture_timing.basis_ref,quality:timing(basis.map).quality,
      uncertainty_ms:basis.map.uncertainty_ms+Math.abs(at-Date.parse(new Date(at).toISOString()))};
    check(event.captured_at===new Date(at).toISOString() && canonical(event.time_range)===canonical(range) &&
      canonical(event.source.capture_timing)===canonical(capture),'MEDIA_CAPTURE_TIMING_MISMATCH',403);
    return basis;
  };
  const read = async (binding:SourceMediaCaptureBinding,chunk:TrackChunk,event?:Pick<RawEvent,'event_id'|'captured_at'|'source'|'time_range'|'media_type'>,reported?:{captured_at_ms:number;received_at_ms:number}):Promise<ClockMap> => {
    let map:ClockMap;
    if (event?.media_type==='livekit_tracks') {
      const span=await anchor(event);
      check(chunk.clock_basis_ref,'MEDIA_TRACK_CLOCK_PROOF_REQUIRED',403);
      const sealed=await load(chunk.clock_basis_ref),basis=sealed.basis;
      check(basis.schema==='paios.source-clock.v2' && basis.anchor_ref===event.source.capture_timing!.basis_ref &&
        basis.event_id===span.event_id && canonical(basis.binding)===canonical(binding) &&
        canonical(span.binding)===canonical(binding) && span.declaration.modalities.includes(chunk.modality),
        'MEDIA_CLOCK_BASIS_DENIED',403);
      map=sealed.map;
    } else if (event) {
      check(event.source.capture_timing, 'MEDIA_CAPTURE_TIMING_REQUIRED',403);
      const sealed = await load(event.source.capture_timing.basis_ref);
      check((chunk.clock_basis_ref===undefined||chunk.clock_basis_ref===event.source.capture_timing.basis_ref) && sealed.basis.schema==='paios.source-clock.v1' && canonical(sealed.basis.binding)===canonical(binding) &&
        sealed.basis.event_id===pcmEventId(binding.continuityId,chunk.stream_epoch),'MEDIA_CLOCK_BASIS_DENIED',403);
      map=sealed.map;
      check(event.captured_at===capturedAt(map) &&
        canonical(event.source.capture_timing)===canonical(timing(map,sealed.basis.evidence)) &&
        canonical(event.time_range)===canonical(mappedRange(chunk.source_range,map)),'MEDIA_CAPTURE_TIMING_MISMATCH',403);
    } else {
      // Device wall time is a reported anchor, never hardware calibration. Seal both claims in the existing proof.
      if(reported)check(Number.isFinite(reported.captured_at_ms)&&Number.isFinite(reported.received_at_ms)&&
        Number.isFinite(new Date(reported.captured_at_ms).getTime()),'MEDIA_REPORTED_CAPTURE_TIME_INVALID');
      const resolved = reported?{modality:chunk.modality,track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,
        source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:reported.captured_at_ms,
        drift_ppm:0,uncertainty_ms:Math.max(1,Math.abs(reported.received_at_ms-reported.captured_at_ms)),basis_ref:'clock:device-reported-pcm-v1'}:
        await provider.resolve(structuredClone(binding),structuredClone(chunk));
      if(resolved===undefined)throw new SourceClockUnavailableError('MEDIA_SOURCE_CLOCK_AUTHORITY_NOT_CONFIGURED');
      map=structuredClone(resolved);
      const basis:Basis={schema:'paios.source-clock.v1',binding:structuredClone(binding),
        event_id:pcmEventId(binding.continuityId,chunk.stream_epoch),map,evidence:reported?'receipt_estimated':evidence,
        ...(reported?{reported_capture:structuredClone(reported)}:{})};
      const key=digest(basis),bytes=Buffer.from(canonical(basis));
      check(bytes.length<=16384,'MEDIA_CLOCK_BASIS_BUDGET',413);
      const saved=await persist(key,bytes);
      check(canonical(JSON.parse(Buffer.from(saved).toString()))===canonical(basis),'MEDIA_CLOCK_BASIS_CONFLICT',409);
      map={...map,basis_ref:`source-clock:${key}`};
    }
    check(map.target_timebase_id==='utc_epoch_ms' && map.track_id===chunk.track_id &&
      map.stream_epoch===chunk.stream_epoch && map.modality===chunk.modality,'MEDIA_SOURCE_CLOCK_SCOPE_MISMATCH',403);
    mappedRange(chunk.source_range,map);
    return map;
  };
  const archivedMaps:ArchivedSourceClock['archivedClockMaps']=async(event,manifest)=>{
      check(manifest.raw_ref===event.raw_ref&&streamManifestRevision(manifest)===event.archive_revision,'MEDIA_PINNED_TRACK_PROOFS_REQUIRED',403);
      const span=await anchor(event),maps=new Map<string,ClockMap>();
      for(const chunk of manifest.chunks){
        const map=await read(span.binding,chunk,event),key=digest([chunk.track_id,chunk.stream_epoch]);
        check(!maps.has(key)||canonical(maps.get(key))===canonical(map),'MEDIA_TRACK_CLOCK_CHANGED_WITHOUT_EPOCH',403);
        check(map,'MEDIA_CLOCK_BASIS_DENIED',403);maps.set(key,map);
      }
      return [...maps.values()];
    };
  return {evidence,read,
    sealSpan:async(binding,declaration)=>{
      binding=structuredClone(binding);declaration=structuredClone(declaration);
      check(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(declaration.span_id) && declaration.modalities.length>0 &&
        new Set(declaration.modalities).size===declaration.modalities.length &&
        declaration.modalities.every(m=>m==='audio'||m==='visual'),'MEDIA_SPAN_DECLARATION_INVALID');
      validateRange(declaration.anchor_range);
      check(typeof provider.resolveSpan==='function','MEDIA_SPAN_CLOCK_PROVIDER_REQUIRED',503);
      const resolved=await provider.resolveSpan(structuredClone(binding),structuredClone(declaration));
      if(resolved===undefined)throw new SourceClockUnavailableError('MEDIA_SPAN_CLOCK_UNAVAILABLE');
      check(resolved.target_timebase_id==='utc_epoch_ms','MEDIA_SOURCE_CLOCK_SCOPE_MISMATCH',403);
      const range=mappedRange(declaration.anchor_range,resolved),at=range.kind==='instant'?range.at_ms:range.start_ms;
      const basis:SpanBasis={schema:'paios.source-span.v2',binding:structuredClone(binding),
        declaration:structuredClone(declaration),event_id:`span:${digest([binding,declaration.span_id])}`,
        map:structuredClone(resolved),evidence};
      const ref=await publish(basis);
      return {event_id:basis.event_id,media_type:'livekit_tracks',metadata:{captured_at:new Date(at).toISOString(),time_range:range},
        capture_timing:{basis_ref:ref,quality:timing(resolved).quality,uncertainty_ms:resolved.uncertainty_ms+Math.abs(at-Date.parse(new Date(at).toISOString()))}};
    },
    captureTrack:async(binding,chunk,span)=>{
      binding=structuredClone(binding);chunk=structuredClone(chunk);span=structuredClone(span);
      const event={...span.metadata,event_id:span.event_id,media_type:span.media_type,source:{channel:'clock',capture_timing:span.capture_timing}};
      const sealed=await anchor(event);
      check(canonical(sealed.binding)===canonical(binding)&&sealed.declaration.modalities.includes(chunk.modality),'MEDIA_SPAN_SCOPE_DENIED',403);
      const resolved=await provider.resolve(structuredClone(binding),structuredClone(chunk));
      if(resolved===undefined)throw new SourceClockUnavailableError('MEDIA_SOURCE_CLOCK_AUTHORITY_NOT_CONFIGURED');
      const ref=await publish({schema:'paios.source-clock.v2',binding:structuredClone(binding),event_id:span.event_id,
        anchor_ref:span.capture_timing.basis_ref,map:structuredClone(resolved),evidence});
      const result={...structuredClone(chunk),clock_basis_ref:ref};
      await read(binding,result,event);return result;
    },
    archivedReceiptClockMaps:async(principal,event,binding)=>{
      event=structuredClone(event);binding=structuredClone(binding);check(readHeader,'MEDIA_PINNED_TRACK_PROOFS_REQUIRED',403);
      const header=await readHeader(event);check(canonical(header.event)===canonical(event),'MEDIA_PINNED_TRACK_PROOFS_REQUIRED',403);
      check(['audio','livekit_tracks'].includes(event.media_type)&&principal===event.principal_id&&binding.userId===principal&&binding.deviceId===event.device_id,'MEDIA_CLOCK_BASIS_DENIED',403);
      const maps=new Map<string,ClockMap>();
      // A stream B retains the first anchor. Verify its first track descriptor, then map later chunks separately.
      for(const first of header.tracks){const map=await read(binding,first,event),key=digest([first.track_id,first.stream_epoch]);
        check(map&&(!maps.has(key)||canonical(maps.get(key))===canonical(map)),'MEDIA_CLOCK_BASIS_DENIED',403);maps.set(key,map);}
      return [...maps.values()];
    },
    archivedClockMaps:archivedMaps,
    capture:async(binding,chunk,reported)=>{
      const map=await read(binding,chunk,undefined,reported);
      return {metadata:{captured_at:capturedAt(map),time_range:mappedRange(chunk.source_range,map)},
        capture_timing:timing(map,reported?'receipt_estimated':evidence)};
    },
    authorizeClockMaps:async(principal,maps,event,manifest)=>{
      if(event.media_type==='livekit_tracks'){
        check(manifest&&manifest.raw_ref===event.raw_ref&&streamManifestRevision(manifest)===event.archive_revision,'MEDIA_PINNED_TRACK_PROOFS_REQUIRED',403);
        const span=await anchor(event),sealedMaps=await archivedMaps(event,manifest);
        check(principal===event.principal_id&&span.binding.userId===principal&&span.binding.deviceId===event.device_id&&
          maps.every(map=>sealedMaps.some(sealed=>canonical(sealed)===canonical(map))),'MEDIA_CLOCK_BASIS_DENIED',403);
        return;
      }
      for(const map of maps){
        const sealed=await load(map.basis_ref),basis=sealed.basis;
        check(basis.schema==='paios.source-clock.v1' && principal===event.principal_id && basis.binding.userId===principal && basis.binding.deviceId===event.device_id &&
          basis.event_id===event.event_id && canonical(sealed.map)===canonical(map) &&
          event.captured_at===capturedAt(map) &&
          canonical(event.source.capture_timing)===canonical(timing(map,sealed.basis.evidence)),'MEDIA_CLOCK_BASIS_DENIED',403);
      }
    },
  };
}
