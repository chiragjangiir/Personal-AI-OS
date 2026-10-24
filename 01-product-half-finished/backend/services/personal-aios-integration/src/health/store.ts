import type {DatabaseSync} from 'node:sqlite';
import {check,digest,isIdentifier} from '../contracts.ts';
import {inTransaction,openOwnerDatabase} from '../owner-db.ts';
import {metricByWire,type HealthMetricSpec} from './metrics.ts';
import {dayWindow,nextDay,validDay,validZone} from './calendar.ts';
import {summarize,type DaySummary,type HealthRow,type WorkoutValue} from './summary.ts';
export {localDay} from './calendar.ts';

/** One durable, atomic HealthKit page. The phone advances its anchor only after this page's acknowledgement. */
export interface HealthBatch {control_id:string;metric:string;unit:string;tz:string;sources:string[];
  samples:{id:string;s:number;e:number;src:number;v?:number;c?:number;w?:WorkoutValue}[];deleted:string[]}
export interface HealthDay {day:string;tz:string;samples:number;summary:DaySummary}
export interface StoredSample extends HealthRow {sample_id:string;tz:string}
const SCHEMA='paios.health-store.v1',UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DAY_MS=86400000,MAX_AGGREGATE_ROWS=20000;
const DDL=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS samples(principal_id TEXT NOT NULL,sample_id TEXT NOT NULL,device_id TEXT NOT NULL,metric TEXT NOT NULL,
  start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,value REAL,category INTEGER,workout TEXT,source TEXT NOT NULL,tz TEXT NOT NULL,
  received_ms INTEGER NOT NULL,PRIMARY KEY(principal_id,sample_id),CHECK(end_ms>=start_ms)) STRICT;
CREATE INDEX IF NOT EXISTS samples_time ON samples(principal_id,metric,start_ms);
CREATE INDEX IF NOT EXISTS samples_end ON samples(principal_id,metric,end_ms);
CREATE TABLE IF NOT EXISTS deleted(principal_id TEXT NOT NULL,sample_id TEXT NOT NULL,deleted_ms INTEGER NOT NULL,
  PRIMARY KEY(principal_id,sample_id)) STRICT;
CREATE TABLE IF NOT EXISTS batches(principal_id TEXT NOT NULL,control_id TEXT NOT NULL,device_id TEXT NOT NULL,body_hash TEXT NOT NULL,tz TEXT NOT NULL,
  received_ms INTEGER NOT NULL,stored INTEGER NOT NULL,deleted INTEGER NOT NULL,PRIMARY KEY(principal_id,device_id,control_id)) STRICT;`;
const ownKeys=(value:object,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));

/** Mac source store. UUIDs, tombstones and page identities are scoped to a principal. Deleted UUIDs never resurrect.
 * Raw samples are retained. Day summaries are bounded read-time projections, not a second source of truth. */
export class HealthStore {
  private readonly db:DatabaseSync;private readonly now:()=>number;
  private constructor(db:DatabaseSync,now:()=>number){this.db=db;this.now=now;}
  static open(directory:string,now:()=>number=Date.now):HealthStore {
    return new HealthStore(openOwnerDatabase(directory,'health.sqlite',DDL,SCHEMA,'HEALTH_STORE'),now);
  }
  close():void {if(this.db.isOpen)this.db.close();}
  /** Current durable records for an already validated page; deletions and later updates take precedence over replay bytes. */
  records(principal:string,metric:string,ids:string[]):StoredSample[] {
    if(!ids.length)return [];
    return this.db.prepare(`SELECT sample_id,start_ms,end_ms,value,category,workout,source,tz FROM samples WHERE principal_id=? AND metric=? AND sample_id IN (${ids.map(()=>'?').join(',')})`)
      .all(principal,metric,...ids) as unknown as StoredSample[];
  }
  ingest(principal:string,device:string,batch:HealthBatch):{stored:number;deleted:number} {
    const spec=metricByWire(batch?.metric);
    check(isIdentifier(principal)&&isIdentifier(device)&&spec&&batch.unit===spec.unit&&validZone(batch.tz)&&isIdentifier(batch.control_id)&&
      ownKeys(batch,['control_id','metric','unit','tz','sources','samples','deleted'])&&Array.isArray(batch.sources)&&batch.sources.length<=16&&
      batch.sources.every(s=>typeof s==='string'&&s.length>0&&Array.from(s).length<=160)&&Array.isArray(batch.samples)&&batch.samples.length<=64&&
      Array.isArray(batch.deleted)&&batch.deleted.length<=128&&batch.deleted.every(id=>typeof id==='string'&&UUID.test(id))&&
      new Set(batch.samples.map(s=>s?.id)).size===batch.samples.length,'HEALTH_BATCH_INVALID',422);
    for(const sample of batch.samples)this.validSample(spec,sample,batch.sources.length);
    const hash=digest({device,batch}),received=this.now();
    return inTransaction(this.db,()=>{
      const replay=this.db.prepare('SELECT body_hash,stored,deleted FROM batches WHERE principal_id=? AND device_id=? AND control_id=?')
        .get(principal,device,batch.control_id) as {body_hash:string;stored:number;deleted:number}|undefined;
      if(replay){check(replay.body_hash===hash,'HEALTH_BATCH_CONFLICT',409);return {stored:replay.stored,deleted:replay.deleted};}
      const tomb=this.db.prepare('SELECT 1 FROM deleted WHERE principal_id=? AND sample_id=?');
      const prior=this.db.prepare('SELECT metric FROM samples WHERE principal_id=? AND sample_id=?');
      const upsert=this.db.prepare('INSERT INTO samples(principal_id,sample_id,device_id,metric,start_ms,end_ms,value,category,workout,source,tz,received_ms) '+
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,sample_id) DO UPDATE SET device_id=excluded.device_id,start_ms=excluded.start_ms,'+
        'end_ms=excluded.end_ms,value=excluded.value,category=excluded.category,workout=excluded.workout,source=excluded.source,tz=excluded.tz,received_ms=excluded.received_ms');
      let stored=0,deleted=0;
      for(const s of batch.samples){
        if(tomb.get(principal,s.id))continue;
        const before=prior.get(principal,s.id) as {metric:string}|undefined;
        check(!before||before.metric===spec.wire,'HEALTH_SAMPLE_METRIC_CONFLICT',409);
        upsert.run(principal,s.id,device,spec.wire,s.s,s.e,s.v??null,s.c??null,s.w?JSON.stringify(s.w):null,batch.sources[s.src]!,batch.tz,received);
        stored++;
      }
      const remove=this.db.prepare('DELETE FROM samples WHERE principal_id=? AND sample_id=?');
      const bury=this.db.prepare('INSERT INTO deleted(principal_id,sample_id,deleted_ms) VALUES(?,?,?) ON CONFLICT(principal_id,sample_id) DO NOTHING');
      for(const id of batch.deleted){
        const before=prior.get(principal,id) as {metric:string}|undefined;
        check(!before||before.metric===spec.wire,'HEALTH_SAMPLE_METRIC_CONFLICT',409);
        deleted+=Number(remove.run(principal,id).changes);bury.run(principal,id,received);
      }
      this.db.prepare('INSERT INTO batches(principal_id,device_id,control_id,body_hash,tz,received_ms,stored,deleted) VALUES(?,?,?,?,?,?,?,?)')
        .run(principal,device,batch.control_id,hash,batch.tz,received,stored,deleted);
      return {stored,deleted};
    });
  }
  private validSample(spec:HealthMetricSpec,s:HealthBatch['samples'][number],sources:number):void {
    const w=s?.w,oneOf=[s?.v,s?.c,w].filter(v=>v!==undefined).length===1;
    check(s&&typeof s.id==='string'&&UUID.test(s.id)&&ownKeys(s,['id','s','e','src','v','c','w'])&&
      Number.isSafeInteger(s.s)&&Number.isSafeInteger(s.e)&&Math.abs(s.s)<=8640000000000000&&Math.abs(s.e)<=8640000000000000&&
      s.e>=s.s&&Number.isSafeInteger(s.src)&&s.src>=0&&s.src<sources&&oneOf&&
      (spec.kind==='event'?s.c===0:spec.kind==='sleep'?Number.isSafeInteger(s.c)&&s.c!>=0&&s.c!<=5:
        spec.kind==='workout'?w!==null&&w!==undefined&&ownKeys(w,['type','dur','kcal','dist'])&&Number.isSafeInteger(w.type)&&w.type>=0&&
          [w.dur,w.kcal??0,w.dist??0].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0):typeof s.v==='number'&&Number.isFinite(s.v)),
    'HEALTH_SAMPLE_INVALID',422);
  }
  /** Inclusive reporting-day labels; at most 93 days and 20,000 source rows. Dense ranges must be narrowed, never truncated. */
  days(principal:string,spec:HealthMetricSpec,fromDay:string,untilDay:string,tz=this.status(principal).tz??'UTC'):HealthDay[] {
    check(isIdentifier(principal)&&validDay(fromDay)&&validDay(untilDay)&&fromDay<=untilDay&&
      Date.parse(untilDay)-Date.parse(fromDay)<=92*DAY_MS,'HEALTH_QUERY_RANGE_INVALID',422);
    const sleep=spec.kind==='sleep',from=dayWindow(fromDay,tz,sleep)[0],until=dayWindow(untilDay,tz,sleep)[1];
    const rows=this.db.prepare('SELECT start_ms,end_ms,value,category,workout,source FROM samples WHERE principal_id=? AND metric=? '+
      'AND start_ms<? AND end_ms>=? ORDER BY start_ms LIMIT ?')
      .all(principal,spec.wire,until,from,MAX_AGGREGATE_ROWS+1) as unknown as HealthRow[];
    check(rows.length<=MAX_AGGREGATE_ROWS,'HEALTH_QUERY_TOO_DENSE',422);
    const result:HealthDay[]=[];
    for(let day=fromDay;day<=untilDay;day=nextDay(day)){
      const [s,e]=dayWindow(day,tz,sleep);
      const selected=rows.filter(r=>sleep||spec.kind==='cumulative'?r.start_ms<e&&(r.end_ms>s||r.end_ms===r.start_ms&&r.start_ms>=s):r.start_ms>=s&&r.start_ms<e);
      if(!selected.length)continue;
      const clipped=selected.map(r=>{
        if(!sleep&&spec.kind!=='cumulative')return r;
        const start_ms=Math.max(s,r.start_ms),end_ms=Math.min(e,r.end_ms);
        return {...r,start_ms,end_ms,...(spec.kind==='cumulative'&&r.end_ms>r.start_ms?
          {value:r.value!* ((end_ms-start_ms)/(r.end_ms-r.start_ms))}:{})};
      });
      const summary=summarize(spec.kind,clipped);
      if(spec.kind==='cumulative'&&selected.some(r=>r.start_ms<s||r.end_ms>e))summary.boundary_allocation='approximate_uniform_over_interval';
      result.push({day,tz,samples:selected.length,summary});
    }
    return result;
  }
  /** Start-time selection in [from,until), newest first. `truncated` describes an intentional bounded sample page. */
  samples(principal:string,spec:HealthMetricSpec,from:number,until:number,limit:number):{rows:StoredSample[];truncated:boolean} {
    check(isIdentifier(principal)&&Number.isSafeInteger(from)&&Number.isSafeInteger(until)&&from<until&&until-from<=31*DAY_MS&&
      Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'HEALTH_QUERY_RANGE_INVALID',422);
    const rows=this.db.prepare('SELECT sample_id,start_ms,end_ms,value,category,workout,source,tz FROM samples WHERE principal_id=? AND metric=? '+
      'AND start_ms>=? AND start_ms<? ORDER BY start_ms DESC,sample_id DESC LIMIT ?')
      .all(principal,spec.wire,from,until,limit+1) as unknown as StoredSample[];
    return {rows:rows.slice(0,limit),truncated:rows.length>limit};
  }
  /** Last accepted page, including an empty or deletion-only page. A replay does not claim a fresh sync. */
  status(principal:string):{tz:string|undefined;synced_ms:number|undefined} {
    check(isIdentifier(principal),'HEALTH_QUERY_INVALID',422);
    const row=this.db.prepare('SELECT tz,received_ms FROM batches WHERE principal_id=? ORDER BY received_ms DESC,rowid DESC LIMIT 1')
      .get(principal) as {tz:string;received_ms:number}|undefined;
    return {tz:row?.tz,synced_ms:row?.received_ms};
  }
}
