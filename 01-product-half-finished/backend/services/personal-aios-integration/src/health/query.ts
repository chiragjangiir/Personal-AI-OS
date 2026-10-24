import {check} from '../contracts.ts';
import {HEALTH_METRICS,metricByKey,SLEEP_NAMES,workoutName,type HealthMetricSpec} from './metrics.ts';
import {type HealthStore,type HealthDay,type StoredSample} from './store.ts';
import {boundary,localDay,nextDay,validDay} from './calendar.ts';
import {aggregateNumber,duration,type WorkoutValue} from './summary.ts';

/** Owner-only `paios_health_query`. One metric, reporting days or bounded start-time sample pages. */
export const HEALTH_QUERY_METRICS=['overview',...HEALTH_METRICS.map(spec=>spec.key)] as const;
const DAY_MS=86400000;
function stamp(ms:number,tz:string):string {
  return `${localDay(ms,tz)} ${new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ms)}`;
}
function time(value:unknown,tz:string):number|undefined {
  if(value===undefined)return undefined;
  check(typeof value==='string','HEALTH_QUERY_INVALID',422);
  if(validDay(value))return boundary(value,tz);
  // Explicit offset prevents the Mac's timezone from silently changing the owner's range.
  check(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value),'HEALTH_QUERY_INVALID',422);
  const ms=Date.parse(value);check(Number.isSafeInteger(ms),'HEALTH_QUERY_INVALID',422);return ms;
}
function readable(spec:HealthMetricSpec,day:HealthDay):Record<string,unknown> {
  const s=day.summary;
  if(spec.kind!=='sleep')return {day:day.day,samples:day.samples,...s};
  return {day:day.day,samples:day.samples,...s,asleep:duration(s.asleep_min as number),deep:duration(s.deep_min as number),
    core:duration(s.core_min as number),rem:duration(s.rem_min as number),awake:duration(s.awake_min as number),in_bed:duration(s.in_bed_min as number),
    ...(typeof s.asleep_from_ms==='number'?{fell_asleep:stamp(s.asleep_from_ms,day.tz),woke:stamp(s.asleep_until_ms as number,day.tz)}:{})};
}
function sample(spec:HealthMetricSpec,row:StoredSample):Record<string,unknown> {
  const base={sample_id:row.sample_id,at:stamp(row.start_ms,row.tz),until:stamp(row.end_ms,row.tz),start_ms:row.start_ms,end_ms:row.end_ms,
    source:row.source,tz:row.tz};
  if(spec.kind==='event')return {...base,category:row.category,event:spec.wire};
  if(spec.kind==='sleep')return {...base,category:row.category,stage:SLEEP_NAMES[row.category!]};
  if(spec.kind==='workout'){
    const w=JSON.parse(row.workout!) as WorkoutValue;
    return {...base,...w,activity:workoutName(w.type),minutes:w.dur/60};
  }
  return {...base,value:row.value};
}
export function queryHealth(store:HealthStore,principal:string,args:Record<string,unknown>,now=Date.now(),reportingZone?:string) {
  const spec=typeof args.metric==='string'?metricByKey(args.metric):undefined;
  check(Object.keys(args).every(key=>['metric','from','until','aggregation','limit'].includes(key))&&(args.metric==='overview'||spec)&&
    (args.aggregation===undefined||args.aggregation==='day'||args.aggregation==='sample')&&
    (args.limit===undefined||Number.isSafeInteger(args.limit)&&(args.limit as number)>=1&&(args.limit as number)<=100),
  'HEALTH_QUERY_INVALID',422);
  const status=store.status(principal),tz=reportingZone??status.tz??'UTC',synced={synced_at:status.synced_ms===undefined?null:stamp(status.synced_ms,tz)};
  if(!spec){check(args.from===undefined&&args.until===undefined&&args.aggregation===undefined&&args.limit===undefined,'HEALTH_QUERY_INVALID',422);
    return {metric:'overview',tz,...synced,...overview(store,principal,tz,now)};}
  const aggregation=args.aggregation??'day',sampleMode=aggregation==='sample';
  const until=time(args.until,tz)??now,from=time(args.from,tz)??until-(sampleMode?DAY_MS:7*DAY_MS);
  check(from<until&&until-from<=(sampleMode?31:92)*DAY_MS,'HEALTH_QUERY_RANGE_INVALID',422);
  const head={metric:spec.key,label:spec.label,unit:spec.unit,tz,aggregation,...synced};
  if(!sampleMode){check(args.limit===undefined,'HEALTH_QUERY_INVALID',422);
    return {...head,range_semantics:'whole_reporting_days',sleep_day_boundary:spec.kind==='sleep'?'local_18_previous_day_to_18':undefined,
      days:store.days(principal,spec,localDay(from,tz),localDay(until-1,tz),tz).map(d=>readable(spec,d))};}
  const {rows,truncated}=store.samples(principal,spec,from,until,(args.limit as number|undefined)??50);
  return {...head,range_semantics:'sample_start_in_half_open_interval',samples:rows.map(row=>sample(spec,row)),truncated};
}
/** Compact recent owner picture. Last night's reporting day only; resting HR is descriptive, never a diagnosis. */
function overview(store:HealthStore,principal:string,tz:string,now:number) {
  const today=localDay(now,tz),sleep=store.days(principal,metricByKey('sleep')!,today,today,tz)[0];
  const resting=store.days(principal,metricByKey('resting_heart_rate')!,nextDay(today,-6),today,tz);
  const avg=resting.length?Number(aggregateNumber(resting.map(d=>d.summary.avg as number),true).toFixed(1)):undefined;
  const last=resting.at(-1);
  return {...(sleep&&Number(sleep.summary.asleep_min)>0?{last_sleep:readable(metricByKey('sleep')!,sleep)}:{}),
    ...(last?{resting_heart_rate:{day:last.day,latest:last.summary.last,avg_7d:avg,observed_days:resting.length,
      delta_from_7d_avg:Number.isFinite((last.summary.last as number)-avg!)?Number(((last.summary.last as number)-avg!).toFixed(1)):null,unit:'count/min'}}:{})};
}
/** Owner context contains last-night sleep and resting-heart-rate trend only, at most 160 characters. */
export function recentHealthLine(store:HealthStore,principal:string,now=Date.now(),reportingZone?:string):string|undefined {
  const tz=reportingZone??store.status(principal).tz;if(!tz)return undefined;
  const o=overview(store,principal,tz,now),parts:string[]=[];
  if(o.last_sleep)parts.push(`昨晚睡了${o.last_sleep.asleep}${o.last_sleep.approximation?'（睡眠分类有重叠）':''}`);
  if(o.resting_heart_rate){const r=o.resting_heart_rate;
    parts.push(`静息心率${r.latest}次/分（${r.day}，近7天${r.observed_days}个有数据日均值${r.avg_7d}）`);}
  return parts.length?Array.from(`【身体】（手机健康数据）${parts.join('；')}`).slice(0,160).join(''):undefined;
}
