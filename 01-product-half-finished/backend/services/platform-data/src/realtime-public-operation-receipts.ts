import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { claimIdempotency, completeIdempotency, completeFailed, completeIndeterminate, restartFailedIdempotency, takeOverInFlightClaim, jsonHash, readIdempotency, type IdempotencyRecord, type IdempotencyClaimOwner } from './idempotency-ledger.ts';
import { withTransaction } from './transaction.ts';
type JsonRecord = Record<string, unknown>;
type Input = { readonly request: JsonRecord; readonly bearer: { readonly principal: unknown; readonly deviceId: string } };
/** not_executed_v1: only a proven not-executed failure may run again.
 * idempotent_effect_v1: the operation's own effect authority owns exactly-once (media stop: the external-effect
 * coordinator replays a commit, refuses a live attempt and takes over a dead one), so a failed or unknown outcome is
 * re-run under that authority instead of being replayed forever. */
type RetryPolicy = 'not_executed_v1' | 'idempotent_effect_v1';
export interface RealtimePublicOperationReceipts {
  execute(input: Input, fresh: (effectStarted: () => void) => Promise<JsonRecord>, authorize?: () => Promise<void>, boundary?: 'v1', retry?: RetryPolicy): Promise<JsonRecord>;
  read(input: Input): Promise<IdempotencyRecord | undefined>;
}
function keyFor({request,bearer}:Input) {
  if (!['bootstrap','media_stop','end_continuity','handoff'].includes(String(request.operation)) || !bearer || bearer.principal===undefined || !bearer.deviceId) throw new TypeError('PUBLIC_OPERATION_RECEIPT_OWNER_INVALID');
  const context=request.idempotency_context as JsonRecord|undefined;
  if (!context || typeof context.idempotency_key!=='string') throw new TypeError('PUBLIC_OPERATION_RECEIPT_KEY_INVALID');
  return {scope:`realtime.public.complete.${request.operation}`,idempotencyKey:context.idempotency_key,requestHash:jsonHash({request,identity:{principal:bearer.principal,device_id:bearer.deviceId}})};
}
function replay(record:IdempotencyRecord,cause?:unknown):JsonRecord {
  if(record.status==='committed'){const value=record.response as JsonRecord;return value?.schema==='paios.public-operation.result.v2'?value.result as JsonRecord:value;}
  const saved=record.response as {schema?:string;outcome?:string;error?:{code:string;status:number;message:string;terminalResult?:unknown}}|undefined;
  if((record.status==='failed'||record.status==='indeterminate')&&saved?.schema==='paios.public-operation.failure.v1'&&saved.error) {
    throw Object.assign(new Error(saved.error.message,cause===undefined?undefined:{cause}),{code:saved.error.code,status:saved.error.status,operation_outcome:saved.outcome,receipt:record,...(saved.error.terminalResult===undefined?{}:{terminalResult:saved.error.terminalResult})});
  }
  throw Object.assign(new Error('PUBLIC_OPERATION_RECEIPT_IN_FLIGHT'),{code:'PUBLIC_OPERATION_RECEIPT_IN_FLIGHT',status:409});
}
/** Longest any live attempt holds its claim (bounded RTC connect / PG transactions; the media-stop coordinator uses the
 * same window for its own stalled attempts). An older in-flight claim belongs to a dead process. */
const STALE_CLAIM_SECONDS=120;
/** The original ledger owns results. Only an explicit host source boundary can prove no effect, unless the caller
 * declares an idempotent operation whose inner effect authority decides every re-run. Every claim is fenced to the
 * attempt that holds it, so an attempt that died (process restart, lost receipt write) is recovered instead of
 * answering IN_FLIGHT forever. */
export function createRealtimePublicOperationReceipts(pool:Pool,options:{readonly staleClaimSeconds?:number}={}):RealtimePublicOperationReceipts {
  const owner=`realtime.public.receipts:${randomUUID()}`,staleSeconds=options.staleClaimSeconds??STALE_CLAIM_SECONDS;
  // Keys this process is executing now, and results whose receipt write did not land (finished on the next retry).
  type Terminal={readonly status:'committed'|'failed'|'indeterminate';readonly receipt:JsonRecord;readonly tokenSha256:string};
  const live=new Set<string>(),unsaved=new Map<string,Terminal>();
  const read=(key:ReturnType<typeof keyFor>)=>withTransaction(pool,c=>readIdempotency(c,key),{readOnly:true});
  const complete={committed:completeIdempotency,failed:completeFailed,indeterminate:completeIndeterminate};
  const keep=(id:string,terminal:Terminal)=>{unsaved.delete(id);if(unsaved.size>=64)unsaved.delete(unsaved.keys().next().value!);unsaved.set(id,terminal);};
  return Object.freeze({
    async read(input:Input){return read(keyFor(input));},
    async execute(input:Input,fresh:(effectStarted:()=>void)=>Promise<JsonRecord>,authorize?:()=>Promise<void>,boundary?:'v1',retry?:RetryPolicy) {
      // Bind canonical wire and original authenticated identity before any await.
      const key=keyFor(input),id=`${key.scope}\u0000${key.idempotencyKey}`;
      if(live.has(id))throw Object.assign(new Error('PUBLIC_OPERATION_RECEIPT_IN_FLIGHT'),{code:'PUBLIC_OPERATION_RECEIPT_IN_FLIGHT',status:409});
      const token=randomUUID(),claim:IdempotencyClaimOwner={tokenSha256:createHash('sha256').update(token).digest('hex'),owner};
      live.add(id);
      try {
      const known=unsaved.get(id);
      if(known!==undefined) {
        // This process knows the outcome; only its receipt is missing. Persist that terminal, never re-run the operation.
        let stored:IdempotencyRecord|undefined;
        try {stored=await withTransaction(pool,c=>complete[known.status](c,key,known.receipt,jsonHash(known.receipt),known.tokenSha256));}
        catch(persistenceError) {
          stored=await read(key).catch(()=>undefined);
          if(stored===undefined||stored.status==='in_flight')throw Object.assign(new Error('PUBLIC_OPERATION_RECEIPT_UNSAVED',{cause:persistenceError}),{code:'PUBLIC_OPERATION_RECEIPT_UNSAVED',status:503});
        }
        unsaved.delete(id);return replay(stored);
      }
      const existing=await read(key);
      let previous:JsonRecord[]=[],recovered=false;
      if(existing?.status==='in_flight') {
        // Nothing in this process runs it (checked above): recover it once it is ours or stale; otherwise it is live.
        // Recovery re-runs the operation, so it needs the caller's current authorization like any retry.
        if(typeof authorize!=='function')return replay(existing);
        await authorize();
        if(!await withTransaction(pool,c=>takeOverInFlightClaim(c,key,claim,staleSeconds)))return replay((await read(key))??existing);
        recovered=true;
      } else if(existing!==undefined&&retry==='idempotent_effect_v1'&&(existing.status==='failed'||existing.status==='indeterminate')&&
          (existing.response as JsonRecord|undefined)?.schema==='paios.public-operation.failure.v1') {
        if(typeof authorize!=='function')throw new TypeError('PUBLIC_OPERATION_RETRY_AUTHORIZATION_REQUIRED');
        await authorize();
        const restarted=await withTransaction(pool,c=>restartFailedIdempotency(c,key,existing.responseHash!,existing.status as 'failed'|'indeterminate',claim));
        if(!restarted){const winner=await withTransaction(pool,c=>readIdempotency(c,key),{readOnly:true});if(!winner)throw new Error('PUBLIC_OPERATION_RECEIPT_MISSING');return replay(winner);}
      } else if(existing!==undefined) {
        const saved=existing.response as JsonRecord|undefined;
        if(existing.status!=='failed'||saved?.schema!=='paios.public-operation.failure.v1'||saved.outcome!=='not_executed'||saved.proof!=='host_effect_boundary_v1'||boundary!=='v1'||retry!=='not_executed_v1')return replay(existing);
        previous=[...((saved.prior_not_executed??[]) as JsonRecord[]),{error:saved.error,proof:saved.proof,response_hash:existing.responseHash}];
        if(previous.length>8)throw Object.assign(new Error('PUBLIC_OPERATION_RETRY_BUDGET'),{code:'PUBLIC_OPERATION_RETRY_BUDGET',status:429});
        if(typeof authorize!=='function')throw new TypeError('PUBLIC_OPERATION_RETRY_AUTHORIZATION_REQUIRED');
        await authorize();
        const restarted=await withTransaction(pool,c=>restartFailedIdempotency(c,key,existing.responseHash!,'failed',claim));
        if(!restarted){const winner=await withTransaction(pool,c=>readIdempotency(c,key),{readOnly:true});if(!winner)throw new Error('PUBLIC_OPERATION_RECEIPT_MISSING');return replay(winner);}
      } else {
        await authorize?.();
        const claimed=await withTransaction(pool,c=>claimIdempotency(c,key,claim));
        if(claimed.kind!=='new')return replay(claimed.record);
      }
      // A recovered attempt's predecessor may have produced effects, so its outcome is unknown unless it succeeds:
      // the operation's own authority (T11B replay, media-stop coordinator, handoff fence) decides what re-runs.
      let started=boundary!=='v1'||recovered;
      let result:JsonRecord;
      try {result=await fresh(()=>{started=true;});}
      catch(error) {
        const e=error as {code?:unknown;status?:unknown;message?:unknown;terminalResult?:unknown}|undefined;
        const failure={schema:'paios.public-operation.failure.v1',outcome:started?'unknown':'not_executed',proof:started?'unproven':'host_effect_boundary_v1',prior_not_executed:previous,error:{
          code:typeof e?.code==='string'?e.code:'PUBLIC_OPERATION_FRESH_FAILED',
          status:typeof e?.status==='number'&&Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:503,
          message:typeof e?.message==='string'?e.message:String(error),...(e?.terminalResult===undefined?{}:{terminalResult:e.terminalResult})}};
        let stored:IdempotencyRecord;
        try {stored=await withTransaction(pool,c=>(started?completeIndeterminate:completeFailed)(c,key,failure,jsonHash(failure),claim.tokenSha256));}
        catch(persistenceError) {
          // A lost COMMIT response can already have stored the exact terminal fact.
          try {const saved=await withTransaction(pool,c=>readIdempotency(c,key),{readOnly:true});
            if(saved?.status!==(started?'indeterminate':'failed')||saved.responseHash!==jsonHash(failure))throw persistenceError;
            stored=saved;
          } catch(readError) {
            keep(id,{status:started?'indeterminate':'failed',receipt:failure,tokenSha256:claim.tokenSha256});
            throw new AggregateError([error,persistenceError,readError],'PUBLIC_OPERATION_FAILURE_RECEIPT_UNKNOWN',{cause:error});
          }
        }
        // Replay uses the same durable code/status/message on this and a cold process.
        return replay(stored,error);
      }
      const receipt=previous.length?{schema:'paios.public-operation.result.v2',result,prior_not_executed:previous}:result;
      try {await withTransaction(pool,c=>completeIdempotency(c,key,receipt,jsonHash(receipt),claim.tokenSha256));}
      catch(persistenceError) {
        // A lost COMMIT reply can already have stored it; otherwise keep the known result for the next retry.
        const saved=await read(key).catch(()=>undefined);
        if(saved?.status==='committed'&&saved.responseHash===jsonHash(receipt))return result;
        if(saved===undefined||saved.status==='in_flight')keep(id,{status:'committed',receipt:receipt as JsonRecord,tokenSha256:claim.tokenSha256});
        throw Object.assign(new Error('PUBLIC_OPERATION_RECEIPT_UNSAVED',{cause:persistenceError}),{code:'PUBLIC_OPERATION_RECEIPT_UNSAVED',status:503});
      }
      return result;
      } finally {live.delete(id);}
    },
  });
}
