import type {ActivityCard,ActivityItem} from '../../../services/personal-aios-integration/src/activity.ts';

/** The deployed v1 clients accept the original activity enum. Summaries retain the more precise receipt fact. */
export function activityWire<T extends Record<string,unknown>&{operation:string}>(body:T):T{
  if(body.operation!=='activity_update')return body;
  const original=body.card as ActivityCard;
  const state=(value:ActivityCard['state'])=>value==='unknown'?'partial':value==='waiting'?'running':value;
  const summary=(value:{state:ActivityCard['state'];summary:string})=>{
    const prefix=value.state==='unknown'?'结果尚未核实':value.state==='waiting'?'正在等待确认':'';
    return prefix?Array.from(`${prefix}，${value.summary}`).slice(0,48).join(''):value.summary;
  };
  const {unknown=0,waiting=0,...counts}=original.counts;
  const card:ActivityCard={...original,state:state(original.state),summary:summary(original),
    ...(original.state==='unknown'?{failure_reason:'结果尚未核实'}:{}),
    counts:{...counts,running:counts.running+waiting,...(counts.partial!==undefined||unknown?{partial:(counts.partial??0)+unknown}:{})},
    items:original.items.map((item):ActivityItem=>({...item,state:state(item.state),summary:summary(item),
      ...(item.state==='unknown'?{failure_reason:'结果尚未核实'}:{})}))};
  return {...body,card};
}
