import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {configureSqlite,openReadOnlySnapshot} from './owner-db.ts';
import {gzipSync,gunzipSync} from 'node:zlib';
import {canonical,check} from './contracts.ts';

export interface SessionRecordRef {namespace:string;key:string}
export interface CallAudioTrack {call_id:string;principal_id:string;track:'pre_call_ambient'|'microphone'|'assistant_reply'}
const validateCall=(call:CallAudioTrack)=>check(typeof call.call_id==='string'&&call.call_id.length>0&&typeof call.principal_id==='string'&&call.principal_id.length>0&&['pre_call_ambient','microphone','assistant_reply'].includes(call.track),'INVALID_CALL_AUDIO_TRACK');
export interface FinalSession {
  schema:'paios.session.final.v1';raw_ref:string;object_hash:string;bytes:number;
  records:(SessionRecordRef&{bytes:string})[];
  objects:{key:string;offset:number;bytes:number}[];
  retained_objects?:{key:string;format:string}[];
  ended_by:string;call?:CallAudioTrack;
}
export interface FoldedObject {object_hash:string;offset:number;bytes:number}
interface SessionRow {record:Uint8Array;object_hash:string;created:number}
interface RefRow {session:string;record_index:number|null;offset:number|null;bytes:number|null}
const keyPattern=/^[a-f0-9]{64}$/u,namespacePattern=/^[a-z][a-z0-9-]{0,40}$/u;
const sessionId=(rawRef:string)=>{check(/^l5:[a-f0-9]{64}$/u.test(rawRef),'INVALID_SESSION_REFERENCE');return rawRef.slice(3);};
const validateRef=(ref:SessionRecordRef)=>check(namespacePattern.test(ref.namespace)&&keyPattern.test(ref.key),'INVALID_SESSION_RECORD_REFERENCE');

/** The final session is the sole metadata authority; routes contain positions, never payload copies. */
export class SessionRecords {
  private readonly readOnly:boolean;
  private closeSnapshot:(()=>void)|undefined;
  private db:DatabaseSync|undefined;
  private opening:Promise<DatabaseSync|undefined>|undefined;
  private readonly root:string;private readonly prepareRoot:(create:boolean)=>Promise<void>;
  private readonly decoded=new Map<string,{record:FinalSession;size:number}>();private decodedBytes=0;
  constructor(root:string,prepareRoot:(create:boolean)=>Promise<void>,readOnly=false){this.readOnly=readOnly;this.root=root;this.prepareRoot=prepareRoot;}
  private async index(create=false,write=create):Promise<DatabaseSync|undefined>{
    check(!write||!this.readOnly,'STORAGE_READ_ONLY');
    if(this.db)return this.db;
    if(this.opening){await this.opening;return this.index(create,write);}
    this.opening=(async()=>{
      // A read never creates the storage root: an absent root holds no session records.
      try{await this.prepareRoot(create);}catch(error){if(create||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return undefined;}
      const path=join(this.root,'session-records.sqlite');
      for(const suffix of ['', '-wal', '-shm'])try{
        const stat=await fs.lstat(path+suffix);check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(!suffix&&!create)return undefined;}
      // Read-only access opens a private byte copy: a readOnly connection on the source can still create or touch WAL/SHM.
      if(this.readOnly){const snapshot=openReadOnlySnapshot(path);this.db=snapshot.db;this.closeSnapshot=snapshot.close;return this.db;}
      const db=new DatabaseSync(path);
      try{await fs.chmod(path,0o600);configureSqlite(db);db.exec(`
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,record BLOB NOT NULL,object_hash TEXT NOT NULL,created INTEGER NOT NULL,cleaned INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS refs(namespace TEXT NOT NULL,key TEXT NOT NULL,session TEXT NOT NULL,record_index INTEGER,offset INTEGER,bytes INTEGER,PRIMARY KEY(namespace,key));
        CREATE INDEX IF NOT EXISTS refs_session ON refs(session);
        CREATE TABLE IF NOT EXISTS inflight(session TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(session,namespace,key));
        CREATE INDEX IF NOT EXISTS inflight_record ON inflight(namespace,key,session);
        CREATE TABLE IF NOT EXISTS call_tracks(session TEXT PRIMARY KEY,call_id TEXT NOT NULL,principal_id TEXT NOT NULL,track TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS call_tracks_group ON call_tracks(call_id,principal_id);`);
        this.db=db;return db;
      }catch(error){db.close();throw error;}
    })();
    try{return await this.opening;}finally{this.opening=undefined;}
  }
  private decode(row:SessionRow,id:string):FinalSession{
    const cached=this.decoded.get(id);if(cached){this.decoded.delete(id);this.decoded.set(id,cached);return cached.record;}
    const bytes=gunzipSync(row.record),record=JSON.parse(bytes.toString('utf8')) as FinalSession,size=bytes.length*2;
    if(size<=64*1024*1024){while(this.decoded.size>=4||this.decodedBytes+size>64*1024*1024){const oldest=this.decoded.keys().next().value!;
      this.decodedBytes-=this.decoded.get(oldest)!.size;this.decoded.delete(oldest);}
      this.decoded.set(id,{record,size});this.decodedBytes+=size;}
    return record;
  }
  private final(db:DatabaseSync,id:string):FinalSession|null{
    const cached=this.decoded.get(id);if(cached){this.decoded.delete(id);this.decoded.set(id,cached);return cached.record;}
    const row=db.prepare('SELECT record FROM sessions WHERE id=?').get(id) as unknown as SessionRow|undefined;
    return row?this.decode(row,id):null;
  }
  async readFinal(rawRef:string):Promise<FinalSession|null>{
    const id=sessionId(rawRef),db=await this.index();if(!db)return null;
    const record=this.final(db,id);return record?structuredClone(record):null;
  }
  async read(namespace:string,key:string):Promise<Uint8Array|FoldedObject|null>{
    validateRef({namespace,key});const db=await this.index();if(!db)return null;
    if(namespace==='session-finals'){
      const record=this.final(db,key);return record?Buffer.from(canonical(record)):null;
    }
    const ref=db.prepare('SELECT session,record_index,offset,bytes FROM refs WHERE namespace=? AND key=?').get(namespace,key) as unknown as RefRow|undefined;
    if(!ref)return null;
    if(ref.record_index!==null)return Buffer.from(this.final(db,ref.session)!.records[ref.record_index]!.bytes,'base64');
    const row=db.prepare('SELECT object_hash FROM sessions WHERE id=?').get(ref.session) as unknown as SessionRow;
    return {object_hash:row.object_hash,offset:ref.offset!,bytes:ref.bytes!};
  }
  /** Bind before admission; the lookup becomes immutable final metadata at the fold commit. */
  async bindCallTrack(rawRef:string,group:CallAudioTrack):Promise<void>{
    const id=sessionId(rawRef);validateCall(group);const db=(await this.index(true))!;
    db.exec('BEGIN IMMEDIATE');try{
      const prior=this.callTrackIn(db,id);
      if(prior)check(canonical(prior)===canonical(group),'CALL_TRACK_CONFLICT',409);
      else{
        check(!this.final(db,id),'CALL_TRACK_ALREADY_FINAL',409);
        db.prepare('INSERT INTO call_tracks(session,call_id,principal_id,track) VALUES(?,?,?,?)').run(id,group.call_id,group.principal_id,group.track);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  private callTrackIn(db:DatabaseSync,id:string):CallAudioTrack|null{
    const row=db.prepare('SELECT call_id,principal_id,track FROM call_tracks WHERE session=?').get(id) as unknown as CallAudioTrack|undefined;
    return row?{...row}:null;
  }
  async callTrack(rawRef:string):Promise<CallAudioTrack|null>{
    const id=sessionId(rawRef),db=await this.index();if(!db)return null;
    const final=this.final(db,id);return final?(final.call?{...final.call}:null):this.callTrackIn(db,id);
  }
  async callTracks(callId:string,principalId:string):Promise<{raw_ref:string;track:CallAudioTrack['track'];finalized:boolean}[]>{
    check(typeof callId==='string'&&callId.length>0&&typeof principalId==='string'&&principalId.length>0,'INVALID_CALL_AUDIO_TRACK');
    const db=await this.index();if(!db)return [];
    return db.prepare(`SELECT c.session,c.track,EXISTS(SELECT 1 FROM sessions s WHERE s.id=c.session) AS finalized
      FROM call_tracks c WHERE call_id=? AND principal_id=? ORDER BY c.rowid`).all(callId,principalId).map(row=>({
        raw_ref:`l5:${row.session}`,track:row.track as CallAudioTrack['track'],finalized:Boolean(row.finalized)}));
  }
  async publishFinal(record:FinalSession):Promise<FinalSession>{
    const id=sessionId(record.raw_ref);
    check(record.schema==='paios.session.final.v1'&&keyPattern.test(record.object_hash)&&Number.isSafeInteger(record.bytes)&&record.bytes>=0&&typeof record.ended_by==='string','INVALID_FINAL_SESSION');
    const routes=new Set<string>();
    for(const ref of record.records){validateRef(ref);check(ref.namespace!=='session-finals'&&ref.namespace!=='objects'&&typeof ref.bytes==='string'&&Buffer.from(ref.bytes,'base64').toString('base64')===ref.bytes,'INVALID_FINAL_RECORD');
      const route=`${ref.namespace}/${ref.key}`;check(!routes.has(route),'DUPLICATE_FINAL_RECORD');routes.add(route);}
    for(const object of record.objects){check(keyPattern.test(object.key)&&Number.isSafeInteger(object.offset)&&object.offset>=0&&Number.isSafeInteger(object.bytes)&&object.bytes>=0&&object.offset+object.bytes<=record.bytes&&
      (object.key!==record.object_hash||object.offset===0&&object.bytes===record.bytes),'INVALID_FINAL_OBJECT');
      check(!routes.has(`objects/${object.key}`),'DUPLICATE_FINAL_OBJECT');routes.add(`objects/${object.key}`);}
    for(const object of record.retained_objects??[])check(keyPattern.test(object.key)&&typeof object.format==='string','INVALID_RETAINED_OBJECT');
    if(record.call)validateCall(record.call);
    const bytes=Buffer.from(canonical(record)),db=(await this.index(true))!;
    const prior=db.prepare('SELECT record FROM sessions WHERE id=?').get(id) as unknown as SessionRow|undefined;
    if(prior){check(Buffer.from(canonical(this.decode(prior,id))).equals(bytes),'FINAL_SESSION_CONFLICT',409);return structuredClone(this.decode(prior,id));}
    const insert=db.prepare('INSERT INTO refs(namespace,key,session,record_index,offset,bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,key) DO NOTHING');
    db.exec('BEGIN IMMEDIATE');
    try{
      const call=this.callTrackIn(db,id);
      check(canonical(call)===canonical(record.call??null),'CALL_TRACK_FINAL_CONFLICT',409);
      db.prepare('INSERT INTO sessions(id,record,object_hash,created) VALUES(?,?,?,?)').run(id,gzipSync(bytes),record.object_hash,Date.now());
      for(let i=0;i<record.records.length;i++){const ref=record.records[i]!;
        const existing=db.prepare('SELECT session,record_index FROM refs WHERE namespace=? AND key=?').get(ref.namespace,ref.key) as unknown as RefRow|undefined;
        if(existing){const row=db.prepare('SELECT record FROM sessions WHERE id=?').get(existing.session) as unknown as SessionRow;
          check(existing.record_index!==null&&this.decode(row,existing.session).records[existing.record_index]!.bytes===ref.bytes,'FINAL_RECORD_CONFLICT',409);}
        insert.run(ref.namespace,ref.key,id,i,null,null);}
      for(const object of record.objects)if(object.key!==record.object_hash)insert.run('objects',object.key,id,null,object.offset,object.bytes);
      db.exec('COMMIT');return record;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  async *finalKeys():AsyncGenerator<string>{
    const db=await this.index();if(!db)return;let cursor='';
    const page=db.prepare('SELECT id FROM sessions WHERE id>? ORDER BY id LIMIT 128');
    for(;;){const rows=page.all(cursor);if(!rows.length)return;
      for(const row of rows){cursor=row.id as string;yield cursor;}}
  }
  async keys(namespace:string,maxKeys?:number):Promise<string[]>{
    check(namespacePattern.test(namespace),'INVALID_STORAGE_NAMESPACE');const db=await this.index();if(!db)return [];
    const limit=maxKeys===undefined?-1:maxKeys+1;
    const rows=namespace==='session-finals'?db.prepare('SELECT id AS key FROM sessions ORDER BY id LIMIT ?').all(limit):db.prepare('SELECT key FROM refs WHERE namespace=? ORDER BY key LIMIT ?').all(namespace,limit);
    check(maxKeys===undefined||rows.length<=maxKeys,'STORAGE_READ_BUDGET_EXCEEDED',413);
    return rows.map(row=>row.key as string);
  }
  async details(key:string):Promise<{size:number;modified:number}|null>{
    check(keyPattern.test(key),'INVALID_STORAGE_KEY');const db=await this.index();if(!db)return null;
    const row=db.prepare('SELECT record,created FROM sessions WHERE id=?').get(key) as unknown as SessionRow|undefined;
    return row?{size:Buffer.byteLength(canonical(this.decode(row,key))),modified:row.created}:null;
  }
  async trackSessionRecords(rawRef:string,records:SessionRecordRef[]):Promise<void>{
    const id=sessionId(rawRef);for(const record of records)validateRef(record);if(!records.length)return;
    const db=(await this.index(true))!,insert=db.prepare('INSERT OR IGNORE INTO inflight(session,namespace,key) VALUES(?,?,?)');
    const final=this.final(db,id);
    const frozen=new Set(final?[...final.records,...[final.object_hash,...final.objects.map(o=>o.key),...final.retained_objects?.map(o=>o.key)??[]].map(key=>({namespace:'objects',key}))].map(ref=>`${ref.namespace}:${ref.key}`):[]);
    db.exec('BEGIN IMMEDIATE');try{for(const record of records)if(!frozen.has(`${record.namespace}:${record.key}`))insert.run(id,record.namespace,record.key);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  async sessionRecords(rawRef:string):Promise<SessionRecordRef[]>{
    const id=sessionId(rawRef),db=await this.index();if(!db)return [];
    return db.prepare('SELECT namespace,key FROM inflight WHERE session=? ORDER BY namespace,key').all(id) as unknown as SessionRecordRef[];
  }
  async hasLiveSessionOwner(record:SessionRecordRef):Promise<boolean>{
    validateRef(record);const db=await this.index();if(!db)return false;
    return !!db.prepare(`SELECT 1 FROM inflight i WHERE namespace=? AND key=?
      AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=i.session) LIMIT 1`).get(record.namespace,record.key);
  }
  async pendingFinals():Promise<string[]>{const db=await this.index();return db?db.prepare('SELECT id FROM sessions WHERE cleaned=0 ORDER BY created,id').all().map(row=>`l5:${row.id}`):[];}
  async completeFinal(rawRef:string):Promise<void>{
    const id=sessionId(rawRef),db=await this.index(false,true);check(db,'FINAL_SESSION_MISSING',404);
    db.exec('BEGIN IMMEDIATE');try{const result=db.prepare('UPDATE sessions SET cleaned=1 WHERE id=?').run(id);check(result.changes===1,'FINAL_SESSION_MISSING',404);
      const final=this.final(db,id)!;
      const remove=db.prepare('DELETE FROM inflight WHERE session=? AND namespace=? AND key=?');
      for(const ref of [...final.records,...[final.object_hash,...final.objects.map(o=>o.key),...final.retained_objects?.map(o=>o.key)??[]].map(key=>({namespace:'objects',key}))])remove.run(id,ref.namespace,ref.key);
      db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }
  async remove(rawRefs:string[]):Promise<void>{
    check(!this.readOnly,'STORAGE_READ_ONLY');const db=await this.index();if(!db)return;
    const ids=rawRefs.map(sessionId),selected=new Set(ids);
    db.exec('BEGIN IMMEDIATE');try{
      // Routes may point into a shared session: rebind them before deleting its metadata.
      const replacements=new Map<string,{session:string;index:number|null;offset:number|null;bytes:number|null}>();
      for(const row of db.prepare('SELECT id,record FROM sessions').all())if(!selected.has(row.id as string)){
        const final=this.decode(row as unknown as SessionRow,row.id as string);
        final.records.forEach((ref,index)=>replacements.set(`${ref.namespace}:${ref.key}`,{session:row.id as string,index,offset:null,bytes:null}));
        for(const ref of final.objects)if(ref.key!==final.object_hash)replacements.set(`objects:${ref.key}`,{session:row.id as string,index:null,offset:ref.offset,bytes:ref.bytes});
      }
      for(const id of ids){
        for(const ref of db.prepare('SELECT namespace,key FROM refs WHERE session=?').all(id) as unknown as SessionRecordRef[]){
          const replacement=replacements.get(`${ref.namespace}:${ref.key}`);
          if(replacement)db.prepare('UPDATE refs SET session=?,record_index=?,offset=?,bytes=? WHERE namespace=? AND key=?').run(replacement.session,replacement.index,replacement.offset,replacement.bytes,ref.namespace,ref.key);
        }
        for(const table of ['refs','inflight','call_tracks'])db.prepare(`DELETE FROM ${table} WHERE session=?`).run(id);
        db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      }
      db.exec('COMMIT');this.decoded.clear();this.decodedBytes=0;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  async close(){await this.opening;if(this.closeSnapshot){this.closeSnapshot();this.closeSnapshot=undefined;}else this.db?.close();this.db=undefined;this.decoded.clear();this.decodedBytes=0;}
}
