import {canonical,check,digest,sha256} from './contracts.ts';
import {requireRawAvailable,streamManifestRevision,type StreamArchive} from './stream-archive.ts';
import type {StoragePort} from './storage.ts';
import type {FinalSession} from './session-records.ts';

const encode=(value:unknown)=>Buffer.from(canonical(value));
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
async function pendingIngress(storage:StoragePort,rawRef:string){
  const pending:{ingress_key:string;fingerprint:string}[]=[],objects=new Set<string>();
  for(const key of await storage.list('raw-ingress')){
    let bytes:Uint8Array;try{bytes=await storage.read('raw-ingress',key);}catch(error){if(missing(error))continue;throw error;}
    const input=JSON.parse(Buffer.from(bytes).toString()),c=input.record;
    if(typeof input.object_hash==='string')objects.add(input.object_hash);
    if(c.kind!=='stream'||rawRef!==`l5:${digest({event_id:c.raw.event_id,principal_id:c.trusted.principal_id,device_id:c.raw.device_id})}`)continue;
    check(input.schema==='paios.raw-ingress.v1'&&sha256(encode(input))===key,'RAW_INGRESS_METADATA_INVALID',500);
    pending.push({ingress_key:key,fingerprint:digest({...c.chunk,mime:c.raw.mime,representation:c.raw.representation,object_hash:input.object_hash,bytes:input.bytes})});
  }
  return {pending,objects};
}

/** Session end is an acquisition fact. Detection/analysis outcomes are retained, never inferred successful. */
export async function finalizeSession(storage:StoragePort,streams:StreamArchive,rawRef:string,endedBy:string,fold=true):Promise<FinalSession|null> {
  check(storage.publishFinal&&storage.readFinal&&storage.removeOriginals,'SESSION_FINAL_STORAGE_REQUIRED',503);
  check(/^l5:[a-f0-9]{64}$/u.test(rawRef)&&endedBy.length>0,'SESSION_FINAL_IDENTITY');
  const fenced=<T>(work:()=>Promise<T>)=>storage.withOriginalWrite?storage.withOriginalWrite(work):work();
  const sealed=await fenced(async()=>{
    await requireRawAvailable(storage,rawRef);
    const ingress=await pendingIngress(storage,rawRef);
    const final=await storage.readFinal!(rawRef);
    if(final&&!fold)return null;
    if(!final){
      const {pending}=ingress;
      const head=await streams.head(rawRef);if(!head&&!pending.length)return null;
      const revision=head?streamManifestRevision(head):null,key=rawRef.slice(3);
      const proposed={schema:'paios.session.end.v1',raw_ref:rawRef,revision,ended_by:endedBy,...(pending.length?{pending}:{})};
      const end=JSON.parse(Buffer.from(await storage.publish('session-ends',key,encode(proposed))).toString()) as typeof proposed;
      check(end.raw_ref===rawRef&&(end.revision===revision||end.pending?.length),'SESSION_END_REVISION_CONFLICT',409);
      if(!fold)return null;
      // Publication waits may detach at shutdown, but their admitted originals still belong to this ended source.
      if(pending.length){check(pending.every(p=>end.pending?.some(e=>e.ingress_key===p.ingress_key)),'SESSION_PENDING_INGRESS_CONFLICT',409);return null;}
      check(head,'SESSION_STREAM_REQUIRED',404);
      if(end.pending?.length){
        if(end.revision)await streams.readRecord(rawRef,head.event.principal_id,end.revision,{proof_only:true});
        check(end.pending.every(p=>head.chunks.some(c=>c.fingerprint===p.fingerprint)),'SESSION_PENDING_INGRESS_MISSING',500);
      }
      return {head,end,final:null};
    }
    return {final,head:null,end:null};
  });
  if(!sealed)return null;
  let final=sealed.final;
  if(!final){
    const head=sealed.head!,end=sealed.end!;
    // The durable end seals the immutable revision. Folding its bytes does not own capture admission.
    const selected=await streams.readRecord(rawRef,head.event.principal_id,streamManifestRevision(head));
    // One deterministic byte axis for all audio tracks. Old descriptors and revisions retain their exact semantics.
    const ordered=selected.chunks.filter(c=>c.chunk.modality==='audio').sort((a,b)=>
      a.chunk.track_id.localeCompare(b.chunk.track_id)||a.chunk.stream_epoch.localeCompare(b.chunk.stream_epoch)||a.chunk.seq-b.chunk.seq);
    check(ordered.length>0,'SESSION_AUDIO_REQUIRED');
    const audio=Buffer.concat(ordered.map(c=>Buffer.from(c.bytes))),objectHash=sha256(audio);
    const records:FinalSession['records']=[],keys=new Set<string>();
    const include=async(namespace:string,key:string,required=false)=>{
      const identity=`${namespace}:${key}`;if(keys.has(identity))return;
      let bytes:Uint8Array;try{bytes=await storage.read(namespace,key);}catch(error){if(!required&&missing(error))return;throw error;}
      keys.add(identity);records.push({namespace,key,bytes:Buffer.from(bytes).toString('base64')});
    };
    // Both immutable proof names and their sequence aliases must survive old pinned references.
    for(let n=1;n<=head.revision;n++){
      await include('stream-revisions',digest([rawRef,n]),true);
      if(head.schema==='paios.stream.v2')await include('stream-revisions',digest(head.journal![n-1]!),true);
    }
    for(const record of await storage.sessionRecords?.(rawRef)??[])if(record.namespace!=='objects')await include(record.namespace,record.key);
    await include('session-ends',rawRef.slice(3),true);
    let offset=0;const objects:FinalSession['objects']=[],mapped=new Set<string>();
    for(const {chunk} of ordered){
      if(chunk.object_hash!==objectHash&&!mapped.has(chunk.object_hash)){
        objects.push({key:chunk.object_hash,offset,bytes:chunk.bytes});mapped.add(chunk.object_hash);}
      offset+=chunk.bytes;
    }
    const call=await storage.callTrack?.(rawRef);
    check(!call||call.principal_id===head.event.principal_id,'CALL_TRACK_PRINCIPAL_CONFLICT',409);
    const candidate:FinalSession={schema:'paios.session.final.v1',raw_ref:rawRef,object_hash:objectHash,bytes:audio.length,
      ended_by:end.ended_by,records,objects,...(call?{call}:{}),
      retained_objects:selected.chunks.filter(c=>c.chunk.modality!=='audio').map(c=>({key:c.chunk.object_hash,format:c.chunk.format}))};
    final=await fenced(async()=>{
      await requireRawAvailable(storage,rawRef);
      await storage.publish('objects',objectHash,audio);
      const readback=await storage.read('objects',objectHash);
      check(readback.length===audio.length&&sha256(readback)===objectHash,'SESSION_FINAL_READBACK_FAILED',500);
      const committed=await storage.publishFinal!(candidate);
      check(canonical(committed)===canonical(candidate),'SESSION_FINAL_CONFLICT',409);return committed;
    });
  }
  // The SQLite commit is the visibility boundary. Every old key now resolves without its individual file.
  // Re-verify the replacement on resume before unlinking even the first original.
  const audio=await storage.read('objects',final.object_hash);
  check(audio.length===final.bytes&&sha256(audio)===final.object_hash,'SESSION_FINAL_READBACK_FAILED',500);
  for(const object of final.objects){const slice=audio.subarray(object.offset,object.offset+object.bytes);
    check(slice.length===object.bytes&&sha256(slice)===object.key,'SESSION_FINAL_RANGE_FAILED',500);}
  const committed=final;
  return fenced(async()=>{
    await requireRawAvailable(storage,rawRef);
    const ingress=await pendingIngress(storage,rawRef);
    const removals=committed.records.map(({namespace,key})=>({namespace,key}));
    for(const key of new Set(committed.objects.map(c=>c.key).filter(key=>key!==committed.object_hash)))
      if(!ingress.objects.has(key)&&!await storage.hasLiveSessionOwner?.({namespace:'objects',key}))removals.push({namespace:'objects',key});
    await storage.removeOriginals!(removals);
    await storage.completeFinal?.(rawRef);
    return committed;
  });
}

/** Only durable end intents or a committed fold authorize automatic recovery. A crashed live lane remains open. */
export async function recoverFinalSessions(storage:StoragePort,streams:StreamArchive,fold=true):Promise<void>{
  if(!storage.readFinal)return;
  const refs=new Set(await storage.pendingFinals?.()??[]);
  for(const key of await storage.listHot?.('session-ends')??[])refs.add(`l5:${key}`);
  for(const ref of refs){const final=await storage.readFinal(ref);
    const end=final??JSON.parse(Buffer.from(await storage.read('session-ends',ref.slice(3))).toString());
    await finalizeSession(storage,streams,ref,end.ended_by,fold);}
}
