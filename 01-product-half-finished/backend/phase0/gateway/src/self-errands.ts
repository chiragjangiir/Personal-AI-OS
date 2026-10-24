import {constants} from 'node:fs';
import {opendir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import {parseErrandResult} from './errand-spool.ts';
import spoolContract from '../../../../../integrations/contracts/errand-spool.v1.json' with {type:'json'};

/** Count the executor's terminal facts without retaining task text or answers. */
export async function errandOutcomes(directory:string,principal:string,since:number,until:number,busy?:()=>boolean) {
  if(busy?.())return {status:'deferred_live_call'};
  let entries;try{entries=await opendir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {status:'empty',success:0,failed:0};throw error;}
  const jobs=new Set<string>(),reasons:Record<string,number>=Object.create(null);
  let success=0,failed=0,unknown=0,complete=true,scanned=0;
  for await(const entry of entries){
    if(++scanned>10000||busy?.()){complete=false;break;}
    const name=/^[a-z0-9-]+\.([a-z-]+)\.json$/.exec(entry.name);
    if(!name||!Object.values(spoolContract.states).includes(name[1]!))continue;
    const quarantined=name[1]===spoolContract.states.quarantined;
    const file=await open(join(directory,entry.name),constants.O_RDONLY|constants.O_NOFOLLOW).catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
    if(!file){complete=false;continue;}
    let value;try{const stat=await file.stat();check(stat.isFile()&&stat.size<=65536,'SELF_ERRAND_RECORD_INVALID');
      try{value=JSON.parse(await file.readFile('utf8'));}catch(error){if(quarantined&&error instanceof SyntaxError){unknown++;complete=false;continue;}throw error;}
    }finally{await file.close();}
    if(quarantined&&!value?.delivery_failure){unknown++;complete=false;continue;}
    let result;
    try{result=parseErrandResult(value);}catch(error){if(!quarantined)throw error;unknown++;complete=false;continue;}
    const at=Date.parse(result.finished_at);
    if(result.principal_id!==principal||at<since||at>until||jobs.has(result.job_id))continue;
    jobs.add(result.job_id);if(result.success)success++;else failed++;
    if(result.terminal_reason)reasons[result.terminal_reason]=(reasons[result.terminal_reason]??0)+1;
  }
  return {status:complete?'counted':'incomplete',success,failed,reasons,unknown,unknown_scope:'Retained quarantined records without validated delivery-failure facts; owner, time and outcome are unverified. Excluded from success and failed.',complete,source:'executor terminal spool; only retained outcomes'};
}
