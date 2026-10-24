import {promises as fs,type Stats} from 'node:fs';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../src/contracts.ts';
import type {StreamBudget} from '../src/stream-archive.ts';

type Json=Record<string,any>;
type Ref={namespace:string;key:string};
interface InventoryRow extends Ref {id:number;path:string;data:string;content:string;owners:number}
export interface DiskStats {files:number;inodes:number;logical_bytes:number;allocated_bytes:number}
export interface SessionPlan {raw_ref:string;closed_by:string[];issues:string[];records:Ref[];budget:StreamBudget}
export interface ConversionPlan {sessions:SessionPlan[];retained:string[];pending:string[];before:DiskStats}
const rawPattern=/^l5:[a-f0-9]{64}$/u,keyPattern=/^[a-f0-9]{64}$/u;
const foldNamespaces=new Set(['stream-revisions','media-postarchive-admissions','audio-consumer-attempts','audio-consumer-accepted',
  'audio-consumer-results','audio-consumer-not-accepted','audio-consumer-routes','audio-consumer-spans','audio-consumer-d',
  'media-source-progress','media-detection-epochs','media-detection-finished','media-source-failures','media-continuous-candidates',
  'media-continuous-admitted','media-continuous-attempts','media-continuous-selection','media-views','media-vad-selections',
  'processed-media-inputs','processed-media','session-ends','media-derivations','derivation-attempts']);

async function scratch<T>(work:(db:DatabaseSync)=>Promise<T>):Promise<T>{
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-session-discovery-'));
  const db=new DatabaseSync(join(directory,'inventory.sqlite'));
  try{db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768;
    CREATE TABLE inodes(dev TEXT,ino TEXT,size INTEGER,allocated INTEGER,PRIMARY KEY(dev,ino)) WITHOUT ROWID;`);
    return await work(db);
  }finally{db.close();await fs.rm(directory,{recursive:true,force:true});}
}
async function walk(root:string,visit:(path:string,stat:Stats)=>Promise<void>){
  const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('UNSAFE_CONVERTER_ROOT');
  const descend=async(path:string):Promise<void>=>{const directory=await fs.opendir(path);
    for await(const entry of directory){const child=join(path,entry.name),detail=await fs.lstat(child);await visit(child,detail);
      if(detail.isDirectory()&&!detail.isSymbolicLink())await descend(child);}
  };await descend(root);
}
function inodeCounter(db:DatabaseSync){
  const insert=db.prepare('INSERT OR IGNORE INTO inodes VALUES(?,?,?,?)');let files=0;
  return {add(stat:Stats){if(stat.isFile()){files++;insert.run(String(stat.dev),String(stat.ino),stat.size,stat.blocks*512);}},
    result():DiskStats{const row=db.prepare('SELECT COUNT(*) AS inodes,COALESCE(SUM(size),0) AS logical_bytes,COALESCE(SUM(allocated),0) AS allocated_bytes FROM inodes').get()!;
      return {files,inodes:Number(row.inodes),logical_bytes:Number(row.logical_bytes),allocated_bytes:Number(row.allocated_bytes)};}};
}
/** Physical allocation uses unique dev:ino, so hard-link aliases never invent freed bytes. */
export async function measureDisk(root:string):Promise<DiskStats>{return scratch(async db=>{
  const count=inodeCounter(db);db.exec('BEGIN');await walk(root,async(_path,stat)=>count.add(stat));db.exec('COMMIT');return count.result();
});}
function relations(value:unknown,refs:Set<string>,tokens:Set<string>,field=''){
  if(Array.isArray(value)){for(const item of value)relations(item,refs,tokens,field);return;}
  if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value))relations(item,refs,tokens,key);return;}
  if(typeof value!=='string')return;
  if(field==='raw_ref'&&rawPattern.test(value))refs.add(value);
  if(['key','attempt_key'].includes(field)&&keyPattern.test(value))tokens.add(`key:${value}`);
  if(['owner','detection_epoch','processed_event_id','processed_event_ids'].includes(field))tokens.add(`${field==='processed_event_ids'?'processed_event_id':field}:${value}`);
}
function setup(db:DatabaseSync){db.exec(`
  CREATE TABLE files(id INTEGER PRIMARY KEY,namespace TEXT,key TEXT,path TEXT,kind TEXT,data TEXT,content TEXT);
  CREATE INDEX files_kind ON files(kind);
  CREATE INDEX files_ref ON files(namespace,key);
  CREATE TABLE tokens(token TEXT,file INTEGER,PRIMARY KEY(token,file)) WITHOUT ROWID;
  CREATE INDEX tokens_file ON tokens(file);
  CREATE TABLE owners(file INTEGER,ref TEXT,PRIMARY KEY(file,ref)) WITHOUT ROWID;
  CREATE INDEX owners_ref ON owners(ref,file);
  CREATE TABLE known_objects(key TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE session_objects(ref TEXT,key TEXT,PRIMARY KEY(ref,key)) WITHOUT ROWID;
`);}
/** Stream source files once. The temporary graph and inode inventory live outside the source tree. */
export async function discoverSessions(root:string,closedRefs:string[]=[]):Promise<ConversionPlan>{
  for(const ref of closedRefs)if(!rawPattern.test(ref))throw new Error(`INVALID_CLOSED_REF:${ref}`);
  return scratch(async db=>{
    setup(db);const count=inodeCounter(db),insert=db.prepare('INSERT INTO files(namespace,key,path,kind,data,content) VALUES(?,?,?,?,?,?)');
    const token=db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?)'),owner=db.prepare('INSERT OR IGNORE INTO owners VALUES(?,?)');
    const object=db.prepare('INSERT OR IGNORE INTO known_objects VALUES(?)'),sessionObject=db.prepare('INSERT OR IGNORE INTO session_objects VALUES(?,?)');let batch=0;
    db.exec('BEGIN');await walk(root,async(path,stat)=>{
      count.add(stat);if(stat.isDirectory())return;
      const name=relative(root,path),parts=name.split('/'),namespace=parts[0]!,key=parts[1]??'';
      if(++batch%4096===0)db.exec('COMMIT; BEGIN');
      if(parts.at(-1)!.startsWith('.pending-')){insert.run(namespace,key,name,'pending','','');return;}
      if(!stat.isFile()||parts.length!==2||!keyPattern.test(key)||!/^[a-z][a-z0-9-]{0,40}$/u.test(namespace)){insert.run(namespace,key,name,'retained','','');return;}
      if(namespace==='objects'){insert.run(namespace,key,name,'raw','','');return;}
      const bytes=await fs.readFile(path);let value:Json;
      try{value=JSON.parse(bytes.toString());}catch{insert.run(namespace,key,name,'retained','','');return;}
      if(!value||typeof value!=='object'){insert.run(namespace,key,name,'retained','','');return;}
      const refs=new Set<string>(),tokens=new Set([`key:${key}`]);relations(value,refs,tokens);
      const capture=value.record;
      if(namespace==='raw-ingress'&&capture?.kind==='stream'&&capture.raw?.event_id&&capture.trusted?.principal_id&&capture.raw?.device_id)
        refs.add(`l5:${digest({event_id:capture.raw.event_id,principal_id:capture.trusted.principal_id,device_id:capture.raw.device_id})}`);
      if(namespace==='audio-consumer-routes'&&['principal_id','device_id','source_scope','capture_span'].every(field=>typeof value[field]==='string'))
        tokens.add(`key:${digest([value.principal_id,value.device_id,value.source_scope,value.capture_span])}`);
      const chunks:Json[]=namespace==='stream-revisions'?(value.chunk?[value.chunk]:Array.isArray(value.chunks)?value.chunks:[]):[];
      const chunk_stats={count:chunks.length,total_bytes:chunks.reduce((sum,c)=>sum+(Number(c.bytes)||0),0),
        max_bytes:chunks.reduce((max,c)=>Math.max(max,Number(c.bytes)||0),1),max_seq:chunks.reduce((max,c)=>Math.max(max,Number(c.seq)||0),1),audio:chunks.some(c=>c.modality==='audio')};
      const summary={schema:value.schema,raw_ref:value.raw_ref,revision:value.revision,detection_epoch:value.detection_epoch,
        total_bytes:value.total_bytes,chunk_stats};
      const id=Number(insert.run(namespace,key,name,'record',JSON.stringify(summary),namespace==='stream-revisions'?digest(value):'').lastInsertRowid);
      for(const ref of refs)owner.run(id,ref);for(const name of tokens)token.run(name,id);
      for(const chunk of chunks)if(typeof chunk.object_hash==='string'){
        object.run(chunk.object_hash);if(rawPattern.test(value.raw_ref))sessionObject.run(value.raw_ref,chunk.object_hash);
      }
    });db.exec('COMMIT');
    // Tokens encode only producer-owned keys, attempt owners, processed ids and detection epochs.
    const propagate=db.prepare(`INSERT OR IGNORE INTO owners
      SELECT neighbor.file,edge.ref FROM (SELECT DISTINCT token.token,owned.ref FROM owners owned JOIN tokens token ON token.file=owned.file) edge
      JOIN tokens neighbor ON neighbor.token=edge.token`);
    while(propagate.run().changes){}
    const refs=new Set<string>(closedRefs);for(const row of db.prepare('SELECT DISTINCT ref FROM owners').iterate())refs.add(String(row.ref));
    const finished=new Set<string>();for(const row of db.prepare("SELECT data FROM files WHERE namespace='media-detection-finished' AND kind='record'").iterate()){
      const epoch=JSON.parse(String(row.data)).detection_epoch;if(typeof epoch==='string')finished.add(epoch);
    }
    const owned=db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM owners peers WHERE peers.file=f.id) AS owners
      FROM owners o JOIN files f ON f.id=o.file WHERE o.ref=? ORDER BY f.namespace,f.key`);
    const missingObjects=db.prepare(`SELECT o.key FROM session_objects o LEFT JOIN files f ON f.namespace='objects' AND f.key=o.key AND f.kind='raw' WHERE o.ref=? AND f.id IS NULL`);
    const objectRefs=db.prepare("SELECT 'objects' AS namespace,key FROM session_objects WHERE ref=? ORDER BY key");
    const sessions:SessionPlan[]=[];
    for(const raw_ref of [...refs].sort()){
      const rows=owned.all(raw_ref) as unknown as InventoryRow[];
      const records=rows.map(row=>({...row,value:JSON.parse(row.data) as Json})),closed_by:string[]=[],issues:string[]=[];
      if(closedRefs.includes(raw_ref))closed_by.push('operator --closed-ref');
      if(records.some(r=>r.namespace==='session-ends'&&r.key===raw_ref.slice(3)&&r.value.raw_ref===raw_ref&&r.value.schema==='paios.session.end.v1'))closed_by.push('session-ends');
      const epochs=new Set(records.filter(r=>r.namespace==='media-detection-epochs'&&r.value.raw_ref===raw_ref).map(r=>r.value.detection_epoch));
      if(epochs.size&&[...epochs].every(epoch=>typeof epoch==='string'&&finished.has(epoch)))closed_by.push('media-detection-finished + media-detection-epochs');
      if(records.some(r=>r.owners>1))issues.push('metadata ownership is ambiguous');
      if(records.some(r=>r.namespace==='raw-ingress'))issues.push('pending raw ingress');
      const revisions=records.filter(r=>r.namespace==='stream-revisions'),byKey=new Map(revisions.map(r=>[r.key,r]));
      if(revisions.some(r=>!['paios.stream.v1','paios.stream.delta.v2'].includes(r.value.schema)||!Number.isSafeInteger(r.value.revision)||r.value.revision<1))issues.push('unknown or invalid stream revision');
      const maxRevision=revisions.reduce((max,r)=>Math.max(max,Number(r.value.revision)||0),0);
      if(!maxRevision)issues.push('no stream revisions');
      if(maxRevision>revisions.length)issues.push('stream revision sequence has missing aliases');
      else for(let n=1;n<=maxRevision;n++)if(!byKey.has(digest([raw_ref,n])))issues.push(`missing stream sequence alias ${n}`);
      for(const record of revisions){const alias=byKey.get(digest([raw_ref,record.value.revision]));
        if(alias&&alias.content!==record.content)issues.push(`uncommitted/conflicting stream proposal ${record.key}`);
        if(record.value.schema==='paios.stream.delta.v2'&&!byKey.has(record.content))issues.push(`missing stream content alias ${record.key}`);
      }
      if(revisions.some(r=>r.value.chunk_stats.count)&&!revisions.some(r=>r.value.chunk_stats.audio))issues.push('no audio; video consolidation not implemented');
      for(const row of missingObjects.iterate(raw_ref))issues.push(`missing hot raw object ${row.key}`);
      const budget={max_chunk_bytes:revisions.reduce((max,r)=>Math.max(max,r.value.chunk_stats.max_bytes),1),
        max_total_bytes:revisions.reduce((max,r)=>Math.max(max,Number(r.value.total_bytes)||r.value.chunk_stats.total_bytes),1),
        max_chunks:revisions.reduce((max,r)=>Math.max(max,r.value.chunk_stats.count),Math.max(1,maxRevision)),
        max_revisions:Math.max(1,maxRevision),max_seq:revisions.reduce((max,r)=>Math.max(max,r.value.chunk_stats.max_seq),1)};
      sessions.push({raw_ref,closed_by,issues:[...new Set(issues)],records:[...records.filter(r=>r.owners===1&&foldNamespaces.has(r.namespace)).map(({namespace,key})=>({namespace,key})),
        ...objectRefs.all(raw_ref) as unknown as Ref[]],budget});
    }
    const retained=new Set<string>();for(const row of db.prepare(`SELECT path FROM files f WHERE kind='retained' OR namespace='raw-ingress'
      OR(kind='record' AND (SELECT COUNT(*) FROM owners o WHERE o.file=f.id)<>1)
      OR(kind='raw' AND NOT EXISTS(SELECT 1 FROM known_objects k WHERE k.key=f.key)) ORDER BY path`).iterate())retained.add(String(row.path));
    const pending=db.prepare("SELECT path FROM files WHERE kind='pending' ORDER BY path").all().map(row=>String(row.path));
    for(const row of db.prepare("SELECT namespace,path FROM files WHERE kind='record' AND (SELECT COUNT(*) FROM owners WHERE file=files.id)=1 ORDER BY path").iterate())
      if(!foldNamespaces.has(String(row.namespace)))retained.add(String(row.path));
    return {sessions,retained:[...retained].sort(),pending,before:count.result()};
  });
}
