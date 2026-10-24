import {canonical,check,digest,id,sha256,type ArchivedEvent} from '../contracts.ts';
import type {RegisteredDevice} from '../source-authority.ts';
import type {StoragePort} from '../storage.ts';
import type {MediaProcessRequest} from '../media/service.ts';
import type {VoiceConfirmation,VoiceDecision,VoiceGrant,VoiceRecord} from './contracts.ts';

interface ConfirmationReceipt extends VoiceConfirmation {
  schema:'paios.voice-confirmation.v1';principal_id:string;device_id:string;session_id:string;operation_id:string;
  source:'formal_voice_send';
}
const NAMESPACE='voice-confirmations';
const REF=/^voice-send:([a-f0-9]{64})$/u;

/** Host window grant plus the typed formal confirmation receipt that final authorization consumes.
 * Only the authenticated formal voice_send path writes a receipt; client strings, provider callbacks,
 * model output and device ownership cannot mint one. It adopts exact text, never speaker identity. */
export function createFormalVoiceAuthority(storage:StoragePort) {
  const receiptOf=(source:RegisteredDevice,session:string,operation:string,confirmation:VoiceConfirmation):ConfirmationReceipt=>{
    for(const value of [session,operation,confirmation.candidate_ref,confirmation.candidate_revision,confirmation.window_ref,
      confirmation.selected_input_sha256,confirmation.transcript_sha256])id(value);
    return {schema:'paios.voice-confirmation.v1',principal_id:source.principal_id,
      device_id:source.device_id,session_id:session,operation_id:operation,source:'formal_voice_send',
      candidate_ref:confirmation.candidate_ref,candidate_revision:confirmation.candidate_revision,
      window_ref:confirmation.window_ref,selected_input_sha256:confirmation.selected_input_sha256,
      transcript_sha256:confirmation.transcript_sha256};
  };
  return Object.freeze({
    async authorizeWindow(source:RegisteredDevice,event:ArchivedEvent,request:MediaProcessRequest):Promise<VoiceGrant> {
      check(event.principal_id===source.principal_id&&event.device_id===source.device_id,'VOICE_WINDOW_SCOPE',403);
      id(event.consent_ref);
      const window=digest([source.principal_id,source.device_id,event.raw_ref,request.archive_revision,request.time_range]);
      return {window_ref:`voice-window:${window}`,turn_id:`voice-turn:${window}`,purpose_evidence_ref:event.consent_ref};
    },
    async recordConfirmation(source:RegisteredDevice,session:string,operation:string,confirmation:VoiceConfirmation):Promise<string> {
      const receipt=receiptOf(source,session,operation,confirmation);
      if(source.channel==='watch_https'){
        const slot=digest([source.principal_id,source.device_id,operation]);
        const winner=await storage.publish('voice-confirmation-operations',slot,Buffer.from(canonical(receipt)));
        check(Buffer.from(winner).toString()===canonical(receipt),'VOICE_CONFIRMATION_CONFLICT',409);
      }
      const key=digest(receipt);
      const saved=await storage.publish(NAMESPACE,key,Buffer.from(canonical(receipt)));
      check(Buffer.from(saved).toString()===canonical(receipt),'VOICE_CONFIRMATION_CONFLICT',409);
      return `voice-send:${key}`;
    },
    async hasConfirmation(source:RegisteredDevice,session:string,operation:string,confirmation:VoiceConfirmation):Promise<boolean> {
      const receipt=receiptOf(source,session,operation,confirmation);
      try {return Buffer.from(await storage.read(NAMESPACE,digest(receipt))).toString()===canonical(receipt);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
    },
    async recoverConfirmation(source:RegisteredDevice,operation:string):Promise<{record:VoiceRecord;evidenceRef:string}|undefined>{
      check(source.channel==='watch_https','VOICE_WINDOW_SCOPE',403);
      const slot=digest([source.principal_id,source.device_id,operation]);let receipt:ConfirmationReceipt;
      try{receipt=JSON.parse(Buffer.from(await storage.read('voice-confirmation-operations',slot)).toString());}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      check(receipt.principal_id===source.principal_id&&receipt.device_id===source.device_id&&receipt.operation_id===operation&&
        receipt.schema==='paios.voice-confirmation.v1'&&receipt.source==='formal_voice_send','VOICE_CONFIRMATION_INTEGRITY',409);
      const key=digest(receipt),bytes=Buffer.from(canonical(receipt));
      const saved=await storage.publish(NAMESPACE,key,bytes);check(Buffer.from(saved).equals(bytes),'VOICE_CONFIRMATION_INTEGRITY',409);
      const candidateKey=/^voice-candidate:([a-f0-9]{64})$/u.exec(receipt.candidate_ref)?.[1];check(candidateKey,'VOICE_CONFIRMATION_INTEGRITY',409);
      const record=JSON.parse(Buffer.from(await storage.read('voice-transcripts',candidateKey)).toString()) as VoiceRecord;
      check(record.candidate_ref===receipt.candidate_ref&&record.principal_id===source.principal_id&&record.device_id===source.device_id,
        'VOICE_CONFIRMATION_INTEGRITY',409);
      return {record,evidenceRef:`voice-send:${key}`};
    },
    async authorizeFinal(source:Pick<RegisteredDevice,'principal_id'|'device_id'>,record:VoiceRecord,evidenceRef:string):Promise<VoiceDecision> {
      const text=record.candidate.event.transcript;
      const decision=(confirmed:boolean):VoiceDecision=>({state:confirmed?'confirmed_request':'unknown',
        semantic_status:confirmed?'explicit_end':'unknown',candidate_ref:record.candidate_ref,window_ref:record.window_ref,
        turn_id:record.turn_id,identity:{connectionId:record.candidate.connectionId,connectionEpoch:record.candidate.connectionEpoch},
        source_digest:record.selected_input_sha256,transcript_sha256:typeof text==='string'?sha256(text):'',
        request_evidence_ref:evidenceRef});
      const key=REF.exec(evidenceRef)?.[1];
      if(!key)return decision(false);
      let receipt:ConfirmationReceipt;
      try {receipt=JSON.parse(Buffer.from(await storage.read(NAMESPACE,key)).toString()) as ConfirmationReceipt;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return decision(false);throw error;}
      check(digest(receipt)===key,'VOICE_CONFIRMATION_INTEGRITY',409);
      return decision(receipt.schema==='paios.voice-confirmation.v1'&&receipt.source==='formal_voice_send'&&
        receipt.principal_id===source.principal_id&&receipt.device_id===source.device_id&&
        record.principal_id===source.principal_id&&record.device_id===source.device_id&&
        record.candidate.kind==='transcript'&&typeof text==='string'&&receipt.transcript_sha256===sha256(text)&&
        receipt.candidate_ref===record.candidate_ref&&receipt.candidate_revision===record.candidate_revision&&
        receipt.window_ref===record.window_ref&&receipt.selected_input_sha256===record.selected_input_sha256);
    },
  });
}
