import type {Json, ArchivedEvent} from '../contracts.ts';
import type {RegisteredDevice} from '../source-authority.ts';
import type {MediaProcessRequest} from '../media/service.ts';
export interface VoiceIdentity {connectionId:string;connectionEpoch:number}
export interface ThinkingModeConfiguration {
  enabled:boolean;
  reader_instructions:string;
  status_text:{greeting:string;waiting:string;slow:string;failed:string;interrupted:string;readout_mismatch:string};
}
export interface VoiceCandidate extends VoiceIdentity {
  kind:'transcript'|'tool'|'partial';event:Record<string,unknown>;provider:string;model:string;region:string;
}
export interface VoiceFrontend {
  connect():Promise<void>;appendAudio(audio:string):void;commitInput():void;identity():VoiceIdentity;
  close():void;join():Promise<void>;
}
export interface VoiceRecord {
  schema:'paios.voice-transcript.v1';candidate_ref:string;raw_ref:string;archive_revision:string;
  principal_id:string;device_id:string;window_ref:string;turn_id:string;window_range:MediaProcessRequest['time_range'];
  candidate_revision:string;selected_input_sha256:string;selected_views:Json;candidate:VoiceCandidate;
  range_association:'host_window_only';authorization:'unknown';
}
export interface VoiceGrant {window_ref:string;turn_id:string;purpose_evidence_ref:string}
/** Exact candidate fields a user confirms on the formal channel. */
export interface VoiceConfirmation {
  candidate_ref:string;candidate_revision:string;window_ref:string;selected_input_sha256:string;transcript_sha256:string;
}
export interface VoiceDecision {
  state:'confirmed_request'|'unknown'|'other';semantic_status:'explicit_end'|'unknown';
  candidate_ref:string;window_ref:string;turn_id:string;identity:VoiceIdentity;
  source_digest:string;transcript_sha256:string;request_evidence_ref:string;
}
/** Host resources, never client/model fields. Final confirmation adopts exact text as a request.
 * It does not prove the recorded speaker's identity. */
export interface VoiceResources {
  configured:boolean;
  create(callbacks:{onCandidate:(candidate:VoiceCandidate)=>void;onEvent:(event:Record<string,unknown>)=>void}):VoiceFrontend;
  authorizeWindow(source:RegisteredDevice,event:ArchivedEvent,request:MediaProcessRequest):Promise<VoiceGrant>;
  authorizeFinal(source:RegisteredDevice,record:VoiceRecord,evidenceRef:string):Promise<VoiceDecision>;
  /** Persists the formal voice_send confirmation and returns the evidence ref authorizeFinal consumes. */
  recordConfirmation?(source:RegisteredDevice,session:string,operation:string,confirmation:VoiceConfirmation):Promise<string>;
  /** Whether that exact confirmation was persisted: the record a resend is answered from once no live outcome is cached. */
  hasConfirmation?(source:RegisteredDevice,session:string,operation:string,confirmation:VoiceConfirmation):Promise<boolean>;
  recoverConfirmation?(source:RegisteredDevice,operation:string):Promise<{record:VoiceRecord;evidenceRef:string}|undefined>;
  onError(error:unknown):void;
}
