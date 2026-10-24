/** Staging-only visual catalogue cut. Never opens the source SQLite database. */
import {constants,promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {check} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import {ColdStorage,type ColdConfig} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/cold-storage.ts';
import {readColdConfig} from './staging_snapshot_l5.ts';
const {getLoadablePath}=createRequire(new URL('../../01-product-half-finished/backend/services/personal-aios-integration/package.json',import.meta.url))('sqlite-vec');

type File={path:string;size:number};
type Receipt={schema:string;as_of:string;since:string;source_rows:number;selected_rows:number;legacy_rows:number;files:File[];native_refs:{raw_ref:string;archive_revision:string}[];legacy_policy:string;absent?:boolean};
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const missingVisual=():Receipt=>({schema:'paios.staging.visual.v1',as_of:'',since:'',source_rows:0,selected_rows:0,legacy_rows:0,files:[],native_refs:[],legacy_policy:'No visual-memory directory exists.',absent:true});
function database(path:string,readOnly=false){
  const db=new DatabaseSync(path,{readOnly,allowExtension:true});
  try{db.loadExtension(getLoadablePath());db.enableLoadExtension(false);
    check(db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value==='paios.visual-memory.v2','VISUAL_SCHEMA_UNSUPPORTED');return db;
  }catch(e){db.close();throw e;}
}
async function sourceFile(root:string,path:string){
  check(/^frames\/[a-zA-Z0-9_-]+(?:-thumb)?\.jpg$/u.test(path),'VISUAL_SNAPSHOT_PATH_UNSAFE');
  const stat=await fs.lstat(join(root,'frames'));check(stat.isDirectory()&&!stat.isSymbolicLink(),'VISUAL_SNAPSHOT_PATH_UNSAFE');
  const handle=await fs.open(join(root,path),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{check((await handle.stat()).isFile(),'VISUAL_SNAPSHOT_PATH_UNSAFE');return await handle.readFile();}finally{await handle.close();}
}
async function checkReferences(dest:string,refs:{raw_ref:string;archive_revision:string}[]){
  const inventory=JSON.parse(await fs.readFile(join(dest,'..','l5-inventory.json'),'utf8'));
  const sources=new Map<string,any>(inventory.sources.map((s:any)=>[s.ref,s]));
  for(const ref of refs){
    const source=sources.get(ref.raw_ref);if(source?.revision===ref.archive_revision)continue;
    if(source?.kind==='stream'&&source.revisions?.includes(ref.archive_revision))continue;
    check(source?.kind==='stream'&&inventory.files.some((f:any)=>f.namespace==='stream-revisions'&&f.key===ref.archive_revision),'VISUAL_RECENT_NATIVE_L5_REFERENCE_MISSING');
    const revision=JSON.parse(await fs.readFile(join(dest,'..','stream-revisions',ref.archive_revision),'utf8'));
    check(revision.raw_ref===ref.raw_ref,'VISUAL_RECENT_NATIVE_L5_REFERENCE_MISSING');
  }
}
export async function verifyVisual(dest:string){
  try{const stat=await fs.lstat(dest);check(stat.isDirectory()&&!stat.isSymbolicLink(),'VISUAL_SNAPSHOT_PATH_UNSAFE');}catch(e){if(absent(e))return missingVisual();throw e;}
  const receipt:Receipt=JSON.parse(await fs.readFile(join(dest,'visual-inventory.json'),'utf8'));
  check(receipt.schema==='paios.staging.visual.v1','VISUAL_INVENTORY_SCHEMA');
  const db=database(join(dest,'visual.sqlite'),true);
  try{
    check(Number(db.prepare('SELECT count(*) AS n FROM frames').get()!.n)===receipt.selected_rows,'VISUAL_INVENTORY_ROWS');
    check(Number(db.prepare('SELECT count(*) AS n FROM frames WHERE captured_ms<? OR captured_ms>? OR owner_delete<>0').get(Date.parse(receipt.since),Date.parse(receipt.as_of))!.n)===0,'VISUAL_WINDOW_MISMATCH');
    check(db.prepare('PRAGMA quick_check').all().every(row=>row.quick_check==='ok'),'VISUAL_SQLITE_INVALID');
    const seen=new Set<string>();for(const file of receipt.files){check(!seen.has(file.path),'VISUAL_DUPLICATE_FILE');seen.add(file.path);
      check((await sourceFile(dest,file.path)).length===file.size,'VISUAL_FILE_SIZE_MISMATCH');}
    const legacy=db.prepare('SELECT original FROM frames WHERE raw_ref IS NULL AND archive_revision IS NULL').all();
    check(legacy.length===receipt.legacy_rows&&legacy.every(row=>seen.has(String(row.original))),'VISUAL_LEGACY_ORIGINAL_REQUIRED');
    const actual=db.prepare('SELECT raw_ref,archive_revision FROM frames WHERE raw_ref IS NOT NULL AND archive_revision IS NOT NULL ORDER BY id').all() as {raw_ref:string;archive_revision:string}[];
    check(JSON.stringify(actual)===JSON.stringify(receipt.native_refs),'VISUAL_NATIVE_REFERENCE_MISMATCH');await checkReferences(dest,actual);
  }finally{db.close();}return receipt;
}
export async function exportVisual(source:string,dest:string,asOf:string,cold?:ColdConfig){
  source=resolve(source);dest=resolve(dest);const end=Date.parse(asOf),start=end-48*3600000;
  check(Number.isFinite(end)&&dest!==source&&!dest.startsWith(source+'/')&&!source.startsWith(dest+'/'),'VISUAL_SNAPSHOT_SCOPE');
  let sourceStat;try{sourceStat=await fs.lstat(source);}catch(e){if(absent(e))return missingVisual();throw e;}
  check(sourceStat.isDirectory()&&!sourceStat.isSymbolicLink(),'VISUAL_SNAPSHOT_PATH_UNSAFE');
  await fs.mkdir(dest,{recursive:true,mode:0o700});check((await fs.readdir(dest)).length===0,'VISUAL_DESTINATION_NOT_EMPTY');
  for(const suffix of ['','-wal','-shm'])try{
    const from=join(source,'visual.sqlite'+suffix),stat=await fs.lstat(from);check(stat.isFile()&&!stat.isSymbolicLink(),'VISUAL_SNAPSHOT_PATH_UNSAFE');
    await fs.copyFile(from,join(dest,'visual.sqlite'+suffix));await fs.chmod(join(dest,'visual.sqlite'+suffix),0o600);
  }catch(e){if(!suffix||!absent(e))throw e;}
  const db=database(join(dest,'visual.sqlite')),scratch=await fs.mkdtemp(join(dest,'.visual-cold-'));
  const remote=cold?new ColdStorage(scratch,cold):undefined;
  try{
    const receipt:Receipt={schema:'paios.staging.visual.v1',as_of:new Date(end).toISOString(),since:new Date(start).toISOString(),source_rows:Number(db.prepare('SELECT count(*) AS n FROM frames').get()!.n),selected_rows:0,legacy_rows:0,files:[],native_refs:[],legacy_policy:'Legacy original bytes are retained. Run the existing provenance-bound importer on the staging copy before acceptance. This transport never invents native identities. capture_refs revocations are preserved.'};
    const rows=db.prepare('SELECT * FROM frames WHERE captured_ms>=? AND captured_ms<=? AND owner_delete=0 ORDER BY id').all(start,end);
    for(const row of rows){
      if(row.raw_ref||row.archive_revision){check(row.raw_ref&&row.archive_revision,'VISUAL_NATIVE_REFERENCE_INCOMPLETE');
        receipt.native_refs.push({raw_ref:String(row.raw_ref),archive_revision:String(row.archive_revision)});}
      else{check(row.original,'VISUAL_LEGACY_ORIGINAL_REQUIRED');receipt.legacy_rows++;}
    }
    await checkReferences(dest,receipt.native_refs);
    await fs.mkdir(join(dest,'frames'),{mode:0o700});const seen=new Set<string>();
    for(const row of rows)for(const field of ['original','thumbnail']){
      const path=String(row[field]??'');if(!path||seen.has(path))continue;
      let bytes:Uint8Array;
      try{bytes=await sourceFile(source,path);}catch(e){
        if(!absent(e)||field!=='original'||!row.cold_ref||row.cold_confirmed!==1)throw e;
        check(remote,'VISUAL_COLD_CONFIG_REQUIRED');bytes=await remote!.download(String(row.cold_ref));
      }
      check(/^frames\/[a-zA-Z0-9_-]+(?:-thumb)?\.jpg$/u.test(path),'VISUAL_SNAPSHOT_PATH_UNSAFE');
      await fs.writeFile(join(dest,path),bytes,{flag:'wx',mode:0o600});seen.add(path);receipt.files.push({path,size:bytes.length});
    }
    db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');
    try{
      const dropVector=db.prepare('DELETE FROM vectors WHERE rowid=?'),dropPeople=db.prepare('DELETE FROM frame_people WHERE frame_key=?');
      for(const row of db.prepare('SELECT id,frame_key FROM frames WHERE captured_ms<? OR captured_ms>? OR owner_delete<>0').all(start,end)){
        dropVector.run(BigInt(row.id as number));dropPeople.run(row.frame_key!);
      }
      db.prepare('DELETE FROM frames WHERE captured_ms<? OR captured_ms>? OR owner_delete<>0').run(start,end);
      // A staging clone must never later contact the production legacy deletion queue.
      db.exec('DELETE FROM cold_deletes;COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    receipt.selected_rows=rows.length;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE');db.close();
    await fs.writeFile(join(dest,'visual-inventory.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
    await verifyVisual(dest);return receipt;
  }finally{if(db.isOpen)db.close();await remote?.close();await fs.rm(scratch,{recursive:true,force:true});}
}
export async function assertVisualReady(dest:string){
  try{await fs.lstat(dest);}catch(error){if(absent(error))return {legacy_rows:0,absent:true};throw error;}
  const db=database(join(dest,'visual.sqlite'),true);
  try{const count=Number(db.prepare('SELECT count(*) AS n FROM frames WHERE raw_ref IS NULL OR archive_revision IS NULL').get()!.n);
    check(count===0,'VISUAL_LEGACY_IMPORT_REQUIRED: run the existing provenance-bound importer on staging before acceptance');
    return {legacy_rows:count};
  }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [mode,...argv]=process.argv.slice(2),args=Object.fromEntries(Array.from({length:argv.length/2},(_,i)=>[argv[2*i],argv[2*i+1]]));
  check(['export','verify','ready'].includes(mode)&&args['--dest'],'Expected export --source ROOT --dest ROOT --as-of ISO [--config FILE], verify --dest ROOT, or ready --dest ROOT');
  if(mode==='ready')console.log(JSON.stringify(await assertVisualReady(args['--dest'])));
  else{const receipt=mode==='verify'?await verifyVisual(args['--dest']):await exportVisual(args['--source'],args['--dest'],args['--as-of'],args['--config']?await readColdConfig(args['--config']):undefined);
    console.log(JSON.stringify({source_rows:receipt.source_rows,selected_rows:receipt.selected_rows,legacy_rows:receipt.legacy_rows,files:receipt.files.length,absent:receipt.absent??false}));}
}
