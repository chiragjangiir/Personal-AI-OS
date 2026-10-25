import {canonical,check,digest,sha256} from './contracts.ts';
import {withRawPublication} from './stream-archive.ts';
import type {StoragePort} from './storage.ts';
import type {SessionRecordRef} from './session-records.ts';

type Value=Record<string,any>;
type Fact={value:Value;refs:SessionRecordRef[]};
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
/** Adopt only producer-defined stream edges. No recursive ownership propagation or finite derivation ownership. */
export async function discoverSessionRecords(storage:StoragePort,checkpoint:()=>Promise<void>,
  onProgress?:(state:{scanned:number;adopted:number;unresolved:number})=>void){
  check(storage.hotKeys&&storage.trackSessionRecords&&storage.hasSessionRecord,'SESSION_DISCOVERY_STORAGE_REQUIRED',503);
  const state={scanned:0,adopted:0,unresolved:0},owners=new Map<string,boolean>(),epochs=new Map<string,string>();
  const read=async(namespace:string,key:string):Promise<{value:Value;bytes:Uint8Array}|undefined>=>{
    await checkpoint();let bytes:Uint8Array;
    try{bytes=await storage.read(namespace,key);}catch(error){if(missing(error))return;throw error;}
    const value=JSON.parse(Buffer.from(bytes).toString());check(value&&typeof value==='object'&&!Array.isArray(value),'SESSION_DISCOVERY_METADATA_INVALID');
    return {value,bytes};
  };
  const owner=async(ref:string)=>{
    check(typeof ref==='string'&&/^l5:[a-f0-9]{64}$/u.test(ref),'SESSION_DISCOVERY_OWNER_INVALID');
    if(owners.has(ref))return owners.get(ref)!;
    const first=await read('stream-revisions',digest([ref,1]));
    if(first)check(first.value.raw_ref===ref&&first.value.revision===1&&['paios.stream.delta.v2','paios.stream.v1'].includes(first.value.schema),'SESSION_DISCOVERY_OWNER_CONFLICT',409);
    owners.set(ref,!!first);return !!first;
  };
  const fact=async(namespace:string,key:string):Promise<Fact|undefined>=>{
    const saved=await read(namespace,key);if(!saved)return;
    const {value,bytes}=saved,refs=[{namespace,key}];
    if(value.schema!=='paios.audio-consumption.facts.v2')return {value,refs};
    check(Array.isArray(value.records)&&value.records.length>0&&value.records.length<=64&&
      new Set(value.records.map((r:Value)=>r.key)).size===value.records.length&&value.common&&typeof value.common==='object'&&typeof value.key_from_slot==='boolean','SESSION_DISCOVERY_FACT_INVALID');
    const blob=digest(value),original=await read(namespace,blob),entry=value.records.find((r:Value)=>r.key===key);
    check(sha256(bytes)===blob&&original&&Buffer.from(original.bytes).equals(Buffer.from(bytes)),'SESSION_DISCOVERY_FACT_INTEGRITY',409);
    if(!entry){check(key===blob,'SESSION_DISCOVERY_FACT_SLOT_CONFLICT',409);return;}
    refs.push({namespace,key:blob});return {value:{...value.common,...entry.value,...(value.key_from_slot?{key}:{})},refs};
  };
  const roots=['stream-revisions','audio-consumer-attempts','audio-consumer-routes','media-detection-epochs',
    'media-continuous-candidates','media-continuous-attempts','media-views','media-vad-selections',
    'media-postarchive-admissions','media-source-progress','media-source-failures','processed-media','processed-media-inputs','voice-transcripts'];
  for(const namespace of roots)for await(const key of storage.hotKeys!(namespace)){
    await checkpoint();state.scanned++;const root={namespace,key};
    try{
      if(!['stream-revisions','audio-consumer-attempts','audio-consumer-routes','media-detection-epochs',
        'media-continuous-candidates','processed-media'].includes(namespace)&&await storage.hasSessionRecord!(root))continue;
      const saved=await read(namespace,key);if(!saved)continue;
      const v=saved.value,children:SessionRecordRef[]=[];let ref=v.raw_ref;
      if(ref)await withRawPublication(storage,ref,async()=>{});
      const add=async(ns:string,k:string,valid?:(value:Value)=>boolean)=>{
        const child=await read(ns,k);if(!child)return;
        check(!valid||valid(child.value),'SESSION_DISCOVERY_CHILD_CONFLICT',409);children.push({namespace:ns,key:k});return child.value;
      };
      if(namespace==='stream-revisions'){
        check(typeof ref==='string'&&Number.isSafeInteger(v.revision)&&v.revision>0&&['paios.stream.delta.v2','paios.stream.v1'].includes(v.schema),'SESSION_DISCOVERY_STREAM_INVALID');
        const alias=digest([ref,v.revision]),committed=await read(namespace,alias);
        check(key===alias||key===digest(v),'SESSION_DISCOVERY_STREAM_KEY_INVALID');
        if(!committed||!Buffer.from(committed.bytes).equals(Buffer.from(saved.bytes))){state.unresolved++;continue;}
        children.push({namespace,key:alias});if(v.schema==='paios.stream.delta.v2')children.push({namespace,key:digest(v)});
        for(const chunk of v.chunk?[v.chunk]:v.chunks){children.push({namespace:'objects',key:chunk.object_hash});}
      }else if(namespace==='audio-consumer-attempts'){
        const entries=v.schema==='paios.audio-consumption.facts.v2'?(key===digest(v)?v.records.map((r:Value)=>r.key):[key]):[key];
        check(Array.isArray(entries)&&entries.length<=64,'SESSION_DISCOVERY_FACT_INVALID');let resolved=0;
        for(const slot of entries){
          if(v.schema==='paios.audio-consumption.facts.v2'){const winner=await read(namespace,slot);
            if(!winner||!Buffer.from(winner.bytes).equals(Buffer.from(saved.bytes)))continue;}
          const attempt=await fact(namespace,slot);if(!attempt)continue;
          const a=attempt.value;check(typeof a.raw_ref==='string'&&typeof a.key==='string'&&typeof a.owner==='string'&&a.schema==='paios.audio-consumption.v1','SESSION_DISCOVERY_ATTEMPT_INVALID');
          if(ref)check(ref===a.raw_ref,'SESSION_DISCOVERY_OWNER_CONFLICT',409);ref=a.raw_ref;
          await withRawPublication(storage,ref,async()=>{});resolved++;children.push(...attempt.refs);
          for(const ns of ['audio-consumer-accepted','audio-consumer-not-accepted']){
            const child=await fact(ns,slot);if(!child)continue;
            check(child.value.owner===a.owner&&(!child.value.key||child.value.key===a.key),'SESSION_DISCOVERY_ATTEMPT_CONFLICT',409);children.push(...child.refs);
          }
          const result=await fact('audio-consumer-results',a.key);if(!result)continue;
          check(result.value.key===a.key&&Array.isArray(result.value.processed_event_ids),'SESSION_DISCOVERY_RESULT_CONFLICT',409);children.push(...result.refs);
          for(const id of result.value.processed_event_ids)await add('audio-consumer-d',digest(id),d=>d.key===a.key&&d.processed_event_id===id);
        }
        if(!resolved){if(!await storage.hasSessionRecord!(root))state.unresolved++;continue;}
      }else if(namespace==='audio-consumer-routes'){
        check(key===digest([v.principal_id,v.device_id,ref]),'SESSION_DISCOVERY_ROUTE_CONFLICT',409);
        const {schema:_schema,raw_ref:_ref,principal_id:_principal,device_id:_device,...span}=v;
        await add('audio-consumer-spans',digest([v.principal_id,v.device_id,v.source_scope,v.capture_span]),s=>equal(s,span));
      }else if(namespace==='media-detection-epochs'){
        const stream=digest([ref,v.track_id,v.stream_epoch]);check(key===digest([stream,v.detection_epoch]),'SESSION_DISCOVERY_EPOCH_CONFLICT',409);
        check(!epochs.has(v.detection_epoch)||epochs.get(v.detection_epoch)===stream,'SESSION_DISCOVERY_EPOCH_CONFLICT',409);epochs.set(v.detection_epoch,stream);await add('media-detection-finished',key,f=>f.detection_epoch===v.detection_epoch);
      }else if(namespace==='media-continuous-candidates'){
        check(digest(v)===key&&v.authority==='central_media_c_owner','SESSION_DISCOVERY_CANDIDATE_CONFLICT',409);ref=v.event.raw_ref;await withRawPublication(storage,ref,async()=>{});
        for(const ns of ['media-continuous-admitted','media-continuous-dispositions','media-continuous-selection'])
          await add(ns,key,c=>c.candidate_ref===`l5-continuous:${key}`);
      }else if(namespace==='media-continuous-attempts'){
        const candidateKey=/^l5-continuous:([a-f0-9]{64})$/u.exec(v.candidate_ref)?.[1];check(candidateKey,'SESSION_DISCOVERY_CANDIDATE_REF');
        const candidate=await read('media-continuous-candidates',candidateKey!);
        if(!candidate){state.unresolved++;continue;}
        check(digest(candidate.value)===candidateKey&&candidate.value.authority==='central_media_c_owner','SESSION_DISCOVERY_CANDIDATE_CONFLICT',409);ref=candidate.value.event.raw_ref;
      }else if(namespace==='media-vad-selections'){
        check(digest(v)===key,'SESSION_DISCOVERY_VAD_CONFLICT',409);ref=v.input.raw_ref;
      }else if(namespace==='media-views'){
        check(digest(v)===key,'SESSION_DISCOVERY_VIEW_CONFLICT',409);
      }else if(namespace==='media-postarchive-admissions'){
        check(v.schema==='paios.media.postarchive-admission.interval.v2'?key===digest(v):
          v.schema==='paios.media.postarchive-admission.v1'&&key===digest([ref,v.archive_revision,v.track_id,v.stream_epoch,v.seq,v.processing_admission]),'SESSION_DISCOVERY_POSTARCHIVE_CONFLICT',409);
      }else if(namespace==='voice-transcripts'){
        check(v.candidate_ref===`voice-candidate:${key}`,'SESSION_DISCOVERY_TRANSCRIPT_CONFLICT',409);
      }else if(namespace==='processed-media'){
        check(key===digest([ref,v.segment_id,v.revision]),'SESSION_DISCOVERY_PROCESSED_CONFLICT',409);await add('processed-media-inputs',key);
      }else if(namespace==='processed-media-inputs'){
        const processed=await read('processed-media',key);
        if(processed){ref=processed.value.raw_ref;check(key===digest([ref,processed.value.segment_id,processed.value.revision]),'SESSION_DISCOVERY_PROCESSED_CONFLICT',409);}
        else if(v.view_sha256){const view=await read('media-views',v.view_sha256);
          if(view){check(digest(view.value)===v.view_sha256,'SESSION_DISCOVERY_VIEW_CONFLICT',409);ref=view.value.raw_ref;}}
        if(!ref){state.unresolved++;continue;}
      }else if(namespace==='media-source-progress'&&v.schema==='paios.media.source-progress.interval.v2'){
        check(Array.isArray(v.frames)&&v.frames.length<=64,'SESSION_DISCOVERY_PROGRESS_INVALID');
        for(const frame of v.frames){check(frame.raw_ref===ref,'SESSION_DISCOVERY_OWNER_CONFLICT',409);const stream=epochs.get(frame.detection_epoch);
          if(!stream){state.unresolved++;continue;}
          const alias=digest([stream,frame.seq]),winner=await read(namespace,alias);
          if(winner&&Buffer.from(winner.bytes).equals(Buffer.from(saved.bytes)))children.push({namespace,key:alias});}
      }
      if(!ref){state.unresolved++;continue;}
      if(!await owner(ref)){state.unresolved++;continue;}
      // Children precede the root: an interrupted scan must not mark an incomplete legacy graph as adopted.
      const refs=children.filter(r=>r.namespace!==namespace||r.key!==key);
      for(let offset=0;offset<refs.length;offset+=64){await checkpoint();await withRawPublication(storage,ref,()=>storage.trackSessionRecords!(ref,refs.slice(offset,offset+64)));}
      if(!await storage.hasSessionRecord!(root)){await checkpoint();await withRawPublication(storage,ref,()=>storage.trackSessionRecords!(ref,[root]));state.adopted++;}
    }catch(error){if((error as {code?:string}).code!=='RAW_DELETED')throw error;}
    finally{onProgress?.({...state});}
  }
  // Leaves without a proved parent remain untouched and visible in discovery diagnostics.
  for(const namespace of ['audio-consumer-spans','audio-consumer-accepted','audio-consumer-not-accepted','audio-consumer-results',
    'audio-consumer-d','media-detection-finished','media-continuous-admitted','media-continuous-dispositions','media-continuous-selection'])
    for await(const key of storage.hotKeys!(namespace)){
      await checkpoint();state.scanned++;if(!await storage.hasSessionRecord!({namespace,key}))state.unresolved++;
      onProgress?.({...state});
    }
  return state;
}
