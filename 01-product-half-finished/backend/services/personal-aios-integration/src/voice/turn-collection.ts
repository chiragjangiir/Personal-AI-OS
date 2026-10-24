import type {ArchivedEvent} from '../contracts.ts';
import type {TrackChunk} from '../stream-archive.ts';
import {promises as fs} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {check} from '../contracts.ts';
export type TurnAudioReference={event:ArchivedEvent;chunk:TrackChunk;sample_from:number;sample_to:number}|{event:ArchivedEvent;original:true}|{legacy_original:{event:ArchivedEvent;sample_rate:16000}}|{silence_samples:number};
export function isLegacyOriginal(value:unknown):value is {legacy_original:{event:ArchivedEvent;sample_rate:16000}} {
  const ref=value as {legacy_original?:{event?:ArchivedEvent;sample_rate?:unknown}}|null;
  return Boolean(ref?.legacy_original?.sample_rate===16000&&ref.legacy_original.event?.archive_status==='durable'&&
    ref.legacy_original.event.mime==='audio/wav'&&/^l5:[a-f0-9]{64}$/u.test(ref.legacy_original.event.raw_ref)&&
    /^[a-f0-9]{64}$/u.test(ref.legacy_original.event.archive_revision)&&/^[a-f0-9]{64}$/u.test(ref.legacy_original.event.payload_sha256)&&
    typeof ref.legacy_original.event.principal_id==='string'&&ref.legacy_original.event.principal_id.length>0);
}
export type TurnAudioReferences=Promise<TurnAudioReference>[];

/** Legacy evaluation labels own their adjacent WAV; archived audio stays owned by RawArchive. */
export async function resetTurnCorpus(directory:string,cutoff:string,apply=false){
  const before=Date.parse(cutoff),category={name:'legacy-call-turns',delete_count:0,keep_count:0,delete_bytes:0,keep_bytes:0};
  let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {category,blockers:[]};throw error;}
  const files=new Map<string,{bytes:number;remove:boolean}>(),protectedAudio=new Set<string>(),blockers:string[]=[];
  for(const entry of entries){
    check(entry.isFile()&&!entry.isSymbolicLink(),'RESET_TURN_CORPUS_PATH_UNSAFE');
    const path=join(directory,entry.name),size=(await fs.stat(path)).size;files.set(path,{bytes:size,remove:false});
    if(!entry.name.endsWith('.json'))continue;
    const row=JSON.parse(await fs.readFile(path,'utf8')) as {schema:string;at:string;audio?:unknown};
    if(!['paios.call-turn.v1','paios.call-turn.v2'].includes(row.schema)||!Number.isFinite(Date.parse(row.at))){blockers.push('undated_legacy_call_turn');continue;}
    const old=Date.parse(row.at)<before;files.get(path)!.remove=old;
    const audio=typeof row.audio==='string'?resolve(directory,row.audio):path.replace(/\.json$/u,'.wav');
    check(dirname(audio)===resolve(directory),'RESET_TURN_AUDIO_SCOPE_INVALID');
    if(!old)protectedAudio.add(audio);
  }
  for(const [path,value] of files)if(value.remove&&path.endsWith('.json')){
    const row=JSON.parse(await fs.readFile(path,'utf8')) as {audio?:unknown};
    const audio=typeof row.audio==='string'?resolve(directory,row.audio):path.replace(/\.json$/u,'.wav');
    if(files.has(audio)&&!protectedAudio.has(audio))files.get(audio)!.remove=true;
  }
  for(const [path,value] of files){
    if(value.remove){category.delete_count++;category.delete_bytes+=value.bytes;}else{category.keep_count++;category.keep_bytes+=value.bytes;
      if(path.endsWith('.wav')&&!protectedAudio.has(path))blockers.push('unattributed_legacy_call_audio');}
  }
  if(apply){check(!blockers.length,'RESET_TURN_CORPUS_UNRESOLVED');
    // Labels go last: a retry can still identify its audio after an interrupted deletion.
    for(const [path,value] of [...files].sort(([a],[b])=>Number(a.endsWith('.json'))-Number(b.endsWith('.json'))))if(value.remove)await fs.rm(path,{force:true});
  }
  return {category,blockers:[...new Set(blockers)]};
}
