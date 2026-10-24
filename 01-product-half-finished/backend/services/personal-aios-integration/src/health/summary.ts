import {check} from '../contracts.ts';
import {SLEEP,workoutName,type HealthKind} from './metrics.ts';

/** One stored sample as the day aggregation reads it. */
export interface HealthRow {start_ms: number; end_ms: number; value: number | null; category: number | null; workout: string | null; source: string}
export interface WorkoutValue {type: number; dur: number; kcal?: number; dist?: number}
export type DaySummary = Record<string, number | string | string[]>;

const round = (n: number, digits = 1) => Number(n.toFixed(digits));
/** Normalize before addition. An unrepresentable result fails explicitly; raw data remains in the source store. */
export function aggregateNumber(values:number[],average=false):number {
  const scale=Math.max(0,...values.map(v=>Math.abs(v)));
  const value=scale===0?0:scale*(values.reduce((sum,v)=>sum+v/scale,0)/(average?values.length:1));
  check(Number.isFinite(value),'HEALTH_AGGREGATE_NOT_FINITE',422);return value;
}
const minutes = (ms: number) => Math.round(ms / 60000);
/** Total length of the union of intervals: overlapping sources (phone in-bed, watch stages, other apps) count once. */
function covered(intervals: [number, number][]): number {
  let total = 0, end = -Infinity;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (e <= end) continue;
    total += e - Math.max(s, end); end = e;
  }
  return total;
}

/** One day of one metric. Cumulative metrics (steps, energy) are summed per source and the largest source wins: the
 *  phone and the watch both count the same walk, and HealthKit's own merge is not available on the Mac (an
 *  approximation that may under-count separate coverage or retain duplicates within a source). */
export function summarize(kind: HealthKind, rows: HealthRow[]): DaySummary {
  if (kind === 'event') return {count: rows.length, aggregation_method: 'recorded_events', sources: [...new Set(rows.map(r=>r.source))]};
  if (kind === 'cumulative') {
    const bySource = new Map<string, number[]>();
    for (const row of rows){const values=bySource.get(row.source)??[];values.push(row.value??0);bySource.set(row.source,values);}
    const total=Math.max(...[...bySource.values()].map(values=>aggregateNumber(values)));
    check(Number.isFinite(total),'HEALTH_AGGREGATE_NOT_FINITE',422);
    return {total:round(total),aggregation_method:'largest_source_total',sources:[...bySource.keys()],
      ...(bySource.size>1?{approximation:'multiple_sources_not_healthkit_merged'}:{})};
  }
  if (kind === 'discrete') {
    const values = rows.filter(row => row.value !== null).sort((a, b) => a.end_ms - b.end_ms).map(row => row.value!);
    return {min: round(Math.min(...values)), max: round(Math.max(...values)),
      avg: round(aggregateNumber(values,true)), last: round(values.at(-1)!)};
  }
  if (kind === 'sleep') {
    const of = (...codes: number[]) => rows.filter(row => codes.includes(row.category ?? -1)).map(row => [row.start_ms, row.end_ms] as [number, number]);
    const asleep = of(SLEEP.asleep, SLEEP.core, SLEEP.deep, SLEEP.rem);
    const stages=[SLEEP.core,SLEEP.deep,SLEEP.rem],stageTotal=stages.reduce((sum,c)=>sum+covered(of(c)),0);
    const stageUnion=covered(of(...stages)),asleepMs=covered(asleep),awakeMs=covered(of(SLEEP.awake));
    const awakeOverlap=asleepMs+awakeMs>covered([...asleep,...of(SLEEP.awake)]);
    return {asleep_min: minutes(asleepMs),aggregation_method:'interval_union',
      ...(stageTotal>stageUnion||awakeOverlap?{approximation:'overlapping_sleep_categories',stage_overlap_min:minutes(stageTotal-stageUnion)}:{}), deep_min: minutes(covered(of(SLEEP.deep))), core_min: minutes(covered(of(SLEEP.core))),
      rem_min: minutes(covered(of(SLEEP.rem))), awake_min: minutes(covered(of(SLEEP.awake))), in_bed_min: minutes(covered(of(SLEEP.inBed))),
      ...(asleep.length ? {asleep_from_ms: Math.min(...asleep.map(i => i[0])), asleep_until_ms: Math.max(...asleep.map(i => i[1]))} : {})};
  }
  const workouts = rows.map(row => JSON.parse(row.workout ?? '{}') as WorkoutValue);
  return {count: workouts.length, minutes: Math.round(aggregateNumber(workouts.map(w=>w.dur/60))),
    kcal: round(aggregateNumber(workouts.map(w=>w.kcal??0)),0), km: round(aggregateNumber(workouts.map(w=>(w.dist??0)/1000))),
    types: [...new Set(workouts.map(w => workoutName(w.type)))]};
}

/** "7小时12分" for spoken Chinese. */
export function duration(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}小时${m ? `${m}分` : ''}` : `${m}分钟`;
}
