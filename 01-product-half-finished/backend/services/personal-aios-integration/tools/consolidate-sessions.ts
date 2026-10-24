import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {discoverSessions,measureDisk} from './session-discovery.ts';
export {discoverSessions,measureDisk} from './session-discovery.ts';
export type {DiskStats,SessionPlan,ConversionPlan} from './session-discovery.ts';

export interface ConvertOptions {apply?:boolean;gatewayStopped?:boolean;closedRefs?:string[]}
/** Offline only. --gateway-stopped is the operator assertion; legacy writers have no shared converter lock. */
export async function consolidateSessions(root:string,options:ConvertOptions={}){
  const started=performance.now();
  if(options.apply&&!options.gatewayStopped)throw new Error('APPLY_REQUIRES_GATEWAY_STOPPED');
  let storage:PosixStorage|undefined;const converted:string[]=[];
  try{
    const plan=await discoverSessions(root,options.closedRefs??[]);
    const discovery_ms=performance.now()-started;
    if(options.apply)storage=new PosixStorage(root);
    const resuming=storage?await storage.pendingFinals():[];
    for(const raw_ref of resuming){let session=plan.sessions.find(session=>session.raw_ref===raw_ref);
      if(!session){session={raw_ref,closed_by:[],issues:[],records:[],budget:{max_chunk_bytes:1,max_total_bytes:1,max_chunks:1,max_revisions:1,max_seq:1}};plan.sessions.push(session);}
      session.closed_by.push('committed final session');session.issues=session.issues.filter(issue=>issue==='pending raw ingress');
    }
    const eligible=plan.sessions.filter(session=>session.closed_by.length&&!session.issues.length);
    if(storage&&eligible.length)for(const session of plan.sessions)await storage.trackSessionRecords(session.raw_ref,session.records.filter(record=>record.namespace==='objects'));
    if(storage){
      for(const session of eligible){
        if(!resuming.includes(session.raw_ref))await storage.trackSessionRecords(session.raw_ref,session.records);
        const archive=new RawArchive(storage,session.budget.max_chunk_bytes,undefined,session.budget);
        try{await archive.finalizeSession(session.raw_ref,'offline_converter');converted.push(session.raw_ref);}finally{await archive.close();}
      }
    }
    await storage?.close();storage=undefined;
    const after=options.apply?await measureDisk(root):plan.before;
    return {...plan,mode:options.apply?'apply':'dry-run',converted,after,discovery_ms,elapsed_ms:performance.now()-started,freed:{files:plan.before.files-after.files,inodes:plan.before.inodes-after.inodes,
      logical_bytes:plan.before.logical_bytes-after.logical_bytes,allocated_bytes:plan.before.allocated_bytes-after.allocated_bytes}};
  }finally{await storage?.close();}
}
async function main(args:string[]){
  if(args.includes('--help')){console.log('Usage: node tools/consolidate-sessions.ts ROOT [--apply --gateway-stopped] [--closed-ref l5:HASH ...] [--details]\nDefault: source-read-only dry run; temporary SQLite inventory is outside ROOT and removed afterward. Stop the gateway before apply. Repeat --closed-ref for operator-confirmed ended legacy call/voice sessions without a durable end proof. Open/ambiguous sessions and .pending-* files remain untouched. --details includes owned metadata and object keys; default reports per-session key counts. Statistics count unique file inodes, logical bytes and allocated blocks, including SQLite/WAL overhead; freed values may be negative.');return;}
  let root:string|undefined,details=false;const options:ConvertOptions={closedRefs:[]};
  for(let n=0;n<args.length;n++){const arg=args[n]!;
    if(arg==='--apply')options.apply=true;else if(arg==='--gateway-stopped')options.gatewayStopped=true;else if(arg==='--details')details=true;
    else if(arg==='--closed-ref'){const ref=args[++n];if(!ref)throw new Error('CLOSED_REF_REQUIRED');options.closedRefs!.push(ref);}
    else if(arg.startsWith('--')||root)throw new Error(`UNKNOWN_ARGUMENT:${arg}`);else root=arg;
  }
  if(!root)throw new Error('STORAGE_ROOT_REQUIRED');const report=await consolidateSessions(resolve(root),options);
  console.log(JSON.stringify(details?report:{...report,sessions:report.sessions.map(({records,...session})=>({...session,record_count:records.length}))},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
