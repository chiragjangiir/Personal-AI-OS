/** Opt-in attribution control: same HealthStore.ingest and schema, FULL/WAL disk vs SQLite memory.
 * The memory constructor is a fixture-only bypass of directory opening, never a production fallback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {HealthStore,type HealthBatch} from '../../../services/personal-aios-integration/src/health/store.ts';

test('HealthStore synchronous disk attribution',{skip:process.env.CALL_LOAD_MEASURE!=='1'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'paios-health-cost-')),disk=HealthStore.open(root);
  const schema=new DatabaseSync(join(root,'health.sqlite'),{readOnly:true});
  const memory=new DatabaseSync(':memory:');
  for(const row of schema.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type='index'").all())memory.exec(row.sql as string);
  schema.close();
  const ram=new (HealthStore as unknown as new(db:DatabaseSync,now:()=>number)=>HealthStore)(memory,Date.now);
  const results:Record<string,unknown>={};
  try{
    for(const [name,store] of [['disk_full_wal',disk],['memory',ram]] as const){
      const times:number[]=[],delay=monitorEventLoopDelay({resolution:1});delay.enable();
      await new Promise(resolve=>setTimeout(resolve,10));
      for(let n=0;n<200;n++){
        const at=Date.now(),batch:HealthBatch={control_id:`page-${n}`,metric:'stepCount',unit:'count',tz:'UTC',sources:['phone'],deleted:[],
          samples:Array.from({length:64},(_,i)=>({id:`00000000-0000-0000-0000-${String(n*64+i).padStart(12,'0')}`,s:at-1000,e:at,src:0,v:i}))};
        const start=performance.now();assert.equal(store.ingest('owner','phone',batch).stored,64);times.push(performance.now()-start);
        await new Promise(resolve=>setImmediate(resolve));
      }
      await new Promise(resolve=>setTimeout(resolve,10));delay.disable();times.sort((a,b)=>a-b);
      results[name]={pages:200,samples:12800,total_ms:times.reduce((a,b)=>a+b,0),p99_ms:times[198],max_ms:times.at(-1),loop_p99_ms:delay.percentile(99)/1e6,loop_max_ms:delay.max/1e6};
    }
    console.log('CALL_HEALTH_COST '+JSON.stringify(results));
  }finally{disk.close();ram.close();await rm(root,{recursive:true,force:true});}
});
