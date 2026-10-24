/** Version boundary for canonical session transport. Native storage owns decoding and identity. */
import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {canonical,check,sha256} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import type {StoragePort} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';

type Ref={namespace:string;key:string};
type Call={call_id:string;principal_id:string;track:'pre_call_ambient'|'microphone'|'assistant_reply'};
export type TransportFinal={schema:'paios.session.final.v1';raw_ref:string;object_hash:string;bytes:number;
  records:(Ref&{bytes:string})[];objects:{key:string;offset:number;bytes:number}[];
  retained_objects?:{key:string;format:string}[];ended_by:string;call?:Call};
export type SessionStorage=StoragePort&{
  readonly scratch?:string;
  readFinal?(ref:string):Promise<TransportFinal|null>;
  publishFinal?(final:TransportFinal):Promise<TransportFinal>;
  callTrack?(ref:string):Promise<Call|null>;
  bindCallTrack?(ref:string,call:Call):Promise<void>;
  sessionRecords?(ref:string):Promise<Ref[]>;
  trackSessionRecords?(ref:string,records:Ref[]):Promise<void>;
  pendingFinals?():Promise<string[]>;
  completeFinal?(ref:string):Promise<void>;
};
export type SessionPut=(namespace:string,key:string,bytes?:Uint8Array)=>Promise<void>;

/** Frozen source only: copy sidecars before opening the native index on writable scratch. */
export async function prepareSessionIndex(source:string,scratch:string):Promise<boolean>{
  source=resolve(source);scratch=resolve(scratch);check(source!==scratch,'SESSION_INDEX_SOURCE_OVERLAP');
  const path=join(source,'session-records.sqlite');let stat;
  try{stat=await fs.lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_SESSION_INDEX');
  await fs.mkdir(scratch,{recursive:true,mode:0o700});
  for(const suffix of ['','-wal','-shm'])try{
    const from=path+suffix,detail=await fs.lstat(from);check(detail.isFile()&&!detail.isSymbolicLink(),'UNSAFE_SESSION_INDEX');
    await fs.copyFile(from,join(scratch,'session-records.sqlite'+suffix));await fs.chmod(join(scratch,'session-records.sqlite'+suffix),0o600);
  }catch(error){if(!suffix||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return true;
}
async function bind(destination:SessionStorage,ref:string,call:Call|null|undefined){
  if(!call)return;check(destination.bindCallTrack,'SESSION_DESTINATION_API_REQUIRED');await destination.bindCallTrack!(ref,call);
}
async function readAudio(disk:SessionStorage,final:TransportFinal){
  const audio=await disk.read('objects',final.object_hash);
  check(audio.length===final.bytes&&sha256(audio)===final.object_hash,'SESSION_FINAL_READBACK_FAILED');
  for(const object of final.objects){const bytes=audio.subarray(object.offset,object.offset+object.bytes);
    check(bytes.length===object.bytes&&sha256(bytes)===object.key,'SESSION_FINAL_RANGE_FAILED');}return audio;
}
async function cacheAudio(scratch:string,final:TransportFinal,audio:Uint8Array){
  const directory=join(scratch,'objects');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,final.object_hash);
  try{await fs.writeFile(path,audio,{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    check(Buffer.from(await fs.readFile(path)).equals(Buffer.from(audio)),'SESSION_CACHE_CONFLICT');}
}
/** Reads one aggregate once. Optional supplied bytes let the caller's ordinary put avoid another GET. */
export async function transferSession(disk:SessionStorage,destination:SessionStorage,ref:string,put:SessionPut):Promise<TransportFinal|false>{
  if(!disk.readFinal)return false;
  const final=await disk.readFinal(ref);
  if(!final){
    await bind(destination,ref,await disk.callTrack?.(ref));
    const records=await disk.sessionRecords?.(ref)??[];
    if(records.length){check(destination.trackSessionRecords,'SESSION_DESTINATION_API_REQUIRED');
      for(const record of records)await put(record.namespace,record.key);
      await destination.trackSessionRecords!(ref,records);}
    try{await put('session-ends',ref.slice(3));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return false;
  }
  check(final.raw_ref===ref,'SESSION_FINAL_IDENTITY');
  check(destination.publishFinal&&destination.completeFinal&&disk.pendingFinals,'SESSION_TRANSPORT_API_REQUIRED');
  const audio=await readAudio(disk,final);if(disk.scratch)await cacheAudio(disk.scratch,final,audio);
  await put('objects',final.object_hash,audio);
  for(const object of final.retained_objects??[]){const bytes=await disk.read('objects',object.key);
    check(sha256(bytes)===object.key,'SESSION_RETAINED_OBJECT_INTEGRITY');await put('objects',object.key,bytes);}
  await bind(destination,ref,final.call);
  const published=await destination.publishFinal!(final);check(canonical(published)===canonical(final),'SESSION_FINAL_CONFLICT');
  if(!(await disk.pendingFinals!()).includes(ref))await destination.completeFinal!(ref);
  return final;
}
/** Verify native alias reconstruction and byte offsets without another session metadata implementation. */
export async function verifySession(disk:SessionStorage,ref:string):Promise<TransportFinal>{
  check(disk.readFinal,'SESSION_TRANSPORT_API_REQUIRED');const final=await disk.readFinal!(ref);check(final,'SESSION_FINAL_REQUIRED');
  const audio=await readAudio(disk,final!);if(disk.scratch)await cacheAudio(disk.scratch,final!,audio);
  for(const record of final!.records)check(Buffer.from(await disk.read(record.namespace,record.key)).equals(Buffer.from(record.bytes,'base64')),'SESSION_FINAL_RECORD_INTEGRITY');
  for(const object of final!.retained_objects??[])check(sha256(await disk.read('objects',object.key))===object.key,'SESSION_RETAINED_OBJECT_INTEGRITY');
  check(canonical(await disk.callTrack?.(ref)??null)===canonical(final!.call??null),'CALL_TRACK_FINAL_CONFLICT');return final!;
}
