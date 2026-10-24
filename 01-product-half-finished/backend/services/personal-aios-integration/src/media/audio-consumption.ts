import {publishRawRecord,withRawPublication} from '../stream-archive.ts';
import {randomUUID} from 'node:crypto';
import {canonical,ContractError,check,digest,sha256,type ArchivedEvent,type ProcessedEvent} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {MediaProcessResult} from './service.ts';
import {MediaCancelledWithoutEffectError,readReusedAudio,type MediaInputRecord,type WorkerRequest} from './processing.ts';
import {selectedAudioTimeline} from './sample-timeline.ts';
export class AudioConsumptionUnknownError extends ContractError {
  readonly consumer_state='unknown';readonly consumption_ref:string;readonly errors:unknown[];
  override readonly cause:unknown;
  constructor(key:string,errors:unknown[]){super('AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN',409);this.errors=errors;this.cause=errors[0];
    this.message=`AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN: ${String(errors[0])}`;this.consumption_ref=`audio-consumption:${key}`;}
}
export type AudioConsumer='media'|'voice'|'audit_only';
export type AudioLane='continuous'|'finite';
/** Issued by the authenticated acquisition owner, never decoded from operation JSON. */
export interface AudioRoute {
  consumer:AudioConsumer;source_scope:string;capture_span:string;purpose_evidence_ref:string;input_contract?:'frame_v1'|'interval_v2';
}
interface Route extends AudioRoute {schema:'paios.audio-consumer.v1'|'paios.audio-consumer.v2';raw_ref:string;principal_id:string;device_id:string;lane:AudioLane}
interface MediaOutcome {metadata:Omit<MediaProcessResult,'processed_events'>|null;pins:{key:string;id:string;sha256:string}[]}
interface Outcome<T> {key:string;result:T;processed_event_ids:string[]}
/** `wake_turn`: a wake turn re-analysing audio its speech candidates already consumed — a consumption of its own. */
export type AudioPurpose='wake_turn';
export interface AudioConsumptionOwner {
  consume<T>(event:ArchivedEvent,request:WorkerRequest,lane:AudioLane,run:(accept:()=>Promise<void>)=>Promise<T>,events:(result:T)=>ProcessedEvent[],
    consumer?:'media'|'voice',purpose?:AudioPurpose,recover?:()=>Promise<T|undefined>):Promise<T>;
}
/** One source consumer owner. Facts use the original StoragePort first-winner boundary.
 * There is no work queue or provider retry. Accepted without a final fact is unknown. */
export class AudioConsumption implements AudioConsumptionOwner {
  private readonly storage:StoragePort;private readonly metadataReadBudget:number;
  constructor(storage:StoragePort,metadataReadBudget:number){this.storage=storage;this.metadataReadBudget=metadataReadBudget;}
  private routeKey(event:ArchivedEvent){return digest([event.principal_id,event.device_id,event.raw_ref]);}
  private async read<T>(namespace:string,key:string):Promise<T|undefined> {
    let bytes:Uint8Array;
    try{bytes=await this.storage.read(namespace,key);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    return this.decode<T>(namespace,key,bytes);
  }
  private async publish<T>(namespace:string,key:string,value:T,rawRef?:string):Promise<T> {
    const bytes=Buffer.from(canonical(value));
    const saved=rawRef?await publishRawRecord(this.storage,rawRef,namespace,key,bytes):await this.storage.publish(namespace,key,bytes);
    return JSON.parse(Buffer.from(saved).toString()) as T;
  }
  async select(event:ArchivedEvent,lane:AudioLane,requested?:AudioRoute):Promise<Route> {
    check(event.archive_status==='durable'&&event.origin==='device_observation'&&event.user_identity==='unknown','AUDIO_SOURCE_REQUIRED',403);
    const fallback:AudioRoute={consumer:'media',source_scope:this.routeKey(event),capture_span:event.raw_ref,purpose_evidence_ref:event.consent_ref};
    event=structuredClone(event);requested=requested&&structuredClone(requested);
    if(requested?.input_contract==='frame_v1'){const {input_contract:_,...rest}=requested;requested=rest;}
    const selection=requested??fallback;
    check(selection.input_contract===undefined||['frame_v1','interval_v2'].includes(selection.input_contract),'AUDIO_INPUT_CONTRACT_INVALID');
    check(selection.input_contract!=='interval_v2'||lane==='continuous'&&selection.consumer==='media','AUDIO_INTERVAL_ROUTE_REQUIRED');
    check(['media','voice','audit_only'].includes(selection.consumer)&&
      [selection.source_scope,selection.capture_span,selection.purpose_evidence_ref].every(v=>typeof v==='string'&&v.length>0&&v.length<=512),
      'AUDIO_ROUTE_INVALID',403);
    const spanKey=digest([event.principal_id,event.device_id,selection.source_scope,selection.capture_span]);
    const span={...selection,lane};
    const spanWinner=await this.publish('audio-consumer-spans',spanKey,span,event.raw_ref);
    check(canonical(spanWinner)===canonical(span),'AUDIO_ROUTE_CONFLICT',409);
    const route:Route={...selection,schema:selection.input_contract==='interval_v2'?'paios.audio-consumer.v2':'paios.audio-consumer.v1',raw_ref:event.raw_ref,principal_id:event.principal_id,device_id:event.device_id,lane};
    // Explicit policy must match the first span decision. A finite caller cannot steal a continuous source.
    const saved=await this.publish('audio-consumer-routes',this.routeKey(event),route,event.raw_ref);
    check(saved.raw_ref===event.raw_ref&&saved.principal_id===event.principal_id&&saved.device_id===event.device_id&&
      (!requested||canonical(saved)===canonical(route)), 'AUDIO_ROUTE_CONFLICT',409);
    return saved;
  }
  private async route(event:ArchivedEvent):Promise<Route> {
    const route=await this.read<Route>('audio-consumer-routes',this.routeKey(event));
    check(route&&route.raw_ref===event.raw_ref&&route.principal_id===event.principal_id&&route.device_id===event.device_id,'AUDIO_ROUTE_REQUIRED',403);
    return route;
  }
  /** Read the source owner's durable choice without selecting a new consumer. */
  async existingRoute(event:ArchivedEvent):Promise<AudioRoute|undefined> {
    const saved=await this.read<Route>('audio-consumer-routes',this.routeKey(event));
    if(!saved)return undefined;
    check(saved.raw_ref===event.raw_ref&&saved.principal_id===event.principal_id&&saved.device_id===event.device_id,'AUDIO_ROUTE_REQUIRED',403);
    const {consumer,source_scope,capture_span,purpose_evidence_ref,input_contract}=saved;
    return {consumer,source_scope,capture_span,purpose_evidence_ref,...(input_contract?{input_contract}:{})};
  }
  async selected(event:ArchivedEvent){const {consumer,lane}=await this.route(event);return {consumer,lane};}
  async requireMedia(event:ArchivedEvent,lane:AudioLane) {
    const route=await this.route(event);
    check(route.consumer!=='voice','VOICE_CONSUMER_NOT_CONFIGURED',503);
    check(route.consumer==='media','AUDIO_AUDIT_ONLY',409);
    check(route.lane===lane,'AUDIO_CONSUMER_LANE_CONFLICT',409);
    return route;
  }
  async chunk<T>(event:ArchivedEvent,identity:unknown,payloadHash:string,run:(accept:()=>Promise<void>)=>Promise<T>):Promise<{status:'queued'|'duplicate';result?:T}> {
    const route=await this.requireMedia(event,'continuous');
    check(route.input_contract!=='interval_v2','AUDIO_FRAME_ROUTE_REQUIRED',409);
    const key=digest([route.source_scope,route.capture_span,event.principal_id,event.device_id,'chunk',identity]);
    const outcome=await this.execute(event,key,digest([identity,payloadHash]),'continuous',run,()=>[]);
    return {status:outcome.replayed?'duplicate':'queued',result:outcome.result};
  }
  async consume<T>(event:ArchivedEvent,request:WorkerRequest,lane:AudioLane,run:(accept:()=>Promise<void>)=>Promise<T>,events:(result:T)=>ProcessedEvent[],
    consumer:'media'|'voice'='media',purpose?:AudioPurpose,recover?:()=>Promise<T|undefined>):Promise<T> {
    const groups=selectedAudioTimeline(request);
    if(!groups.length)return run(async()=>{}); // Visual has its existing independent MEDIA authority.
    const route=consumer==='media'?await this.requireMedia(event,lane):await this.route(event);
    check(route.consumer===consumer&&route.lane===lane,'AUDIO_CONSUMER_ROUTE_CONFLICT',409);
    // Canonical source sample axes, not C/segment ids, archive revisions, provider ids or reconnects.
    const samples=groups.map(group=>{
      const first=group.views[0]!.pcm_selection!,last=group.views.at(-1)!.pcm_selection!;
      const start=first.selected_source_range;
      check(start.kind==='interval'&&last.selected_source_range.kind==='interval','AUDIO_SAMPLE_INTERVAL_REQUIRED');
      const begin=start.start_ms*group.sample_rate/1000,end=last.selected_source_range.end_ms*group.sample_rate/1000;
      check(Number.isSafeInteger(begin)&&Number.isSafeInteger(end)&&end-begin===group.total_samples,'AUDIO_EXACT_SAMPLE_AXIS_REQUIRED',409);
      return {range:{track_id:first.track_id,stream_epoch:first.stream_epoch,timebase_id:start.timebase_id,
        sample_rate:group.sample_rate,start_sample:begin,end_sample_exclusive:end},
        input:sha256(Buffer.concat(group.views.map(view=>Buffer.from(view.bytes))))};
    });
    samples.sort((a,b)=>{
      for(const field of ['track_id','stream_epoch','timebase_id'] as const){
        if(a.range[field]!==b.range[field])return a.range[field]<b.range[field]?-1:1;
      }
      return a.range.sample_rate-b.range.sample_rate||a.range.start_sample-b.range.start_sample||
        a.range.end_sample_exclusive-b.range.end_sample_exclusive;
    });
    const ranges=samples.map(sample=>sample.range),input=samples.map(sample=>sample.input);
    check(ranges.every((range,index)=>ranges.slice(index+1).every(other=>
      range.track_id!==other.track_id||range.stream_epoch!==other.stream_epoch||range.timebase_id!==other.timebase_id||
      range.end_sample_exclusive<=other.start_sample||other.end_sample_exclusive<=range.start_sample)),
      'AUDIO_SOURCE_SAMPLE_OVERLAP',409);
    const key=digest([route.source_scope,route.capture_span,event.principal_id,event.device_id,ranges,...(purpose?[purpose]:[])]);
    const fingerprint=digest([ranges,input]);
    const pin=(result:T)=>{const pins=events(result).map(d=>({key:digest([d.raw_ref,d.segment_id,d.revision]),id:d.processed_event_id,sha256:digest(d)}));
      let metadata:MediaOutcome['metadata']=null;
      if(lane==='finite'){const {processed_events:_,...rest}=result as unknown as MediaProcessResult;metadata=rest;}
      return {metadata,pins};};
    const receipt=await this.execute(event,key,fingerprint,lane,async accept=>pin(await run(accept)),result=>result.pins.map(pin=>pin.id),consumer,
      recover?async()=>{const result=await recover();return result===undefined?undefined:pin(result);}:undefined);
    const ds=await Promise.all(receipt.result.pins.map(async pin=>{
      const d=await this.read<ProcessedEvent>('processed-media',pin.key);
      check(d&&d.processed_event_id===pin.id&&digest(d)===pin.sha256,'AUDIO_FINAL_D_INTEGRITY',409);return d;
    }));
    return (lane==='continuous'?ds:{...receipt.result.metadata,processed_events:ds}) as T;
  }
  private async execute<T>(event:ArchivedEvent,key:string,fingerprint:string,lane:AudioLane,run:(accept:()=>Promise<void>)=>Promise<T>,events:(result:T)=>string[],consumer:'media'|'voice'='media',recover?:()=>Promise<T|undefined>):Promise<{result:T;replayed:boolean}> {
    const values=await this.executeClaims([{event,key,fingerprint}],lane,async(_fresh,accept)=>[await run(accept)],events,consumer,recover);
    return values[0]!;
  }
  private async decode<T>(namespace:string,key:string,bytes:Uint8Array):Promise<T>{
    const value=JSON.parse(Buffer.from(bytes).toString());
    if(value.schema!=='paios.audio-consumption.facts.v2')return value as T;
    check(bytes.length<=this.metadataReadBudget&&Array.isArray(value.records)&&value.records.length>0&&value.records.length<=64&&
      new Set(value.records.map((r:{key:string})=>r.key)).size===value.records.length,'AUDIO_FACT_BUNDLE_BUDGET',413);
    const blob=digest(value);check(sha256(bytes)===blob,'AUDIO_FACT_BUNDLE_INTEGRITY',409);
    let original:Uint8Array;try{original=await this.storage.read(namespace,blob);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ContractError('AUDIO_FACT_BUNDLE_INTEGRITY',409);throw error;}
    check(Buffer.from(original).equals(Buffer.from(bytes)),'AUDIO_FACT_BUNDLE_INTEGRITY',409);
    const record=value.records.find((r:{key:string})=>r.key===key);check(record&&value.common&&typeof value.common==='object'&&typeof value.key_from_slot==='boolean','AUDIO_FACT_SLOT_CONFLICT',409);
    return {...value.common,...record.value,...(value.key_from_slot?{key}: {})} as T;
  }
  private async facts<T>(namespace:string,values:{key:string;value:T}[],rawRef:string):Promise<T[]> {
    if(!values.length)return [];
    return withRawPublication(this.storage,rawRef,async()=>{
      await this.storage.trackSessionRecords?.(rawRef,values.map(({key})=>({namespace,key})));
      if(values.length===1||!this.storage.publishMany||!this.storage.stageAlias||!this.storage.flushNamespace)
        return Promise.all(values.map(async v=>this.decode<T>(namespace,v.key,await this.storage.publish(namespace,v.key,Buffer.from(canonical(v.value))))));
      const objects=values.map(v=>v.value as Record<string,unknown>),common:Record<string,unknown>={};
      for(const field of Object.keys(objects[0]!))if(objects.every(o=>Object.hasOwn(o,field)&&canonical(o[field])===canonical(objects[0]![field])))common[field]=objects[0]![field];
      const keyFromSlot=objects.every((o,n)=>o.key===values[n]!.key);
      const records=values.map((v,n)=>({key:v.key,value:Object.fromEntries(Object.entries(objects[n]!).filter(([field])=>!Object.hasOwn(common,field)&&!(keyFromSlot&&field==='key')))}));
      const bundle={schema:'paios.audio-consumption.facts.v2',common,key_from_slot:keyFromSlot,records},bytes=Buffer.from(canonical(bundle)),blob=digest(bundle);
      check(bytes.length<=this.metadataReadBudget&&bytes.length<=1048576,'AUDIO_FACT_BUNDLE_BUDGET',413);
      // This owner's existing per-frame claim slots remain the only authority. A blob alone is not a claim.
      await this.storage.trackSessionRecords?.(rawRef,[{namespace,key:blob}]);
      await this.storage.publishMany(namespace,[{key:blob,bytes}]);
      const winners:T[]=[];
      for(const v of values){const staged=await this.storage.stageAlias(namespace,blob,v.key);
        // Our just-published content already passed the original SHA publisher proof. Peer winners use the cold proof reader.
        winners.push(Buffer.from(staged.winner).equals(bytes)?structuredClone(v.value):await this.decode<T>(namespace,v.key,staged.winner));}
      await this.storage.flushNamespace(namespace);return winners;
    });
  }
  /** Same canonical per-frame claims survive changing batch boundaries. No interval claim index. */
  async interval<T>(entries:{event:ArchivedEvent;identity:unknown;payloadHash:string}[],run:(fresh:number[],accept:()=>Promise<void>)=>Promise<T[]>):Promise<{result:T;replayed:boolean}[]> {
    check(entries.length>0&&entries.length<=64,'AUDIO_INTERVAL_BUDGET');entries=structuredClone(entries);
    const route=await this.requireMedia(entries[0]!.event,'continuous');
    check(route.input_contract==='interval_v2','AUDIO_INTERVAL_ROUTE_REQUIRED');
    const claims=entries.map(({event,identity,payloadHash})=>{
      check(event.raw_ref===route.raw_ref&&event.principal_id===route.principal_id&&event.device_id===route.device_id,'AUDIO_INTERVAL_SOURCE_CONFLICT',403);
      return {event,key:digest([route.source_scope,route.capture_span,event.principal_id,event.device_id,'chunk',identity]),fingerprint:digest([identity,payloadHash])};
    });
    return this.executeClaims(claims,'continuous',run,()=>[]);
  }
  private async executeClaims<T>(claims:{event:ArchivedEvent;key:string;fingerprint:string}[],lane:AudioLane,
    run:(fresh:number[],accept:()=>Promise<void>)=>Promise<T[]>,events:(result:T)=>string[],consumer:'media'|'voice'='media',recover?:()=>Promise<T|undefined>):Promise<{result:T;replayed:boolean}[]> {
    claims=structuredClone(claims);
    check(claims.length>0&&claims.length<=64&&new Set(claims.map(c=>c.key)).size===claims.length,'AUDIO_CLAIM_BATCH_BUDGET');
    const owner=randomUUID(),owned:{index:number;attemptKey:string}[]=[],outcomes:({result:T;replayed:boolean}|undefined)[]=claims.map(()=>undefined);
    const attempts=claims.map(c=>({schema:'paios.audio-consumption.v1',key:c.key,fingerprint:c.fingerprint,consumer,lane,
      raw_ref:c.event.raw_ref,archive_revision:c.event.archive_revision,owner,state:'selected'}));
    let remaining=this.metadataReadBudget,accepted=false,acceptance:Promise<void>|undefined;
    const account=(value:unknown)=>{remaining-=Buffer.byteLength(canonical(value));check(remaining>=0,'AUDIO_RECONCILE_METADATA_BUDGET',413);};
    const same=(saved:typeof attempts[number],index:number)=>check(saved.fingerprint===attempts[index]!.fingerprint&&saved.consumer===consumer&&saved.lane===lane,'AUDIO_CONSUMPTION_CONFLICT',409);
    const complete=async(index:number)=>{
      const c=claims[index]!;let saved=await this.read<Outcome<T>>('audio-consumer-results',c.key);
      const first=await this.read<typeof attempts[number]>('audio-consumer-attempts',c.key);
      if(!saved&&recover&&first){
        same(first,index);const result=await recover();
        if(result!==undefined){const value={key:c.key,result,processed_event_ids:events(result)};
          [saved]=await this.facts('audio-consumer-results',[{key:c.key,value}],c.event.raw_ref);
          check(canonical(saved)===canonical(value),'AUDIO_RESULT_CONFLICT',409);}
      }
      if(!saved)return false;
      check(first,'AUDIO_CONSUMPTION_CONFLICT',409);same(first,index);
      await this.bindEvents(c.key,saved.processed_event_ids,c.event.raw_ref);outcomes[index]={result:saved.result,replayed:true};return true;
    };
    const rejectOwned=async(error:unknown,state:string)=>{
      await this.facts('audio-consumer-not-accepted',owned.map(c=>({key:c.attemptKey,value:{owner,state,error:error instanceof Error?error.message:'CONSUMER_REJECTED'}})),claims[0]!.event.raw_ref);
    };
    let fresh:number[]=[],confirmedFinalFailure=false,uncertain:{index:number;attemptKey:string}[]=[];
    const failureKey=claims.length===1?claims[0]!.key:digest(claims.map(c=>c.key));
    try {
      let pending:{index:number;attemptKey:string}[]=[];
      for(let index=0;index<claims.length;index++)if(!await complete(index))pending.push({index,attemptKey:claims[index]!.key});
      while(pending.length){
        uncertain=pending;
        const winners=await this.facts('audio-consumer-attempts',pending.map(c=>({key:c.attemptKey,value:attempts[c.index]!})),claims[0]!.event.raw_ref),next:typeof pending=[];
        // Record every owned winner before a conflicting peer can abort this round.
        for(let n=0;n<pending.length;n++)if(winners[n]!.owner===owner)owned.push(pending[n]!);
        uncertain=[];
        for(let n=0;n<pending.length;n++){
          const c=pending[n]!,winner=winners[n]!;account(winner);same(winner,c.index);
          if(winner.owner===owner)continue;
          if(await complete(c.index))continue;
          const rejected=await this.read<{owner:string;state:string}>('audio-consumer-not-accepted',c.attemptKey);
          check(rejected?.owner===winner.owner&&['failed_before_acceptance','cancelled_without_effect'].includes(rejected.state),'AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN',409);
          account(rejected);next.push({index:c.index,attemptKey:digest([c.attemptKey,winner.owner])});
        }
        pending=next;
      }
      fresh=owned.map(c=>c.index);
      if(!fresh.length)return outcomes as {result:T;replayed:boolean}[];
      const accept=()=>acceptance??=(async()=>{
        const expected=owned.map(c=>({key:c.attemptKey,value:{key:claims[c.index]!.key,owner,state:'accepted'}}));
        const winners=await this.facts('audio-consumer-accepted',expected,claims[0]!.event.raw_ref);
        check(winners.every((w,n)=>canonical(w)===canonical(expected[n]!.value)),'AUDIO_ACCEPTANCE_CONFLICT',409);accepted=true;
      })();
      const values=await run(fresh,accept);check(values.length===fresh.length,'AUDIO_INTERVAL_RESULT_COUNT');
      const expected=owned.map((c,n)=>({key:claims[c.index]!.key,value:{key:claims[c.index]!.key,result:values[n]!,processed_event_ids:events(values[n]!)}}));
      let winners:Outcome<T>[];
      try{winners=await this.facts('audio-consumer-results',expected,claims[0]!.event.raw_ref);}
      catch(publicationError){
        let confirmed:(Outcome<T>|undefined)[];
        try{confirmed=await Promise.all(expected.map(e=>this.read<Outcome<T>>('audio-consumer-results',e.key)));}
        catch(readError){throw new AudioConsumptionUnknownError(failureKey,[publicationError,readError]);}
        if(confirmed.some((value,n)=>!value||canonical(value)!==canonical(expected[n]!.value)))throw new AudioConsumptionUnknownError(failureKey,[publicationError]);
        confirmedFinalFailure=true;throw publicationError;
      }
      for(let n=0;n<owned.length;n++){
        check(canonical(winners[n])===canonical(expected[n]!.value),'AUDIO_RESULT_CONFLICT',409);
        const c=owned[n]!;await this.bindEvents(claims[c.index]!.key,winners[n]!.processed_event_ids,claims[c.index]!.event.raw_ref);outcomes[c.index]={result:winners[n]!.result,replayed:false};
      }
      return outcomes as {result:T;replayed:boolean}[];
    } catch(error){
      if(confirmedFinalFailure||error instanceof AudioConsumptionUnknownError)throw error;
      const cancelled=claims.length===1&&consumer==='media'&&lane==='continuous'&&error instanceof MediaCancelledWithoutEffectError;
      if(!accepted&&!acceptance||cancelled){
        try{
          for(const c of uncertain){const winner=await this.read<typeof attempts[number]>('audio-consumer-attempts',c.attemptKey);if(winner?.owner===owner&&!owned.some(o=>o.attemptKey===c.attemptKey))owned.push(c);}
          await rejectOwned(error,cancelled?'cancelled_without_effect':'failed_before_acceptance');}
        catch(publicationError){throw new AudioConsumptionUnknownError(failureKey,[error,publicationError]);}
      }
      if((accepted||acceptance)&&!cancelled)throw new AudioConsumptionUnknownError(failureKey,[error]);
      throw error;
    }
  }
  private async bindEvents(key:string,ids:string[],rawRef:string) {
    for(const processed_event_id of ids) {
      const saved=await this.publish('audio-consumer-d',digest(processed_event_id),{key,processed_event_id},rawRef);
      check(saved.key===key&&saved.processed_event_id===processed_event_id,'AUDIO_D_CONSUMPTION_CONFLICT',409);
    }
  }
  async authorizeD(d:ProcessedEvent):Promise<void> {
    if(!['audio','livekit_tracks','muxed_av'].includes(d.media_type))return;
    const input=await this.read<{selected_views?:{modality:string}[]}>('processed-media-inputs',digest([d.raw_ref,d.segment_id,d.revision]));
    if(input?.selected_views?.length&&input.selected_views.every(view=>view.modality==='visual'))return;
    const original=await this.read<ProcessedEvent>('processed-media',digest([d.raw_ref,d.segment_id,d.revision]));
    check(original&&digest(original)===digest(d),'AUDIO_FINAL_D_INTEGRITY',403);
    if(d.processing.reused_audio){
      const input=await this.read<MediaInputRecord>('processed-media-inputs',digest([d.raw_ref,d.segment_id,d.revision]));
      check(input?.selected_views&&canonical(input.reused_audio)===canonical(d.processing.reused_audio),'AUDIO_REUSE_INPUT_REQUIRED',403);
      const audio=await readReusedAudio(this.storage,d.processing.reused_audio,d,input.selected_views!);
      return this.authorizeD(audio);
    }
    const record=await this.read<{key:string;processed_event_id:string}>('audio-consumer-d',digest(d.processed_event_id));
    check(record&&record.processed_event_id===d.processed_event_id,'AUDIO_D_CONSUMPTION_REQUIRED',403);
    const outcome=await this.read<Outcome<MediaOutcome>>('audio-consumer-results',record.key);
    check(outcome?.processed_event_ids.includes(d.processed_event_id)&&outcome.result.pins.some(pin=>
      pin.id===d.processed_event_id&&pin.sha256===digest(d)&&pin.key===digest([d.raw_ref,d.segment_id,d.revision])),
      'AUDIO_D_CONSUMPTION_REQUIRED',403);
  }
}
