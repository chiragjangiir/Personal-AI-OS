import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {check,digest,type ProcessedEvent} from './contracts.ts';
import type {StoragePort} from './storage.ts';
import type {SessionRecordRef} from './session-records.ts';
import {CONVERSATION_RESET_CUTOFF,isConversationEvent} from './archive-conversation-reset.ts';
import {Timeline} from './timeline.ts';
import {AmbientJournal} from './ambient/journal.ts';
import {CareAuthority} from './care/authority.ts';
import type {ResetCategory} from './owner-db.ts';

interface Identity {principal_id:string;processed_event_id:string}
export interface IntegrationResetOptions {
  storage_root:string;storage:StoragePort;cutoff?:string;apply?:boolean;
  removed_raw_refs:readonly string[];selected_records:readonly SessionRecordRef[];known_raw_refs?:readonly string[];
}
interface RecordValue extends SessionRecordRef {size:number;value:unknown;audio_refs:string[];remove:boolean}
const ancillary=['processed-events','processed-event-sources','d-session-bindings','voice-transcripts','watch-turns','watch-turn-media','watch-turn-outcomes',
  'admissions','admission-inputs','run-bindings','run-terminals','run-attempts','run-attempt-results','run-cancel-intents','run-conversation-releases',
  'run-amendment-intents','run-amendment-receipts','output-journal','derived-audio'];
const owned=(name:string)=>ancillary.includes(name)||name.startsWith('media-')||name.startsWith('audio-consumer-')||['processed-media','processed-media-inputs'].includes(name);
const identity=(r:SessionRecordRef)=>`${r.namespace}:${r.key}`;
function audioRefs(value:unknown):string[] {
  if(typeof value==='string')return /^audio:[a-f0-9]{64}$/u.test(value)?[value]:[];
  if(Array.isArray(value))return value.flatMap(audioRefs);
  return value!==null&&typeof value==='object'?Object.values(value).flatMap(audioRefs):[];
}
/** Retain selection identities only; transcript, model output and provider bodies die after each read. */
function planningValue(value:unknown):unknown {
  if(value===null||typeof value!=='object'||Array.isArray(value))return;
  const v=value as Record<string,unknown>,out:Record<string,unknown>={};
  for(const key of ['principal_id','processed_event_id','run_id','raw_ref','media_type','captured_at','received_at','binding'])if(v[key]!==undefined)out[key]=v[key];
  for(const key of ['event','common'])if(v[key]&&typeof v[key]==='object')out[key]={raw_ref:(v[key] as {raw_ref?:unknown}).raw_ref};
  if(v.result&&typeof v.result==='object'){const r=v.result as {processed_event_id?:unknown;run_id?:unknown};out.result={processed_event_id:r.processed_event_id,run_id:r.run_id};}
  if(v.d)out.d=planningValue(v.d);
  if(v.content&&typeof v.content==='object'){const c=v.content as {app_event?:{kind?:unknown};audio_observations?:unknown[]};
    out.content={app_event:{kind:c.app_event?.kind},audio_observations:Array.isArray(c.audio_observations)?c.audio_observations.filter(o=>o&&typeof o==='object'&&(o as {observation_kind?:unknown}).observation_kind==='sourced_speech').map(o=>({observation_kind:'sourced_speech',evidence:{raw_ref:(o as {evidence?:{raw_ref?:unknown}}).evidence?.raw_ref}})):[]};}
  return out;
}
function eventOf(value:unknown):ProcessedEvent|undefined {
  if(value===null||typeof value!=='object')return;
  const v=value as {processed_event_id?:unknown;captured_at?:unknown;media_type?:unknown;d?:unknown};
  return typeof v.processed_event_id==='string'&&typeof v.captured_at==='string'&&typeof v.media_type==='string'?v as ProcessedEvent:eventOf(v.d);
}
/** Offline, exact source closure. Raw/archive deletion is owned by RawArchive and runs after this plan. */
export async function resetIntegrationConversation(options:IntegrationResetOptions) {
  const {storage,storage_root:root,apply=false}=options,cutoff=options.cutoff??CONVERSATION_RESET_CUTOFF;
  check(cutoff===CONVERSATION_RESET_CUTOFF,'RESET_CUTOFF_MISMATCH');const before=Date.parse(cutoff);
  const raw=new Set(options.removed_raw_refs),selected=new Set(options.selected_records.filter(r=>owned(r.namespace)).map(identity));
  const names=new Set(ancillary),records:RecordValue[]=[],removed=new Map<string,Identity>(),blockedRaw=new Set<string>();
  const directories=await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const entry of directories){if(owned(entry.name)){check(entry.isDirectory()&&!entry.isSymbolicLink(),'RESET_NAMESPACE_PATH_UNSAFE');names.add(entry.name);}}
  for(const namespace of names)for(const key of await storage.list(namespace)){
    let value:unknown,size:number,audio_refs:string[]=[];
    if(namespace==='derived-audio'&&storage.objectSize)size=await storage.objectSize(namespace,key);
    else if(namespace==='derived-audio'&&storage.hotSize){try{size=await storage.hotSize(namespace,key);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;size=(await storage.read(namespace,key)).length;}}
    else {const bytes=await storage.read(namespace,key);size=bytes.length;if(namespace!=='derived-audio'){const parsed=JSON.parse(Buffer.from(bytes).toString());audio_refs=audioRefs(parsed);value=planningValue(parsed);}}
    records.push({namespace,key,size,value,audio_refs,remove:selected.has(`${namespace}:${key}`)});
  }
  for(const record of records){const d=eventOf(record.value);if(!d)continue;
    if(Date.parse(d.received_at)>=before){record.remove=false;if(raw.has(d.raw_ref))blockedRaw.add(d.raw_ref);continue;}
    const eligible=Date.parse(d.received_at)<before&&isConversationEvent(d,d.content?.app_event);
    if(eligible&&raw.has(d.raw_ref)){
      record.remove=true;const id={principal_id:d.principal_id,processed_event_id:d.processed_event_id};removed.set(digest(id),id);
    }
  }
  const processedIds=new Set([...removed.values()].map(v=>v.processed_event_id)),dKeys=new Set(removed.keys()),admissionKeys=new Set<string>(),runIds=new Map<string,string>(),bindings=new Set<string>(),audio=new Set<string>(),watchKeys=new Set<string>(),amendmentKeys=new Set<string>();
  const processedOwners=new Map([...removed.values()].map(d=>[d.processed_event_id,d.principal_id]));
  for(const record of records){
    const d=eventOf(record.value);if(d&&Date.parse(d.received_at)>=before)continue;
    const source=record.value as {raw_ref?:string;event?:{raw_ref?:string};common?:{raw_ref?:string}}|undefined;
    const sourceRef=source?.raw_ref??source?.event?.raw_ref??source?.common?.raw_ref;
    if(sourceRef&&raw.has(sourceRef)||['processed-event-sources','d-session-bindings'].includes(record.namespace)&&dKeys.has(record.key))record.remove=true;
    const v=record.value as {processed_event_id?:string;principal_id?:string;run_id?:string;result?:{processed_event_id?:string;run_id?:string};binding?:string}|undefined;
    if(record.namespace==='admissions'&&v?.processed_event_id&&processedIds.has(v.processed_event_id))admissionKeys.add(record.key);
    if(record.namespace==='output-journal'&&v?.result?.processed_event_id&&processedIds.has(v.result.processed_event_id)&&v.binding){bindings.add(v.binding);const principal=processedOwners.get(v.result.processed_event_id);if(principal&&v.result.run_id)runIds.set(v.result.run_id,principal);}
    if(record.namespace.startsWith('watch-turn')&&record.remove)watchKeys.add(record.key);
    if(record.namespace==='run-amendment-intents'&&v?.processed_event_id&&processedIds.has(v.processed_event_id))amendmentKeys.add(record.key);
  }
  for(const record of records){if(record.namespace==='run-bindings'&&admissionKeys.has(record.key)){
    const v=record.value as {run_id:string};const admission=records.find(r=>r.namespace==='admissions'&&r.key===record.key)!.value as {principal_id:string};runIds.set(v.run_id,admission.principal_id);}}
  const outputKeys=new Set<string>(),outputRanks=new Map<string,number>(),existingOutputs=new Set(records.filter(r=>r.namespace==='output-journal').map(r=>r.key));
  // OutputAuthority writes a gapless sequence per run. Each existing entry is visited once.
  for(const [run_id,principal_id] of runIds){const scope=digest({principal_id,run_id});for(let seq=0;;seq++){const key=digest({scope,seq});if(!existingOutputs.has(key))break;outputKeys.add(key);outputRanks.set(key,seq);}}
  const attempts=new Set(records.filter(r=>r.namespace==='run-attempts').map(r=>r.key)),attemptKeys=new Set(admissionKeys),attemptRanks=new Map<string,number>();
  for(const key of admissionKeys)for(let count=2;;count++){const next=digest({admission:key,attempt_seq:count});if(!attempts.has(next))break;attemptKeys.add(next);attemptRanks.set(next,count);}
  for(const record of records){
    if((record.namespace==='admission-inputs'||record.namespace==='admissions'||record.namespace.startsWith('run-'))&&admissionKeys.has(record.key))record.remove=true;
    if(['run-attempts','run-attempt-results'].includes(record.namespace)&&attemptKeys.has(record.key)||record.namespace.startsWith('watch-turn')&&watchKeys.has(record.key)||record.namespace.startsWith('run-amendment-')&&amendmentKeys.has(record.key))record.remove=true;
    const value=record.value as {binding?:string;processed_event_id?:string}|undefined;
    if(record.namespace==='output-journal'&&(outputKeys.has(record.key)||value?.binding&&bindings.has(value.binding)))record.remove=true;
    if(record.namespace==='run-amendment-intents'&&value?.processed_event_id&&processedIds.has(value.processed_event_id))record.remove=true;
    if(record.remove)for(const ref of record.audio_refs)audio.add(ref.slice(6));
  }
  // Content-addressed TTS may be shared by a surviving output. Its live reference wins.
  for(const record of records)if(!record.remove){for(const ref of record.audio_refs)audio.delete(ref.slice(6));
    const d=eventOf(record.value);if(d&&Array.isArray(d.content?.audio_observations))for(const observation of d.content.audio_observations){
      const evidence=observation as {observation_kind?:unknown;evidence?:{raw_ref?:unknown}}|null;
      if(evidence?.observation_kind==='sourced_speech'&&typeof evidence.evidence?.raw_ref==='string'&&raw.has(evidence.evidence.raw_ref))blockedRaw.add(evidence.evidence.raw_ref);}}
  for(const record of records)if(record.namespace==='derived-audio'&&audio.has(record.key))record.remove=true;
  const categories:ResetCategory[]=[];
  for(const name of names){const category:ResetCategory={name,delete_count:0,keep_count:0,delete_bytes:0,keep_bytes:0};
    for(const r of records.filter(r=>r.namespace===name)){if(r.remove){category.delete_count++;category.delete_bytes+=r.size;}else{category.keep_count++;category.keep_bytes+=r.size;}}
    categories.push(category);
  }
  const sources={removed_raw_refs:options.removed_raw_refs,known_raw_refs:options.known_raw_refs??options.removed_raw_refs};
  const sqlite=(execute:boolean)=>[Timeline.resetConversation(join(root,'timeline'),before,execute),AmbientJournal.resetConversation(join(root,'ambient-journal'),before,execute,sources),CareAuthority.resetConversation(join(root,'care'),before,execute)].filter((r):r is ResetCategory=>r!==undefined);
  const sqlitePreview=sqlite(false),blockers=[...(blockedRaw.size?['derivative_source_crosses_cutoff']:[]),...(sqlitePreview.some(r=>r.unresolved_sources)?['ambient_source_unresolved']:[]),...(sqlitePreview.some(r=>r.crossing_sources)?['ambient_source_crosses_cutoff']:[])];
  if(apply){check(storage.removeOriginals,'RESET_STORAGE_REMOVAL_UNSUPPORTED');
    check(!blockedRaw.size,'RESET_D_SOURCE_CROSSES_CUTOFF');
    check(!blockers.length,'RESET_INTEGRATION_SOURCE_UNRESOLVED');
    // Delete consumers before their discoverability anchors; a fresh plan can resume every prefix.
    const priority=(r:RecordValue)=>r.namespace==='derived-audio'?0:r.namespace==='output-journal'?10:r.namespace==='run-attempt-results'?20:r.namespace==='run-attempts'?30:r.namespace==='run-amendment-receipts'?35:r.namespace==='run-amendment-intents'?40:r.namespace==='run-bindings'?50:r.namespace==='admissions'?70:r.namespace==='admission-inputs'?80:r.namespace==='watch-turn-media'?85:eventOf(r.value)?90:r.namespace==='processed-event-sources'||r.namespace==='d-session-bindings'?88:15;
    const rank=(r:RecordValue)=>r.namespace==='output-journal'?outputRanks.get(r.key)??0:r.namespace==='run-attempts'||r.namespace==='run-attempt-results'?attemptRanks.get(r.key)??1:0;
    await storage.removeOriginals(records.filter(r=>r.remove).sort((a,b)=>priority(a)-priority(b)||rank(b)-rank(a)));
  }
  categories.push(...(apply?sqlite(true):sqlitePreview));
  return {categories,removed_processed_events:[...removed.values()],removed_raw_refs:[...raw],blocked_raw_refs:[...blockedRaw],blockers};
}
