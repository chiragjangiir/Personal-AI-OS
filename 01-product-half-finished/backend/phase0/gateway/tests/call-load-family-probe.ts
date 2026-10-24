import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';

/** Observe this parent's actual RSS family; exclude the ps probe and never add separate component baseline estimates. */
export function callLoadFamilyProbe(context:()=>{phase:string;resources:unknown},onError:(error:unknown)=>void,scope='controlled source composition; native speech/turn/vision/provider model baselines excluded'){
  const started=performance.now(),samples:any[]=[],generations=new Map<string,{pid:number;ppid:number;born:string;first_ms:number;last_ms:number;phases:Set<string>}>();
  let flight:Promise<void>|undefined;
  const sample=():Promise<void>=>{
    if(flight)return flight;
    const {phase,resources}=context();
    flight=(async()=>{
      const {stdout}=await promisify(execFile)('ps',['-axo','pid=,ppid=,rss=,lstart=,comm=']);
      const rows=stdout.trim().split('\n').map(line=>{
        const fields=line.trim().split(/\s+/);return {pid:Number(fields[0]),ppid:Number(fields[1]),rss:Number(fields[2])*1024,
          born:fields.slice(3,8).join(' '),command:fields.slice(8).join(' ')};
      });
      const ids=new Set([process.pid]);let prior=0;
      while(prior!==ids.size){prior=ids.size;for(const row of rows)if(ids.has(row.ppid))ids.add(row.pid);}
      const processes=rows.filter(row=>ids.has(row.pid)&&row.command.split('/').at(-1)!=='ps'),at_ms=Math.round(performance.now()-started);
      for(const row of processes){const key=`${row.pid}:${row.born}`,known=generations.get(key);
        if(known){known.last_ms=at_ms;known.phases.add(phase);}else generations.set(key,{pid:row.pid,ppid:row.ppid,born:row.born,first_ms:at_ms,last_ms:at_ms,phases:new Set([phase])});}
      const parent_rss=processes.find(row=>row.pid===process.pid)?.rss??0,total_rss=processes.reduce((n,row)=>n+row.rss,0);
      samples.push({at_ms,phase,parent_rss,child_rss:total_rss-parent_rss,total_rss,processes,resources,
        previously_observed_children_still_alive:rows.filter(row=>row.pid!==process.pid&&generations.has(`${row.pid}:${row.born}`)).map(row=>row.pid)});
    })().catch(onError).finally(()=>{flight=undefined;});return flight;
  };
  const timer=setInterval(()=>{void sample();},1000);
  return {sample,async stop(){clearInterval(timer);await flight;},report(){
    const phaseNames=[...new Set(samples.map(sample=>sample.phase))];
    return {scope:scope+'; RSS is not cgroup memory',sample_interval_ms:1000,
      samples,generations:[...generations.values()].map(value=>({...value,phases:[...value.phases]})),
      phases:phaseNames.map(phase=>{const rows=samples.filter(row=>row.phase===phase),peak=Math.max(...rows.map(row=>row.total_rss));
        return {phase,samples:rows.length,parent_peak_rss:Math.max(...rows.map(row=>row.parent_rss)),child_peak_rss:Math.max(...rows.map(row=>row.child_rss)),
          family_peak_rss:peak,last_family_rss:rows.at(-1).total_rss,tail_mean_family_rss:Math.round(rows.slice(-3).reduce((n,row)=>n+row.total_rss,0)/Math.min(3,rows.length)),cap_comparison:Object.fromEntries([['production',1728],['staging',1280]].map(([name,mib])=>[name,{cap_mib:mib,headroom_bytes:Number(mib)*1048576-peak,within_sampled_cap:peak<=Number(mib)*1048576}]))};})};
  }};
}
