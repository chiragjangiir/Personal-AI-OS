import {constants,promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {check,sha256} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';

export interface RestoreOptions {apply?:boolean;gatewayStopped?:boolean}
/** Restore original loose keys before starting a reader that predates session folding. Never removes the final ledger. */
export async function restoreSessionLayout(root:string,options:RestoreOptions={}) {
  if(options.apply&&!options.gatewayStopped)throw new Error('APPLY_REQUIRES_GATEWAY_STOPPED');
  const stat=await fs.lstat(root);check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_RESTORE_ROOT');
  const report={mode:options.apply?'apply':'dry-run',sessions:0,files:0,bytes:0,restored_files:0,restored_bytes:0,already_present:0};
  try{const ledger=await fs.lstat(join(root,'session-records.sqlite'));check(ledger.isFile()&&!ledger.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return report;throw error;}
  // The normal reader owns decoding. Preview it on a scratch ledger so WAL/schema setup never touches ROOT.
  const scratch=options.apply?undefined:await fs.mkdtemp(join(tmpdir(),'paios-restore-preview-'));
  const storage=new PosixStorage(scratch??root),seen=new Set<string>();
  try {
    const readPhysical=async(namespace:string,key:string)=>{
      check(/^[a-z][a-z0-9-]{0,40}$/u.test(namespace)&&/^[a-f0-9]{64}$/u.test(key),'INVALID_SESSION_RECORD_REFERENCE');
      const directory=join(root,namespace),stat=await fs.lstat(directory);
      check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_NAMESPACE');
      const handle=await fs.open(join(directory,key),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{check((await handle.stat()).isFile(),'UNSAFE_STORAGE_OBJECT');return await handle.readFile();}finally{await handle.close();}
    };
    if(scratch)for(const suffix of ['', '-wal'])try{const path=join(root,'session-records.sqlite'+suffix),stat=await fs.lstat(path);
      check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');await fs.copyFile(path,join(scratch,'session-records.sqlite'+suffix));}
      catch(error){if(suffix===''||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const restore=async(namespace:string,key:string,bytes:Uint8Array)=>{
      const identity=`${namespace}:${key}`;if(seen.has(identity))return;seen.add(identity);
      report.files++;report.bytes+=bytes.length;
      let present=false;
      try{const prior=scratch?await readPhysical(namespace,key):await storage.readHot(namespace,key);
        check(Buffer.from(prior).equals(Buffer.from(bytes)),'RESTORE_EXISTING_CONTENT_CONFLICT',409);present=true;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(present)report.already_present++;
      if(!options.apply)return;
      await storage.publishRestored(namespace,key,bytes);
      const restored=await storage.readHot(namespace,key);
      check(Buffer.from(restored).equals(Buffer.from(bytes)),'RESTORE_PHYSICAL_READBACK_FAILED',500);
      if(namespace==='objects')check(sha256(restored)===key,'RESTORE_OBJECT_INTEGRITY',500);
      if(!present){report.restored_files++;report.restored_bytes+=bytes.length;}
    };
    for(const key of await storage.list('session-finals')) {
      const final=await storage.readFinal(`l5:${key}`);check(final,'FINAL_SESSION_MISSING',404);report.sessions++;
      for(let offset=0;offset<final.records.length;offset+=32){
        const outcomes=await Promise.allSettled(final.records.slice(offset,offset+32).map(async record=>{
          const bytes=Buffer.from(record.bytes,'base64');check(bytes.toString('base64')===record.bytes,'INVALID_FINAL_RECORD');
          await restore(record.namespace,record.key,bytes);
        }));
        const failure=outcomes.find(outcome=>outcome.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
      }
      const audio=scratch?await readPhysical('objects',final.object_hash):await storage.read('objects',final.object_hash);
      check(audio.length===final.bytes&&sha256(audio)===final.object_hash,'RESTORE_OBJECT_INTEGRITY',500);
      for(const object of final.objects){const bytes=audio.subarray(object.offset,object.offset+object.bytes);
        check(bytes.length===object.bytes&&sha256(bytes)===object.key,'RESTORE_OBJECT_INTEGRITY',500);
        await restore('objects',object.key,bytes);}
      for(const object of final.retained_objects??[]){const bytes=scratch?await readPhysical('objects',object.key):await storage.read('objects',object.key);
        check(sha256(bytes)===object.key,'RESTORE_OBJECT_INTEGRITY',500);await restore('objects',object.key,bytes);}
    }
    return report;
  } finally {await storage.close();if(scratch)await fs.rm(scratch,{recursive:true,force:true});}
}

async function main(args:string[]) {
  if(args.includes('--help')){console.log('Usage: node tools/restore-session-layout.ts ROOT [--apply --gateway-stopped]\nDefault: dry run. Stop the gateway before apply. Restore every folded metadata key and original raw object to the loose layout, verify physical bytes, and retain consolidated objects and SQLite. Rerun safely after interruption. Requires enough disk space for the restored copies.');return;}
  let root:string|undefined;const options:RestoreOptions={};
  for(const arg of args){if(arg==='--apply')options.apply=true;else if(arg==='--gateway-stopped')options.gatewayStopped=true;
    else if(arg.startsWith('--')||root)throw new Error(`UNKNOWN_ARGUMENT:${arg}`);else root=arg;}
  if(!root)throw new Error('STORAGE_ROOT_REQUIRED');
  console.log(JSON.stringify(await restoreSessionLayout(resolve(root),options),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
