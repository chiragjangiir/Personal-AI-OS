import {bindRawSource, canonical, check, digest, id, sha256, utc, validateRange, type RawEvent, type TrustedContext} from './contracts.ts';
import {requireRawAvailable,type TrackChunk} from './stream-archive.ts';
import type {StoragePort} from './storage.ts';

/** L5 isolation only: this type cannot satisfy RawEvent or ArchivedEvent. */
export interface UnknownClockRaw extends Omit<RawEvent,'captured_at'|'time_range'> {
  captured_at:null; capture_clock_status:'unknown';
}
export interface QuarantinedOriginal {
  schema:'paios.unknown-clock-original.v1'; quarantine_ref:string; archive_revision:string;
  archive_status:'quarantined'; reason:'capture_utc_unavailable';
  event:Omit<ReturnType<typeof bindRawSource>,'origin'|'user_identity'> & {
    captured_at:null; capture_clock_status:'unknown'; origin:'device_observation'; user_identity:'unknown'};
  chunk:TrackChunk; payload_sha256:string; bytes:number;
  authorization:{basis:'current_receive_permission'; historical_capture_range:'unverified'; binding:unknown};
}
export type QuarantineAdmission = <T>(raw:UnknownClockRaw,trusted:TrustedContext,chunk:TrackChunk,
  append:(binding:unknown)=>Promise<T>)=>Promise<T>;
export class QuarantineReceiptFailure extends Error {
  readonly code='QUARANTINE_RECEIPT_FAILED_AFTER_OBJECT_PUBLICATION';
  readonly object_published=true; readonly receipt_status='unknown';
  readonly payload_sha256:string;readonly quarantine_ref:string;
  constructor(payload_sha256:string,quarantine_ref:string,cause:unknown) {
    super('QUARANTINE_RECEIPT_FAILED_AFTER_OBJECT_PUBLICATION',{cause});
    this.payload_sha256=payload_sha256;this.quarantine_ref=quarantine_ref;
  }
}
const slot=(principal:string,event:string,c:TrackChunk)=>digest([principal,event,c.track_id,c.stream_epoch,c.seq]);
const fingerprint=(r:Omit<QuarantinedOriginal,'archive_revision'>)=>{
  const {received_at:_received,...event}=r.event;
  return digest({...r,event});
};
/** Pure source validation shared by durable admission and the eventual publisher. */
export function validateUnknownClock(maxBytes:number,raw:UnknownClockRaw,trusted:TrustedContext,
  chunk:TrackChunk,binding:unknown,receivedAt:string) {
  check(raw.captured_at===null&&raw.capture_clock_status==='unknown','QUARANTINE_REQUIRES_UNKNOWN_CLOCK');
  check(trusted.submission==='observation'&&['audio','visual','livekit_tracks'].includes(raw.media_type),
    'QUARANTINE_OBSERVATION_ONLY',403);
  check(raw.payload.byteLength<=maxBytes,'EVENT_TOO_LARGE',413);
  const {captured_at,capture_clock_status,...source}=raw;
  const bound=bindRawSource(source,trusted,receivedAt);
  check(source.source.capture_timing===undefined&&chunk.clock_basis_ref===undefined,'QUARANTINE_CLOCK_PROOF_CONFLICT');
  id(chunk.track_id);id(chunk.stream_epoch);validateRange(chunk.source_range);
  check(chunk.source_range.stream_epoch===chunk.stream_epoch&&
    !/^utc(?:[._:-]|$)/u.test(chunk.source_range.timebase_id),'QUARANTINE_REQUIRES_LOCAL_RANGE');
  check(Number.isSafeInteger(chunk.seq)&&chunk.seq>=0&&chunk.seq<=65536&&
    ['audio','visual'].includes(chunk.modality)&&typeof chunk.format==='string'&&chunk.format.length>0&&chunk.format.length<=200&&
    (raw.media_type==='livekit_tracks'||raw.media_type===chunk.modality),'QUARANTINE_CHUNK_INVALID');
  canonical(binding);
  return bound;
}
/** Used only by RawArchive: storage implementation and domain writer remain unchanged. */
export async function publishUnknownClock(storage:StoragePort,maxBytes:number,raw:UnknownClockRaw,
  trusted:TrustedContext,chunk:TrackChunk,binding:unknown,receivedAt:string):Promise<QuarantinedOriginal> {
  raw=structuredClone(raw);trusted=structuredClone(trusted);chunk=structuredClone(chunk);binding=structuredClone(binding);
  const bound=validateUnknownClock(maxBytes,raw,trusted,chunk,binding,receivedAt);
  const hash=sha256(raw.payload), ref=`l5-quarantine:${slot(trusted.principal_id,raw.event_id,chunk)}`;
  const record:Omit<QuarantinedOriginal,'archive_revision'>={schema:'paios.unknown-clock-original.v1',
    quarantine_ref:ref,archive_status:'quarantined',reason:'capture_utc_unavailable',
    event:{...bound,captured_at:raw.captured_at,capture_clock_status:raw.capture_clock_status,origin:'device_observation',user_identity:'unknown'},chunk,
    payload_sha256:hash,bytes:raw.payload.byteLength,
    authorization:{basis:'current_receive_permission',historical_capture_range:'unverified',binding}};
  const proposed={...record,archive_revision:fingerprint(record)};
  await requireRawAvailable(storage,ref);
  const object=await storage.publish('objects',hash,raw.payload);
  check(sha256(object)===hash,'ARCHIVE_OBJECT_INTEGRITY_FAILURE',500);
  try {
  const stored=await storage.publish('quarantine-manifests',ref.slice(14),Buffer.from(canonical(proposed)));
  const winner=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stored)) as QuarantinedOriginal;
  check(winner.archive_revision===proposed.archive_revision,'QUARANTINE_SLOT_CONFLICT',409);
  return (await readUnknownClock(storage,maxBytes,ref,trusted.principal_id,winner.archive_revision)).receipt;
  }catch(error){if(error instanceof Error&&'code' in error&&error.code==='QUARANTINE_SLOT_CONFLICT')throw error;
    throw new QuarantineReceiptFailure(hash,ref,error);}
}
export async function readUnknownClock(storage:StoragePort,maxBytes:number,ref:string,principal:string,
  revision:string,maxReadBytes=maxBytes,proofOnly=false):Promise<{receipt:QuarantinedOriginal;bytes:Uint8Array}> {
  check(/^l5-quarantine:[a-f0-9]{64}$/u.test(ref),'INVALID_QUARANTINE_REF');
  await requireRawAvailable(storage,ref);
  const receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(
    await storage.read('quarantine-manifests',ref.slice(14)))) as QuarantinedOriginal;
  check(receipt.event.principal_id===principal,'RAW_ACCESS_DENIED',403);
  const {archive_revision,...body}=receipt;
  check(archive_revision===revision,'ARCHIVE_REVISION_CONFLICT',409);
  check(receipt.schema==='paios.unknown-clock-original.v1'&&receipt.archive_status==='quarantined'&&
    receipt.reason==='capture_utc_unavailable'&&receipt.quarantine_ref===ref&&
    receipt.event.captured_at===null&&receipt.event.capture_clock_status==='unknown'&&
    receipt.event.origin==='device_observation'&&receipt.event.user_identity==='unknown'&&
    receipt.authorization.basis==='current_receive_permission'&&receipt.authorization.historical_capture_range==='unverified'&&
    fingerprint(body)===archive_revision&&ref===`l5-quarantine:${slot(principal,receipt.event.event_id,receipt.chunk)}`,
    'QUARANTINE_MANIFEST_INVALID',500);
  utc(receipt.event.received_at);validateRange(receipt.chunk.source_range);
  check(Number.isSafeInteger(maxReadBytes)&&maxReadBytes>0,'INVALID_READ_BUDGET');
  check(Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0&&receipt.bytes<=maxBytes&&receipt.bytes<=maxReadBytes,
    'RAW_READ_BUDGET_EXCEEDED',413);
  if(proofOnly)return {receipt,bytes:new Uint8Array()};
  const bytes=await storage.read('objects',receipt.payload_sha256);
  check(bytes.length===receipt.bytes&&sha256(bytes)===receipt.payload_sha256,'ARCHIVE_OBJECT_INTEGRITY_FAILURE',500);
  return {receipt,bytes};
}
