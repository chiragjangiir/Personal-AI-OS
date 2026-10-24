import {check} from '../contracts.ts';
const DAY_MS=86400000;
const formats=new Map<string,Intl.DateTimeFormat>();
function format(tz:string):Intl.DateTimeFormat {
  let value=formats.get(tz);
  if(!value){value=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',
    minute:'2-digit',second:'2-digit',hourCycle:'h23'});if(formats.size>=32)formats.delete(formats.keys().next().value!);formats.set(tz,value);}
  return value;
}
export function localDay(ms:number,tz:string):string {
  const parts=format(tz).formatToParts(ms),get=(key:string)=>parts.find(p=>p.type===key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function validZone(tz:unknown):tz is string {
  if(typeof tz!=='string'||tz.length>100)return false;
  try{format(tz);return true;}catch{return false;}
}
export function validDay(day:string):boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;
}
export function nextDay(day:string,offset=1):string {return new Date(Date.parse(day)+offset*DAY_MS).toISOString().slice(0,10);}
/** Convert a local boundary to UTC. Iterate zone offsets, including DST. Refuse nonexistent/ambiguous boundary cycles. */
export function boundary(day:string,tz:string,hour=0):number {
  check(validDay(day)&&validZone(tz),'HEALTH_QUERY_RANGE_INVALID',422);
  const target=Date.parse(`${day}T${String(hour).padStart(2,'0')}:00:00Z`);
  let instant=target;
  for(let i=0;i<5;i++){
    const p=format(tz).formatToParts(instant),n=(key:string)=>Number(p.find(part=>part.type===key)!.value);
    const local=Date.UTC(n('year'),n('month')-1,n('day'),n('hour'),n('minute'),n('second'));
    if(local===target)return instant;
    instant+=target-local;
  }
  check(false,'HEALTH_TIME_BOUNDARY_UNAVAILABLE',422);
}
/** Sleep reporting day D uses local 18:00 on D-1 through 18:00 on D, not a fixed UTC offset. */
export function dayWindow(day:string,tz:string,sleep=false):[number,number] {
  return sleep?[boundary(nextDay(day,-1),tz,18),boundary(day,tz,18)]:[boundary(day,tz),boundary(nextDay(day),tz)];
}
