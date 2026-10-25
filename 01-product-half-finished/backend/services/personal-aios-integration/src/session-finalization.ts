import {createHash} from 'node:crypto';
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

async function verifyFinal(storage:StoragePort,final:FinalSession,checkpoint:()=>Promise<void>){
  const verify=async(key:string,offset:number,bytes:number,expected:string,code:string)=>{
    const hash=createHash('sha256');let count=0;
    for await(const block of storage.readObjectRange!(key,offset,bytes)){await checkpoint();hash.update(block);count+=block.length;}
    check(count===bytes&&hash.digest('hex')===expected,code,500);
  };
  await verify(final.object_hash,0,final.bytes,final.object_hash,'SESSION_FINAL_READBACK_FAILED');
  for(const object of final.objects)await verify(final.object_hash,object.offset,object.bytes,object.key,'SESSION_FINAL_RANGE_FAILED');
}

/** Session end is an acquisition fact. Detection/analysis outcomes are retained, never inferred successful. */
export async function finalizeSession(storage:StoragePort,streams:StreamArchive,rawRef:string,endedBy:string,fold=true,options:{checkpoint?:()=>Promise<void>;idle_before?:number}={}):Promise<FinalSession|null> {
  const checkpoint=options.checkpoint??(async()=>{});
  check(storage.publishFinal&&storage.readFinal&&storage.removeOriginals&&storage.publishObjectStream&&storage.readObjectRange,'SESSION_FINAL_STORAGE_REQUIRED',503);
  check(/^l5:[a-f0-9]{64}$/u.test(rawRef)&&endedBy.length>0,'SESSION_FINAL_IDENTITY');
  const fenced=<T>(work:()=>Promise<T>)=>storage.withOriginalWrite?storage.withOriginalWrite(work):work();
  // Journal verification is outside the capture fence, including source-end publication.
  const prepared=await storage.readFinal(rawRef)?null:await streams.head(rawRef,fold?{checkpoint}:{});
  const sealed=await fenced(async()=>{
    await requireRawAvailable(storage,rawRef);
    const ingress=await pendingIngress(storage,rawRef);
    const final=await storage.readFinal!(rawRef);
    if(final&&!fold)return null;
    if(!final){
      const {pending}=ingress;
      const head=prepared;if(!head&&!pending.length)return null;
      if(head)try{await storage.read('stream-revisions',digest([rawRef,head.revision+1]));return 'advanced' as const;}catch(error){if(!missing(error))throw error;}
      const revision=head?streamManifestRevision(head):null,key=rawRef.slice(3);
      if(options.idle_before!==undefined){
        let ended=false;try{await storage.read('session-ends',key);ended=true;}catch(error){if(!missing(error))throw error;}
        if(!ended&&(!head||pending.length||head.chunks.some(chunk=>Date.parse(chunk.received_at)>options.idle_before!)))return null;
      }
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
  // A concurrent committed append advances the producer snapshot; retry selection outside the fence.
  if(sealed==='advanced')return finalizeSession(storage,streams,rawRef,endedBy,fold,options);
  if(!sealed)return null;
  let final=sealed.final;
  if(!final){
    const head=sealed.head!,end=sealed.end!;
    // The durable end seals the immutable revision. Folding its bytes does not own capture admission.
    const selected={manifest:head};
    // One deterministic byte axis for all audio tracks. Old descriptors and revisions retain their exact semantics.
    const ordered=selected.manifest.chunks.filter(c=>c.modality==='audio').sort((a,b)=>
      a.track_id.localeCompare(b.track_id)||a.stream_epoch.localeCompare(b.stream_epoch)||a.seq-b.seq);
    // Keep the designated final object compatible with the existing cold-pack bound.
    // Larger sessions retain the remaining immutable audio objects under their original names.
    let prefixCount=0,prefixBytes=0;
    for(const chunk of ordered){if(prefixCount&&(prefixBytes+chunk.bytes>8*1024*1024||prefixCount===2048))break;prefixCount++;prefixBytes+=chunk.bytes;}
    const prefix=ordered.slice(0,prefixCount);
    const payload=async function*(){for(const chunk of prefix){
      await checkpoint();
      const bytes=await streams.verifiedPcm(chunk);
      // Sources are individually bounded by capture admission, and are released after each write.
      yield bytes;
    }};
    const {object_hash:objectHash,bytes:audioBytes}=await storage.publishObjectStream!(payload(),async key=>{
      await requireRawAvailable(storage,rawRef);
      await storage.trackSessionRecords?.(rawRef,[{namespace:'objects',key}]);
    });
    const records:FinalSession['records']=[],overflow:{namespace:string;key:string}[]=[],keys=new Set<string>();let recordBytes=0;
    const include=async(namespace:string,key:string,required=false)=>{
      await checkpoint();
      const identity=`${namespace}:${key}`;if(keys.has(identity))return;
      let bytes:Uint8Array;try{bytes=await storage.read(namespace,key);}catch(error){if(!required&&missing(error))return;throw error;}
      keys.add(identity);const record={namespace,key,bytes:Buffer.from(bytes).toString('base64')},size=Buffer.byteLength(canonical(record));
      // Old readers cache only bounded final records. Overflow retains its original name in the existing owner ledger.
      if(recordBytes+size<=8*1024*1024){records.push(record);recordBytes+=size;}
      else overflow.push({namespace,key});
    };
    await include('session-ends',rawRef.slice(3),true);
    // Both immutable proof names and their sequence aliases must survive old pinned references.
    for(let n=1;n<=head.revision;n++){
      await include('stream-revisions',digest([rawRef,n]),true);
      if(head.schema==='paios.stream.v2')await include('stream-revisions',digest(head.journal![n-1]!),true);
    }
    for(const record of await storage.sessionRecords?.(rawRef)??[])if(record.namespace!=='objects')await include(record.namespace,record.key);
    await include('session-ends',rawRef.slice(3),true);
    let offset=0;const objects:FinalSession['objects']=[],mapped=new Set<string>();
    for(const chunk of prefix){
      if(chunk.object_hash!==objectHash&&!mapped.has(chunk.object_hash)){
        objects.push({key:chunk.object_hash,offset,bytes:chunk.bytes});mapped.add(chunk.object_hash);}
      offset+=chunk.bytes;
    }
    const retained=new Map<string,{key:string;format:string}>();
    for(const chunk of [...ordered.slice(prefixCount),...selected.manifest.chunks.filter(c=>c.modality!=='audio')])
      if(chunk.object_hash!==objectHash&&!mapped.has(chunk.object_hash))retained.set(chunk.object_hash,{key:chunk.object_hash,format:chunk.format});
    const call=await storage.callTrack?.(rawRef);
    check(!call||call.principal_id===head.event.principal_id,'CALL_TRACK_PRINCIPAL_CONFLICT',409);
    const candidate:FinalSession={schema:'paios.session.final.v1',raw_ref:rawRef,object_hash:objectHash,bytes:audioBytes,
      ended_by:end.ended_by,records,objects,...(call?{call}:{}),
      retained_objects:[...retained.values()].slice(0,16384)};
    await requireRawAvailable(storage,rawRef);
    await verifyFinal(storage,candidate,checkpoint);
    // Journal aliases predate inflight tracking. Register overflow in yieldable batches before publication.
    for(let offset=0;offset<overflow.length;offset+=64){
      await checkpoint();
      await fenced(async()=>{
        await requireRawAvailable(storage,rawRef);
        await storage.trackSessionRecords?.(rawRef,overflow.slice(offset,offset+64));
      });
    }
    await checkpoint();
    final=await fenced(async()=>{
      await requireRawAvailable(storage,rawRef);
      const committed=await storage.publishFinal!(candidate);
      check(canonical(committed)===canonical(candidate),'SESSION_FINAL_CONFLICT',409);return committed;
    });
  }
  // The SQLite commit is the visibility boundary. Every old key now resolves without its individual file.
  // Re-verify the replacement on resume before unlinking even the first original.
  if(sealed.final)await verifyFinal(storage,final,checkpoint);
  const committed=final;
  const removals=committed.records.map(({namespace,key})=>({namespace,key}));
  removals.push(...committed.objects.filter(c=>c.key!==committed.object_hash).map(c=>({namespace:'objects',key:c.key})));
  for(let offset=0;offset<removals.length;offset+=64){
    await checkpoint();
    await fenced(async()=>{
      await requireRawAvailable(storage,rawRef);
      const ingress=await pendingIngress(storage,rawRef),batch=[];
      for(const record of removals.slice(offset,offset+64))if(record.namespace!=='objects'||
        !ingress.objects.has(record.key)&&!await storage.hasLiveSessionOwner?.(record))batch.push(record);
      await storage.removeOriginals!(batch);
    });
  }
  return fenced(async()=>{await requireRawAvailable(storage,rawRef);await storage.completeFinal?.(rawRef);return committed;});
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
