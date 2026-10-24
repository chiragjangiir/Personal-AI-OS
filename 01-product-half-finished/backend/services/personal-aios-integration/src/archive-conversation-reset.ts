import {check,digest,type BoundEvent} from './contracts.ts';
import type {StoragePort} from './storage.ts';
import type {RawArchive} from './archive.ts';
import type {FinalSession,SessionRecordRef} from './session-records.ts';

export const CONVERSATION_RESET_CUTOFF='2026-10-18T10:14:00.000Z';
const conversationKinds=new Set(['voice_turn','call_closed','move_say']);
export function isConversationEvent(event:{media_type:string},payload?:unknown):boolean {
  if(['audio','text','muxed_av','livekit_tracks'].includes(event.media_type))return true;
  return event.media_type==='app_event'&&payload!==null&&typeof payload==='object'&&
    conversationKinds.has(String((payload as {kind?:unknown}).kind));
}
interface Target {raw_ref:string;principal_id:string}
export interface ArchiveConversationResetPlan {
  known_sources:string[];
  cutoff:string;targets:Target[];crossing_sources:string[];ambiguous_sources:string[];unknown_sources:number;pending_deletions:number;categories:Record<string,{deleted:{records:number;bytes:number};kept:{records:number;bytes:number}}>;selected_records:SessionRecordRef[];
  deleted:{records:number;bytes:number};kept:{records:number;bytes:number};
}
const parse=(bytes:Uint8Array)=>JSON.parse(Buffer.from(bytes).toString());
const identity=(ref:SessionRecordRef)=>`${ref.namespace}:${ref.key}`;
/** A source crossing the cutoff stays whole: immutable journal proofs cannot be partially rewritten. */
export async function planArchiveConversationReset(storage:StoragePort,cutoff=CONVERSATION_RESET_CUTOFF):Promise<ArchiveConversationResetPlan>{
  check(cutoff===CONVERSATION_RESET_CUTOFF,'RESET_CUTOFF_MISMATCH');const before=Date.parse(cutoff);
  const sources=new Map<string,{principal:string;eligible:boolean;old:boolean;newer:boolean;ambiguous:boolean;records:SessionRecordRef[];objects:Set<string>}>();
  const sizes=new Map<string,number>(),allObjects=new Set<string>();
  const intents=new Map<string,{principal_id:string;objects:string[]}>();
  for(const key of await storage.list('owner-deletions')){const intent=parse(await storage.read('owner-deletions',key));intents.set(intent.raw_ref??`l5:${key}`,intent);}

  const remember=async(ref:SessionRecordRef,bytes?:Uint8Array)=>{
    if(!sizes.has(identity(ref)))sizes.set(identity(ref),(bytes??await storage.read(ref.namespace,ref.key)).length);
  };
  for(const namespace of ['manifests','stream-revisions','quarantine-manifests','raw-ingress'])for(const key of await storage.list(namespace)){
    const bytes=await storage.read(namespace,key),m=parse(bytes);await remember({namespace,key},bytes);
    let event:BoundEvent,ref:string,object:string,seen:string;
    if(namespace==='raw-ingress'){
      const c=m.record;event={...c.raw,principal_id:c.trusted.principal_id,received_at:c.received_at};
      ref=c.kind==='original'?`l5:${digest({principal_id:event.principal_id,event_id:event.event_id})}`:
        c.kind==='unknown'?`l5-quarantine:${digest([event.principal_id,event.event_id,c.chunk.track_id,c.chunk.stream_epoch,c.chunk.seq])}`:
        `l5:${digest({event_id:event.event_id,principal_id:event.principal_id,device_id:event.device_id})}`;
      object=m.object_hash;seen=c.received_at;
    }else{event=m.event;ref=namespace==='manifests'?`l5:${key}`:m.raw_ref??m.quarantine_ref;
      object=namespace==='stream-revisions'?m.chunk?.object_hash:m.payload_sha256;seen=m.chunk?.received_at??event.received_at;}
    check(typeof ref==='string'&&typeof event.principal_id==='string','RESET_SOURCE_IDENTITY_INVALID');
    let payload:unknown;
    if(event.media_type==='app_event')payload=parse(await storage.read('objects',object));
    // received_at is server admission time; the device capture clock does not establish storage creation.
    const times=[event.received_at,seen];
    const eligible=isConversationEvent(event,payload)&&times.every(at=>typeof at==='string'&&Number.isFinite(Date.parse(at))&&Date.parse(at)<before);
    const source=sources.get(ref)??{principal:event.principal_id,eligible:true,old:false,newer:false,ambiguous:false,records:[],objects:new Set<string>()};
    check(source.principal===event.principal_id,'RESET_SOURCE_PRINCIPAL_CONFLICT');source.eligible&&=eligible||intents.has(ref);
    if(isConversationEvent(event,payload)&&!intents.has(ref)){source.ambiguous||=times.some(at=>typeof at!=='string'||!Number.isFinite(Date.parse(at)));source.old||=times.some(at=>Number.isFinite(Date.parse(at))&&Date.parse(at)<before);source.newer||=times.some(at=>Number.isFinite(Date.parse(at))&&Date.parse(at)>=before);}
    if(source.eligible)source.records.push({namespace,key});else source.records.length=0;
    for(const hash of [object,...(m.chunks??[]).map((c:{object_hash:string})=>c.object_hash)].filter(Boolean))source.objects.add(hash);
    sources.set(ref,source);
  }
  for(const key of await storage.list('session-finals')){
    const bytes=await storage.read('session-finals',key),final=parse(bytes) as FinalSession;let source=sources.get(final.raw_ref);
    check(source||intents.has(final.raw_ref),'RESET_FINAL_SOURCE_MISSING');if(!source){source={principal:intents.get(final.raw_ref)!.principal_id,eligible:true,old:false,newer:false,ambiguous:false,records:[],objects:new Set<string>()};sources.set(final.raw_ref,source);}if(source.eligible)source.records.push({namespace:'session-finals',key},{namespace:'session-ends',key},...final.records.map(({namespace,key})=>({namespace,key})));
    await remember({namespace:'session-finals',key},bytes);
    source.objects.add(final.object_hash);for(const object of final.retained_objects??[])source.objects.add(object.key);
  }
  const targets:Target[]=[],selected=new Map<string,SessionRecordRef>(),preserved=new Set<string>(),removed=new Set<string>();
  for(const [raw_ref,source] of sources){
    if(source.eligible){targets.push({raw_ref,principal_id:source.principal});
      for(const ref of [...source.records,...(raw_ref.startsWith('l5:')?await storage.sessionRecords?.(raw_ref)??[]:[])])selected.set(identity(ref),ref);
      for(const hash of source.objects)removed.add(hash);
    }else for(const hash of source.objects)preserved.add(hash);
  }
  for(const hash of preserved)removed.delete(hash);
  for(const key of await storage.list('objects'))allObjects.add(key);
  let pending_deletions=0;const targetRefs=new Set(targets.map(target=>target.raw_ref));
  for(const [raw_ref,intent] of intents){
    const orphan=intent.objects.filter(key=>allObjects.has(key)&&!preserved.has(key));
    if(!orphan.length&&!sources.has(raw_ref))continue;
    pending_deletions++;if(!targetRefs.has(raw_ref)){targets.push({raw_ref,principal_id:intent.principal_id});targetRefs.add(raw_ref);}
    for(const key of orphan)removed.add(key);
  }

  // Folded slices resolve from their container. Count the physical container once, not each route.
  const slices=new Set<string>();for(const key of await storage.list('session-finals')){
    const final=parse(await storage.read('session-finals',key)) as FinalSession;for(const object of final.objects)if(object.key!==final.object_hash)slices.add(object.key);
  }
  for(const key of allObjects)if(!slices.has(key))sizes.set(`objects:${key}`,
    storage.objectSize?await storage.objectSize('objects',key):(await storage.read('objects',key)).length);
  for(const key of removed)if(allObjects.has(key)&&!slices.has(key))selected.set(`objects:${key}`,{namespace:'objects',key});
  const deleted={records:0,bytes:0},kept={records:0,bytes:0};
  const categories:ArchiveConversationResetPlan['categories']={};
  for(const [key,size] of sizes){const remove=selected.has(key),bucket=remove?deleted:kept;bucket.records++;bucket.bytes+=size;
    const category=categories[key.slice(0,key.indexOf(':'))]??={deleted:{records:0,bytes:0},kept:{records:0,bytes:0}};
    const detail=remove?category.deleted:category.kept;detail.records++;detail.bytes+=size;}
  return {cutoff,known_sources:[...sources.keys()],categories,pending_deletions,unknown_sources:[...sources.values()].filter(s=>s.ambiguous).length,ambiguous_sources:[...sources].filter(([,s])=>s.ambiguous).map(([ref])=>ref),crossing_sources:[...sources].filter(([,s])=>s.old&&s.newer).map(([ref])=>ref),targets:targets.sort((a,b)=>a.raw_ref.localeCompare(b.raw_ref)),selected_records:[...selected.values()],deleted,kept};
}
export async function executeArchiveConversationReset(archive:RawArchive,plan:ArchiveConversationResetPlan):Promise<{deleted_sources:number}>{
  check(plan.cutoff===CONVERSATION_RESET_CUTOFF,'RESET_CUTOFF_MISMATCH');
  check(!plan.crossing_sources.length&&!plan.ambiguous_sources.length,'RESET_CROSSING_OR_AMBIGUOUS_SOURCES_REQUIRE_REVIEW');
  const principals=new Map<string,string[]>();for(const target of plan.targets){const refs=principals.get(target.principal_id)??[];refs.push(target.raw_ref);principals.set(target.principal_id,refs);}
  for(const [principal,refs] of principals)await archive.deleteMany(refs,principal);
  return {deleted_sources:plan.targets.length};
}
