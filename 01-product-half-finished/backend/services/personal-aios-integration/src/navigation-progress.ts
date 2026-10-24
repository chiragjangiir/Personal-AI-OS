import type {NavPlan,NavProgress} from './movement.ts';

type Point={lat:number;lng:number};
const radians=Math.PI/180,earthRadius=6_371_000;
function distance(a:Point,b:Point):number {
  const h=Math.sin((b.lat-a.lat)*radians/2)**2+
    Math.cos(a.lat*radians)*Math.cos(b.lat*radians)*Math.sin((b.lng-a.lng)*radians/2)**2;
  return 2*earthRadius*Math.asin(Math.sqrt(Math.min(1,h)));
}
function project(point:Point,line:Point[]) {
  if(line.length===1)return {distance:distance(point,line[0]!),fraction:0,segment:-1,segmentFraction:1};
  const scale=Math.cos(point.lat*radians),meters=radians*earthRadius;
  let nearest=Infinity,along=0,length=0,segment=0,segmentFraction=0;
  for(let index=0;index<line.length-1;index++){
    const a=line[index]!,b=line[index+1]!;
    const ax=(a.lng-point.lng)*scale*meters,ay=(a.lat-point.lat)*meters;
    const dx=(b.lng-a.lng)*scale*meters,dy=(b.lat-a.lat)*meters;
    const squared=dx*dx+dy*dy,size=Math.sqrt(squared);
    const t=squared>0?Math.min(1,Math.max(0,-(ax*dx+ay*dy)/squared)):0;
    const offset=Math.hypot(ax+t*dx,ay+t*dy);
    if(offset<nearest){nearest=offset;along=length+t*size;segment=index;segmentFraction=t;}
    length+=size;
  }
  return {distance:nearest,fraction:length>0?along/length:0,segment,segmentFraction};
}

/** Project a WGS84 fix onto the existing route without owning navigation state. */
export function projectNavigation(plan:NavPlan&{nav_id:string;revision:number},point:Point,previousStepIndex=plan.steps[0]!.index):
  {progress:NavProgress;distance_from_route_m:number;arrived:boolean} {
  const projections=plan.steps.map(step=>project(point,step.polyline));
  const distance_from_route_m=Math.min(...projections.map(value=>value.distance));
  let step=plan.steps.findIndex(value=>value.index===previousStepIndex);
  if(distance_from_route_m<=40){
    for(let next=step+1;next<plan.steps.length;next++)if(projections[next]!.distance<=40&&
      (projections[next]!.distance<projections[step]!.distance||next===step+1&&projections[step]!.fraction>=0.999))step=next;
  }
  const current=plan.steps[step]!,projection=projections[step]!;
  const fractionRemaining=1-projection.fraction;
  const distance_to_maneuver_m=current.distance_m*fractionRemaining;
  const future=plan.steps.slice(step+1),length=plan.steps.reduce((sum,value)=>sum+value.distance_m,0);
  const duration=plan.steps.reduce((sum,value)=>sum+value.duration_s,0);
  const unscaledDistance=distance_to_maneuver_m+future.reduce((sum,value)=>sum+value.distance_m,0);
  const unscaledDuration=current.duration_s*fractionRemaining+future.reduce((sum,value)=>sum+value.duration_s,0);
  const offset=plan.steps.slice(0,step).reduce((sum,value)=>sum+value.polyline.length,0);
  const points=plan.steps.reduce((sum,value)=>sum+value.polyline.length,0);
  return {progress:{nav_id:plan.nav_id,revision:plan.revision,step_index:current.index,maneuver:current.maneuver,
    distance_to_maneuver_m,...(current.road?{road:current.road}:{}),remaining_m:length>0?plan.total_m*unscaledDistance/length:0,
    remaining_s:duration>0?plan.total_s*unscaledDuration/duration:0,
    route_segment_index:Math.max(0,Math.min(points-2,offset+projection.segment)),segment_fraction:projection.segmentFraction},
    distance_from_route_m,arrived:distance(point,plan.destination)<=25};
}
