import type {UnknownClockRaw,QuarantineAdmission} from '../../../services/personal-aios-integration/src/unknown-clock.ts';
import { canonical, check, type RawEvent, type TrustedContext } from '../../../services/personal-aios-integration/src/contracts.ts';
import { mappedRange, type ClockMap } from '../../../services/personal-aios-integration/src/media/align.ts';
import type { MediaServiceConfig } from '../../../services/personal-aios-integration/src/media/service.ts';
import type { TrackChunk } from '../../../services/personal-aios-integration/src/stream-archive.ts';
import type { SourceMediaCaptureBinding, SourceMediaPermissionPort } from './source-media-permission.ts';

/** Borrowed transport-authenticated source owner; no RawEvent identity is an authority input. */
export interface AuthenticatedMediaSource {
  capture(): Promise<{ binding: SourceMediaCaptureBinding; trusted: TrustedContext }>;
}
export interface SourceMediaClockAuthority {
  /** Independent trusted source mapping to UTC epoch milliseconds, scoped to this capture and track.
   * Acquisition/IO happens before the fence; this port must not derive calibration from A claims.
   */
  read(binding: SourceMediaCaptureBinding, chunk: TrackChunk,
    event?: Pick<RawEvent,'event_id'|'captured_at'|'source'|'time_range'|'media_type'>): Promise<ClockMap | undefined>;
}
export class SourceMediaAdmissionError extends Error {
  readonly code: string;
  readonly teardown: 'requested' | 'failed';
  constructor(code: string, teardown: 'requested' | 'failed', cause: unknown) {
    super(code, { cause }); this.name = 'SourceMediaAdmissionError'; this.code = code; this.teardown = teardown;
  }
}

/** Thin source candidate seam. Assembly supplies real T02/RTC/clock owners; no deployment cutover. */
export function createSourceMediaAdmission(options: {
  permission: SourceMediaPermissionPort;
  source: AuthenticatedMediaSource;
  clock: SourceMediaClockAuthority;
  /** Existing caller-owned canonical collector teardown; completion is not a physical-device ACK. */
  requestTeardown(binding: SourceMediaCaptureBinding, reason: string): Promise<void>;
}): Pick<MediaServiceConfig, 'withAppendAdmission'|'withAppendBatchAdmission'> & {withQuarantineAdmission:QuarantineAdmission} {
  check(typeof options.permission?.withPermission === 'function' && typeof options.source?.capture === 'function' &&
    typeof options.clock?.read === 'function' && typeof options.requestTeardown === 'function',
    'MEDIA_SOURCE_AUTHORITY_NOT_CONFIGURED', 503);
  const captureMatchingSource = async(raw:RawEvent|UnknownClockRaw,trusted:TrustedContext) => {
    const source=structuredClone(await options.source.capture());
    check(canonical(trusted)===canonical(source.trusted)&&trusted.submission==='observation'&&
      trusted.principal_id===source.binding.userId&&trusted.device_id===source.binding.deviceId&&
      raw.device_id===source.binding.deviceId,'MEDIA_CAPTURE_CONTEXT_MISMATCH',403);
    return source;
  };
  const withSourcePermission = async <T>(raw:RawEvent|UnknownClockRaw,trusted:TrustedContext,chunk:TrackChunk,
    consume:(binding:SourceMediaCaptureBinding,until:string)=>Promise<T>) => {
    const source=await captureMatchingSource(raw,trusted);
    let admitted=false;
    try {
      const fresh=await options.source.capture();
      check(canonical(fresh)===canonical(source),'MEDIA_CAPTURE_CONTEXT_MISMATCH',403);
      return await options.permission.withPermission(source.binding,chunk.modality==='visual'?'video':'audio',async permission=>{
        admitted=true;return consume(source.binding,permission.authorizedMediaUntil);
      });
    }catch(error){
      if(admitted)throw error;
      const code=error instanceof Error?error.message:'MEDIA_SOURCE_ADMISSION_DENIED';
      if(!['MEDIA_CURRENT_BINDING_MISSING','MEDIA_CURRENT_BINDING_MISMATCH','MEDIA_CAPTURE_NOT_CONNECTED',
        'MEDIA_CONTINUITY_EXPIRED','MEDIA_PERMISSION_CHANGED','MEDIA_MODALITY_NOT_AUTHORIZED',
        'LEASE_EXPIRED','LEASE_REVOKED','LEASE_RELEASED','LEASE_BINDING_INVALID','LEASE_VERSION_CONFLICT',
        'CREDENTIAL_FENCE_ACTIVE','REALTIME_AUTHORITY_CONFLICT','MEDIA_CAPTURE_CONTEXT_MISMATCH'].includes(code))throw error;
      let teardown:'requested'|'failed'='requested';
      try {await options.requestTeardown(source.binding,code);}catch{teardown='failed';}
      throw new SourceMediaAdmissionError(code,teardown,error);
    }
  };
  const clockEnd=async(binding:SourceMediaCaptureBinding,raw:RawEvent,chunk:TrackChunk)=>{
    const map=await options.clock.read(binding,structuredClone(chunk),raw);check(map,'MEDIA_SOURCE_CLOCK_AUTHORITY_NOT_CONFIGURED',503);
    const sealedMap=structuredClone(map);
    check(sealedMap.target_timebase_id==='utc_epoch_ms'&&sealedMap.track_id===chunk.track_id&&sealedMap.stream_epoch===chunk.stream_epoch&&sealedMap.modality===chunk.modality,'MEDIA_SOURCE_CLOCK_SCOPE_MISMATCH',403);
    const range=mappedRange(chunk.source_range,sealedMap),end=(range.kind==='instant'?range.at_ms:range.end_ms)+sealedMap.uncertainty_ms;
    check(Number.isFinite(end),'MEDIA_SOURCE_CLOCK_INVALID',403);return end;
  };
  return {
    withQuarantineAdmission:async(raw,trusted,chunk,append)=>withSourcePermission(raw,trusted,chunk,
      binding=>append(binding)),
    withAppendBatchAdmission:async(inputs,trusted,append)=>{
      inputs=structuredClone(inputs);trusted=structuredClone(trusted);
      check(inputs.length>0&&inputs.length<=64&&inputs.every(x=>x.chunk.modality==='audio'),'MEDIA_BATCH_SCOPE',403);
      const source=await captureMatchingSource(inputs[0]!.raw,trusted),ends:number[]=[];
      for(const {raw,chunk} of inputs){
        check(raw.device_id===source.binding.deviceId,'MEDIA_CAPTURE_CONTEXT_MISMATCH',403);
        ends.push(await clockEnd(source.binding,raw,chunk));
      }
      return withSourcePermission(inputs[0]!.raw,trusted,inputs[0]!.chunk,async(binding,until)=>{
        check(canonical(binding)===canonical(source.binding),'MEDIA_CAPTURE_CONTEXT_MISMATCH',403);
        check(ends.every(end=>end<=Date.parse(until)),'MEDIA_SOURCE_RANGE_NOT_AUTHORIZED',403);return append();
      });
    },
    withAppendAdmission:async(raw,trusted,chunk,append)=>{
      const source=await captureMatchingSource(raw,trusted);
      const end=await clockEnd(source.binding,raw,chunk);
      return withSourcePermission(raw,trusted,chunk,async(binding,until)=>{
        check(canonical(binding)===canonical(source.binding),'MEDIA_CAPTURE_CONTEXT_MISMATCH',403);
        check(end<=Date.parse(until),'MEDIA_SOURCE_RANGE_NOT_AUTHORIZED',403);return append();
      });
    },
  };
}
