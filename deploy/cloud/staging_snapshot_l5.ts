/** Frozen-source L5 transport. Archive owners retain identity, revision and byte validation. */
import {constants,promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/archive.ts';
import {requireRawAvailable,streamManifestRevision} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/stream-archive.ts';
import {check,digest} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import type {ColdConfig} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/cold-storage.ts';
import {prepareSessionIndex,transferSession,verifySession,type SessionStorage} from './staging_snapshot_sessions.ts';

const namespaces=['manifests','stream-revisions','quarantine-manifests'];
const budget={max_chunk_bytes:64*1024*1024,max_total_bytes:Number.MAX_SAFE_INTEGER,max_chunks:1000000,max_revisions:1000000,max_seq:Number.MAX_SAFE_INTEGER};
const MAX_RECEIPT_ITEMS=20000,MAX_LANE_ROWS=4096;
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const json=(bytes:Uint8Array)=>JSON.parse(Buffer.from(bytes).toString('utf8'));
type Item={namespace:string;key:string;size:number};
type Source={ref:string;principal:string;revision:string;kind:string;revisions?:string[]};
type Receipt={schema:string;as_of:string;since:string;files:Item[];sources:Source[];excluded_history:{ref:string;received_at:string}[];excluded_history_count:number;uncommitted_proposals:number;revoked_refs:number;external_attachments:unknown[];closure_policy:string};
/** PosixStorage's ordinary reads mkdir namespaces. This read-only facade never touches source metadata. */
class FrozenStorage extends PosixStorage {
  readonly source:string;readonly scratch:string;
  constructor(source:string,scratch:string,cold?:ColdConfig){super(scratch,{cold});this.source=resolve(source);this.scratch=scratch;}
  async *keys(namespace:string){
    const path=join(this.scratch,'snapshot-keys.sqlite'),index=new DatabaseSync(path);
    index.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; PRAGMA max_page_count=262144; CREATE TABLE IF NOT EXISTS keys(namespace TEXT,key TEXT,PRIMARY KEY(namespace,key))');
    const insert=index.prepare('INSERT OR IGNORE INTO keys VALUES(?,?)');
    try{
      for await(const key of this.hotKeys(namespace))insert.run(namespace,key);
      for(const [name,query] of [['cold.sqlite','SELECT key FROM locations WHERE namespace=?'],
        ['session-records.sqlite',namespace==='session-finals'?'SELECT id AS key FROM sessions':'SELECT key FROM refs WHERE namespace=?']]){
        try{await fs.access(join(this.scratch,name));}catch(error){if(absent(error))continue;throw error;}
        const native=new DatabaseSync(join(this.scratch,name),{readOnly:true});
        try{for(const row of native.prepare(query).iterate(...(query.includes('?')?[namespace]:[])))insert.run(namespace,String(row.key));}
        finally{native.close();}
      }
      for(const row of index.prepare('SELECT key FROM keys WHERE namespace=? ORDER BY key').iterate(namespace))yield String(row.key);
    }finally{index.close();}
  }
  override async readHot(namespace:string,key:string){
    check(/^[a-z][a-z0-9-]{0,40}$/u.test(namespace)&&/^[a-f0-9]{64}$/u.test(key),'UNSAFE_SNAPSHOT_KEY');
    const directory=join(this.source,namespace),stat=await fs.lstat(directory);
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_SNAPSHOT_NAMESPACE');
    const handle=await fs.open(join(directory,key),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{check((await handle.stat()).isFile(),'UNSAFE_SNAPSHOT_OBJECT');return await handle.readFile();}finally{await handle.close();}
  }
  override async *hotKeys(namespace:string){
    check(/^[a-z][a-z0-9-]{0,40}$/u.test(namespace),'UNSAFE_SNAPSHOT_NAMESPACE');
    const directory=join(this.source,namespace);let stat;
    try{stat=await fs.lstat(directory);}catch(e){if(absent(e))return;throw e;}
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_SNAPSHOT_NAMESPACE');
    for await(const entry of await fs.opendir(directory)){
      if(entry.name.startsWith('.pending-'))continue;
      check(/^[a-f0-9]{64}$/u.test(entry.name)&&entry.isFile()&&!entry.isSymbolicLink(),'UNSAFE_SNAPSHOT_OBJECT');yield entry.name;
    }
  }
}
async function validate(root:string,receipt:Receipt){
  check(receipt.schema==='paios.staging.l5.v1','L5_INVENTORY_SCHEMA');
  const scratch=await fs.mkdtemp(join(tmpdir(),'staging-l5-read-'));
  const disk=new FrozenStorage(root,scratch),archive=new RawArchive(disk,budget.max_chunk_bytes,undefined,budget);
  try{
    const indexed=await prepareSessionIndex(root,scratch);
    check(!indexed||(disk as SessionStorage).readFinal,'SESSION_NATIVE_READER_REQUIRED');
    if(indexed)for await(const key of disk.keys('session-finals')){
      check(receipt.files.some(f=>f.namespace==='session-finals'&&f.key===key),'L5_FINAL_INVENTORY_MISSING');
      await verifySession(disk,`l5:${key}`);
    }
    const seen=new Set<string>();
    for(const item of receipt.files){const id=`${item.namespace}/${item.key}`;
      check(!seen.has(id),'L5_INVENTORY_DUPLICATE');seen.add(id);
      check(/^[a-z][a-z0-9-]{0,40}$/u.test(item.namespace),'L5_INVENTORY_NAMESPACE');
      const bytes=await disk.read(item.namespace,item.key);check(bytes.length===item.size,'L5_INVENTORY_INTEGRITY');
      if(item.namespace==='source-clock-bases'){const basis=json(bytes);check(digest(basis)===item.key,'MEDIA_CLOCK_BASIS_DENIED');
        if(basis.anchor_ref)await disk.read('source-clock-bases',basis.anchor_ref.slice(13));}}
    for(const source of receipt.sources){
      if(source.kind==='quarantine'){await archive.readUnknownClock(source.ref,source.principal,source.revision);continue;}
      const record=await archive.readRecord(source.ref,source.principal,source.revision,{proof_only:true});
      if(record.kind==='stream')for(const chunk of record.manifest.chunks)await archive.streams.verifiedPcm(chunk);
      else await archive.read(source.ref,source.principal,source.revision);
    }
  }finally{await archive.close();await disk.close();await fs.rm(scratch,{recursive:true,force:true});}
  return receipt;
}
export async function verifyL5(dest:string){return validate(dest,JSON.parse(await fs.readFile(join(dest,'l5-inventory.json'),'utf8')));}
export async function readColdConfig(path:string):Promise<ColdConfig|undefined>{
  const cold=JSON.parse(await fs.readFile(path,'utf8')).archive_tiering?.cold;
  return cold?JSON.parse(JSON.stringify(cold).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gu,(_,key)=>{
    check(process.env[key]!==undefined,`CONFIG_ENV_REQUIRED:${key}`);return process.env[key]!;})):undefined;
}
export async function exportL5(source:string,dest:string,asOf:string,cold?:ColdConfig){
  const end=Date.parse(asOf),start=end-48*3600000;check(Number.isFinite(end),'INVALID_SNAPSHOT_AS_OF');
  source=resolve(source);dest=resolve(dest);check(dest!==source&&!dest.startsWith(source+'/')&&!source.startsWith(dest+'/'),'SNAPSHOT_SOURCE_OVERLAP');
  check((await fs.lstat(source)).isDirectory()&&!(await fs.lstat(source)).isSymbolicLink(),'UNSAFE_SNAPSHOT_ROOT');
  await fs.mkdir(dest,{recursive:true,mode:0o700});
  check((await fs.readdir(dest)).length===0,'L5_DESTINATION_NOT_EMPTY');
  const scratch=await fs.mkdtemp(join(dest,'.cold-read-'));
  let disk:FrozenStorage|undefined,archive:RawArchive|undefined,index:DatabaseSync|undefined;
  const receipt:Receipt={schema:'paios.staging.l5.v1',as_of:new Date(end).toISOString(),since:new Date(start).toISOString(),files:[],sources:[],excluded_history:[],excluded_history_count:0,uncommitted_proposals:0,revoked_refs:0,external_attachments:[],
    closure_policy:'Any received_at in [since,as_of] selects the complete original or stream chain, including older parents and all objects. Other historical consumer references are intentionally unavailable. excluded_history is a sample of at most 128 refs; excluded_history_count is exact. External attachment paths and legacy visual originals are outside native L5.'};
  try{
    try{const path=join(source,'cold.sqlite'),stat=await fs.lstat(path);check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_COLD_INDEX');
      // Even SQLite readOnly connections can create WAL sidecars. Open only a frozen copied index.
      for(const suffix of ['','-wal','-shm'])try{
        const from=path+suffix,s=await fs.lstat(from);check(s.isFile()&&!s.isSymbolicLink(),'UNSAFE_COLD_INDEX');await fs.copyFile(from,join(scratch,'cold.sqlite'+suffix));
      }catch(e){if(!suffix||!absent(e))throw e;}
      const db=new DatabaseSync(join(scratch,'cold.sqlite'));try{check(cold||Number(db.prepare('SELECT count(*) AS n FROM locations').get()!.n)===0,'COLD_CONFIG_REQUIRED');}finally{db.close();}
    }catch(e){if(!absent(e))throw e;}
    const indexed=await prepareSessionIndex(source,scratch);
    disk=new FrozenStorage(source,scratch,cold);archive=new RawArchive(disk,budget.max_chunk_bytes,undefined,budget);
    check(!indexed||(disk as SessionStorage).readFinal,'SESSION_NATIVE_READER_REQUIRED');
    for await(const key of disk.keys('raw-ingress'))check(!key,'RAW_INGRESS_PENDING: native capture recovery must finish before a windowed snapshot');
    index=new DatabaseSync(join(scratch,'snapshot-groups.sqlite'));
    index.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; PRAGMA max_page_count=262144; CREATE TABLE rows(ref TEXT,namespace TEXT,key TEXT,received_at TEXT,recent INTEGER); CREATE INDEX by_ref ON rows(ref); CREATE TABLE copied(id TEXT PRIMARY KEY)');
    const insert=index.prepare('INSERT INTO rows VALUES(?,?,?,?,?)'),copied=index.prepare('SELECT id FROM copied WHERE id=?');
    const put=async(namespace:string,key:string,bytes?:Uint8Array)=>{
      const id=`${namespace}/${key}`;if(copied.get(id))return;
      check(receipt.files.length<MAX_RECEIPT_ITEMS,'L5_RECEIPT_BUDGET_EXCEEDED');
      const data=bytes??await disk!.read(namespace,key);await fs.mkdir(join(dest,namespace),{recursive:true,mode:0o700});
      await fs.writeFile(join(dest,namespace,key),data,{flag:'wx',mode:0o600});index!.prepare('INSERT INTO copied VALUES(?)').run(id);
      receipt.files.push({namespace,key,size:data.length});
      if(namespace==='source-clock-bases'){const basis=json(data);check(digest(basis)===key,'MEDIA_CLOCK_BASIS_DENIED');
        if(basis.anchor_ref)await put(namespace,basis.anchor_ref.slice(13));}
    };
    for(const namespace of namespaces)for await(const key of disk.keys(namespace)){
      const record=json(await disk.read(namespace,key));
      check(namespace==='manifests'?record.schema_version==='paios.archive.v1':namespace==='quarantine-manifests'?record.schema==='paios.unknown-clock-original.v1':
        ['paios.stream.delta.v2','paios.stream.v1'].includes(record.schema),'UNSUPPORTED_L5_MANIFEST');
      const ref=namespace==='manifests'?`l5:${key}`:namespace==='quarantine-manifests'?record.quarantine_ref:record.raw_ref;
      const times=namespace==='stream-revisions'?(record.chunk?[record.chunk.received_at]:record.chunks.map((c:any)=>c.received_at)):[record.event.received_at];
      check(times.length>0&&times.every((t:string)=>Number.isFinite(Date.parse(t))),'INVALID_L5_RECEIVED_AT');
      insert.run(ref,namespace,key,record.event.received_at,Number(times.some((t:string)=>Date.parse(t)>=start&&Date.parse(t)<=end)));
    }
    for(const group of index.prepare('SELECT ref,min(received_at) AS received_at,max(recent) AS recent FROM rows GROUP BY ref').iterate()){
      const ref=String(group.ref);
      if(!group.recent){receipt.excluded_history_count++;if(receipt.excluded_history.length<128)receipt.excluded_history.push({ref,received_at:String(group.received_at)});continue;}
      const rows=index.prepare('SELECT namespace,key,received_at FROM rows WHERE ref=? LIMIT ?').all(ref,MAX_LANE_ROWS+1) as unknown as {namespace:string;key:string;received_at:string}[];
      check(rows.length<=MAX_LANE_ROWS,'L5_LANE_BUDGET_EXCEEDED');
      try{await requireRawAvailable(disk,ref);}catch(error){
        if((error as {code?:string}).code!=='RAW_DELETED')throw error;
        receipt.revoked_refs++;continue;
      }
      const first=rows[0],r=json(await disk.read(first.namespace,first.key));let principal=r.event.principal_id,revision=r.archive_revision,chosen=rows;
      if(first.namespace==='stream-revisions'){
        const aliases=new Set<string>(),recent=new Set<string>();
        for(const row of rows){const record=json(await disk.read(row.namespace,row.key));
          if(row.key===digest([ref,record.revision]))aliases.add(row.key);
          else check(row.key===digest(record),'L5_INVALID_STREAM_PROPOSAL');
          const times=record.chunk?[record.chunk.received_at]:record.chunks.map((c:any)=>c.received_at);
          if(times.some((t:string)=>Date.parse(t)>=start&&Date.parse(t)<=end))recent.add(row.key);
        }
        // Publishing content precedes the winning ordinal alias; a losing proposal is not committed history.
        if(!aliases.size){receipt.uncommitted_proposals+=rows.length;continue;}
        const head=await archive.streams.head(ref);check(head,'L5_STREAM_HEAD_MISSING');revision=streamManifestRevision(head!);
        principal=head!.event.principal_id;
        // A disconnected revision or a missing slot must not disappear behind the reader's contiguous prefix.
        const committed=new Set<string>();for(let n=1;n<=head!.revision;n++){
          const entry=head!.journal?.[n-1]??await archive.streams.revision(ref,n);
          committed.add(digest(entry));committed.add(digest([ref,n]));
        }
        check([...aliases].every(key=>committed.has(key)),'L5_DANGLING_STREAM_REVISION');
        chosen=rows.filter(row=>committed.has(row.key));receipt.uncommitted_proposals+=rows.length-chosen.length;
        if(!chosen.some(row=>recent.has(row.key))){receipt.excluded_history_count++;if(receipt.excluded_history.length<128)receipt.excluded_history.push({ref,received_at:first.received_at});continue;}
      }
      const target=new PosixStorage(dest);
      let final;
      try{final=first.namespace==='stream-revisions'?await transferSession(disk,target,ref,put):false;}
      finally{await target.close();}
      const folded=new Set(final?final.records.map(r=>`${r.namespace}/${r.key}`):[]);
      if(final)receipt.files.push({namespace:'session-finals',key:ref.slice(3),size:(await disk.read('session-finals',ref.slice(3))).length});
      receipt.sources.push({ref,principal,revision,kind:first.namespace==='quarantine-manifests'?'quarantine':first.namespace==='manifests'?'original':'stream',
        ...(first.namespace==='stream-revisions'?{revisions:chosen.map(r=>r.key)}:{})});
      for(const {namespace,key} of chosen){const record=json(await disk.read(namespace,key));if(!folded.has(`${namespace}/${key}`))await put(namespace,key);
        if(!final)for(const hash of namespace==='stream-revisions'?(record.chunk?[record.chunk.object_hash]:record.chunks.map((c:any)=>c.object_hash)):[record.payload_sha256])await put('objects',hash);
        for(const c of record.chunk?[record.chunk]:record.chunks??[])if(c.clock_basis_ref)await put('source-clock-bases',c.clock_basis_ref.slice(13));
        if(record.event.source.capture_timing)await put('source-clock-bases',record.event.source.capture_timing.basis_ref.slice(13));
        if(record.event.attachments?.length)receipt.external_attachments.push(...record.event.attachments);
      }
    }
    for await(const key of disk.keys('owner-deletions'))await put('owner-deletions',key);
    receipt.files.sort((a,b)=>`${a.namespace}/${a.key}`.localeCompare(`${b.namespace}/${b.key}`));
    await validate(dest,receipt);
    await fs.writeFile(join(dest,'l5-inventory.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
  }finally{index?.close();await archive?.close();await disk?.close();await fs.rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [mode,...argv]=process.argv.slice(2),args=Object.fromEntries(Array.from({length:argv.length/2},(_,i)=>[argv[i*2],argv[i*2+1]]));
  check(args['--dest']&&['export','verify'].includes(mode),'Expected export --source ROOT --dest ROOT --as-of ISO [--config FILE], or verify --dest ROOT');
  let cold:ColdConfig|undefined;
  if(args['--config'])cold=await readColdConfig(args['--config']);
  const receipt=mode==='verify'?await verifyL5(args['--dest']):await exportL5(args['--source'],args['--dest'],args['--as-of'],cold);
  console.log(JSON.stringify({schema:receipt.schema,sources:receipt.sources.length,files:receipt.files.length,excluded_history:receipt.excluded_history_count??receipt.excluded_history.length}));
}
