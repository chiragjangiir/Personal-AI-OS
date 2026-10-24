import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import {sourceSnapshot} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {mappedRange} from '../../../services/personal-aios-integration/src/media/align.ts';
import type {PaymentVoiceVerifierOptions} from '../../../services/personal-aios-integration/src/voiceprint/payment-verify.ts';
import {readActivePairedDevices} from './paired-device-authority.ts';
import type {createFormalPcmIngress} from './personal-aios-formal-pcm.ts';
import type {createSourceMediaClock} from './source-media-clock.ts';

/** Pairing facts include offline devices. They are never issued as authenticated transport handles. */
export async function pairedPaymentInventory(pool:Parameters<typeof readActivePairedDevices>[0],principal:string){
  return (await readActivePairedDevices(pool)).filter(device=>device.userId===principal).map(device=>{
    const refs=device.governance.consent_record_refs as {ref_type?:string;ref_id?:string}[];
    check(refs?.length===1&&refs[0]?.ref_type==='ConsentRecord'&&typeof refs[0].ref_id==='string','SOURCE_T03_CONSENT_REQUIRED',403);
    return sourceSnapshot({principal_id:device.userId,device_id:device.deviceId,device_type:device.deviceType,
      capabilities:device.capabilities,channel:'paired_inventory',consent_ref:refs[0].ref_id,
      route_version:`route:paired:${device.deviceId}`,output_modes:['text']});
  });
}
type Terminal={pcm:()=>ReturnType<typeof createFormalPcmIngress>|undefined;clock:ReturnType<typeof createSourceMediaClock>|undefined};
/** Reuse the source clock's pinned receipt and admission binding. An ambiguous track cannot authorize voice. */
export function paymentClockMap(terminalFor:(device:string)=>Terminal|undefined):PaymentVoiceVerifierOptions['clock_map']{
  return async(principal,utterance,record)=>{
    const terminal=terminalFor(utterance.device_id),pcm=terminal?.pcm();
    check(terminal?.clock&&pcm,'SOURCE_CLOCK_REQUIRED',503);
    const {binding,trusted}=await pcm.capture();
    check(trusted.principal_id===principal&&trusted.device_id===utterance.device_id,'PAYMENT_AUDIO_SOURCE_DENIED',403);
    const event={...record.event,raw_ref:record.manifest.raw_ref,archive_revision:record.archive_revision,
      archive_status:'durable' as const,payload_sha256:record.payload_sha256,bytes:record.total_bytes};
    const maps=(await terminal.clock.archivedReceiptClockMaps(principal,event,binding)).filter(map=>map.modality==='audio'&&
      record.manifest.chunks.some(chunk=>{
        if(chunk.track_id!==map.track_id||chunk.stream_epoch!==map.stream_epoch||chunk.modality!=='audio')return false;
        const range=mappedRange(chunk.source_range,map);
        return range.kind==='interval'&&range.start_ms<utterance.end_ms&&range.end_ms>utterance.start_ms;
      }));
    check(maps.length===1,'PAYMENT_AUDIO_CLOCK_REQUIRED',403);
    await terminal.clock.authorizeClockMaps(principal,maps,event,record.manifest);
    return maps[0]!;
  };
}

/** A manual call keeps its VAD's archived sample references; no receipt-time clock or transcript-derived span. */
export async function paymentCallAudio(references:import('../../../services/personal-aios-integration/src/voice/turn-collection.ts').TurnAudioReferences,
  terminal:Terminal,archive:import('../../../services/personal-aios-integration/src/archive.ts').RawArchive):Promise<import('./voice-call-session.ts').CallTurnAudio>{
  const pcm=terminal.pcm();check(terminal.clock&&pcm,'SOURCE_CLOCK_REQUIRED',503);
  const {binding,trusted}=await pcm.capture(),resolved=await Promise.all(references);
  const frames=resolved.filter(ref=>!('silence_samples' in ref));
  check(frames.length>0&&frames.every(ref=>'chunk' in ref),'PAYMENT_CALL_AUDIO_REQUIRED',403);
  const chunks=frames as Extract<(typeof resolved)[number],{chunk:unknown}>[];
  const first=chunks[0]!,last=chunks.at(-1)!;
  check(chunks.every(ref=>ref.event.principal_id===trusted.principal_id&&ref.event.device_id===trusted.device_id&&
    ref.event.raw_ref===first.event.raw_ref&&ref.chunk.track_id===first.chunk.track_id&&ref.chunk.stream_epoch===first.chunk.stream_epoch&&
    ref.chunk.modality==='audio'&&ref.chunk.format==='pcm_s16le:16000:1'&&ref.chunk.source_range.kind==='interval'&&
    Number.isSafeInteger(ref.sample_from)&&Number.isSafeInteger(ref.sample_to)&&ref.sample_from>=0&&ref.sample_to>ref.sample_from&&
    ref.sample_to<=(ref.chunk.source_range.end_ms-ref.chunk.source_range.start_ms)*16),'PAYMENT_CALL_AUDIO_SOURCE_DENIED',403);
  // The final append's revision includes the earlier chunks in this same stream.
  const record=await archive.readRecord(last.event.raw_ref,trusted.principal_id,last.event.archive_revision,{proof_only:true});
  check(record.kind==='stream','PAYMENT_AUDIO_STREAM_REQUIRED');
  const maps=(await terminal.clock.archivedReceiptClockMaps(trusted.principal_id,last.event,binding))
    .filter(map=>map.modality==='audio'&&map.track_id===first.chunk.track_id&&map.stream_epoch===first.chunk.stream_epoch);
  check(maps.length===1,'PAYMENT_AUDIO_CLOCK_REQUIRED',403);
  await terminal.clock.authorizeClockMaps(trusted.principal_id,maps,last.event,record.manifest);
  const span=(ref:typeof first)=>{check(ref.chunk.source_range.kind==='interval','PAYMENT_CALL_AUDIO_REQUIRED');
    return mappedRange({...ref.chunk.source_range,start_ms:ref.chunk.source_range.start_ms+ref.sample_from/16,
      end_ms:ref.chunk.source_range.start_ms+ref.sample_to/16},maps[0]!);};
  const start=span(first),end=span(last);
  check(start.kind==='interval'&&end.kind==='interval'&&end.end_ms>start.start_ms,'PAYMENT_AUDIO_SPAN_INVALID');
  return {raw_ref:last.event.raw_ref,archive_revision:last.event.archive_revision,start_ms:start.start_ms,end_ms:end.end_ms};
}
