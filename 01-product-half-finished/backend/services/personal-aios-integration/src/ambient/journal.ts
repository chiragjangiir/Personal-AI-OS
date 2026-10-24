import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {check,digest,isIdentifier} from '../contracts.ts';
import {configureSqlite} from '../owner-db.ts';
import {SOUND_EVENTS,SPEECH_EMOTIONS,type SoundEvent,type SpeechEmotion,parseSpeakerLabel} from '../voiceprint/contracts.ts';
import {resetOwnerDatabase,resetRowCounts} from '../owner-db.ts';

/** Ambient lane policy. Conversations split at a silence gap. After a wake word the request is the same speaker's
 *  consecutive utterances (starting within `request_follow_ms` when the wake word was said alone) until a pause of
 *  `turn_gap_ms` or `turn_max_ms` in all; an owner wake turn carries at most `context_max_ms` of its conversation in
 *  `context_max_bytes`. Turn gaps allow short mid-request pauses. After a turn's reply is
 *  delivered its asker may follow up without the wake word until `follow_up_ms` after the reply would have finished being
 *  read out: `reply_unit_ms` per syllable (Mandarin TTS ~4 syllables/s with its pauses; reading the text is faster), at
 *  most `reply_max_ms`. */
export interface AmbientPolicy {
  conversation_gap_ms:number;request_follow_ms:number;turn_gap_ms:number;turn_max_ms:number;context_max_ms:number;context_max_bytes:number;
  follow_up_ms:number;reply_unit_ms:number;reply_max_ms:number;
}
export const DEFAULT_AMBIENT_POLICY:AmbientPolicy=Object.freeze({conversation_gap_ms:180000,request_follow_ms:8000,turn_gap_ms:1300,turn_max_ms:20000,
  context_max_ms:600000,context_max_bytes:12000,follow_up_ms:10000,reply_unit_ms:250,reply_max_ms:30000});
export function parseAmbientPolicy(value:unknown={}):AmbientPolicy {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>key in DEFAULT_AMBIENT_POLICY),'AMBIENT_POLICY_INVALID');
  const policy={...DEFAULT_AMBIENT_POLICY,...value as Partial<AmbientPolicy>};
  check(Object.values(policy).every(n=>Number.isSafeInteger(n)&&n>0)&&policy.conversation_gap_ms<=86400000&&policy.request_follow_ms<=60000&&
    policy.turn_gap_ms<=10000&&policy.turn_max_ms<=20000&&policy.context_max_ms<=3600000&&policy.context_max_bytes<=262144&&
    policy.follow_up_ms<=60000&&policy.reply_unit_ms<=1000&&policy.reply_max_ms<=120000,'AMBIENT_POLICY_INVALID');
  return Object.freeze(policy);
}
/** One audio observation. `wake`: the keyword the spotter heard in it; `wake_cut_ms` where the wake word ends (UTC). */
export interface JournalUtterance {
  segment_index:number;start_ms:number;end_ms:number;speaker:string|null;score:number|null;text:string;lang:string|null;
  wake:string|null;wake_cut_ms:number|null;event?:SoundEvent;emotion?:SpeechEmotion;
}
export interface JournalSource {principal_id:string;device_id:string;processed_event_id:string;raw_ref:string;archive_revision:string;segment_id:string}
export interface JournalEntry extends JournalUtterance,JournalSource {entry_id:number;conversation_id:string}
export interface JournalProjectionSource {processed_event_id:string;segment_index:number;device_id:string;burst_id:string|null}
export interface JournalSoundEvent {burst_id:string;device_id:string;speaker:string|null;event:SoundEvent;start_ms:number;end_ms:number;count:number}
export interface JournalQuery {principal_id:string;from_ms?:number;until_ms?:number;speakers?:string[];text?:string;event?:SoundEvent;limit:number}

// The erasure objects below are additive and the previous release (v2) still reads the file, so the label stays v2 until a
// change it cannot read. Files labelled v3 are accepted and labelled back for compatibility.
const SCHEMA='paios.ambient-journal.v2',MAX_TEXT=8000,EVENT_BURST_MS=180000;
const DDL=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS entries(
  entry_id INTEGER PRIMARY KEY,entry_key TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,device_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,speaker TEXT,score REAL,text TEXT NOT NULL,lang TEXT,
  processed_event_id TEXT NOT NULL,segment_index INTEGER NOT NULL,raw_ref TEXT NOT NULL,archive_revision TEXT NOT NULL,segment_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,wake TEXT,wake_cut_ms INTEGER,
  CHECK(end_ms>=start_ms),CHECK((wake IS NULL)=(wake_cut_ms IS NULL))) STRICT;
CREATE INDEX IF NOT EXISTS entries_time ON entries(principal_id,start_ms);
CREATE INDEX IF NOT EXISTS entries_device_time ON entries(principal_id,device_id,start_ms);
CREATE INDEX IF NOT EXISTS entries_speaker_time ON entries(principal_id,speaker,start_ms);
CREATE INDEX IF NOT EXISTS entries_conversation ON entries(conversation_id,start_ms);
CREATE INDEX IF NOT EXISTS entries_processed ON entries(principal_id,processed_event_id);
CREATE INDEX IF NOT EXISTS entries_source ON entries(principal_id,raw_ref);
CREATE TABLE IF NOT EXISTS erased_sources(principal_id TEXT NOT NULL,raw_ref TEXT NOT NULL,PRIMARY KEY(principal_id,raw_ref)) STRICT;
CREATE TRIGGER IF NOT EXISTS erased_sources_no_update BEFORE UPDATE ON erased_sources BEGIN SELECT RAISE(ABORT,'AMBIENT_JOURNAL_ERASURE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS erased_sources_no_delete BEFORE DELETE ON erased_sources BEGIN SELECT RAISE(ABORT,'AMBIENT_JOURNAL_ERASURE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS entries_source_guard BEFORE INSERT ON entries
  WHEN EXISTS(SELECT 1 FROM erased_sources WHERE principal_id=new.principal_id AND raw_ref=new.raw_ref)
  BEGIN SELECT RAISE(ABORT,'AMBIENT_JOURNAL_SOURCE_ERASED'); END;
CREATE VIRTUAL TABLE IF NOT EXISTS entries_text USING fts5(text,content='entries',content_rowid='entry_id',tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS entries_index AFTER INSERT ON entries BEGIN INSERT INTO entries_text(rowid,text) VALUES(new.entry_id,new.text); END;
CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'AMBIENT_JOURNAL_APPEND_ONLY'); END;
DROP TRIGGER IF EXISTS entries_no_delete;
CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
  WHEN NOT EXISTS(SELECT 1 FROM erased_sources WHERE principal_id=old.principal_id AND raw_ref=old.raw_ref)
  BEGIN SELECT RAISE(ABORT,'AMBIENT_JOURNAL_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS entries_unindex AFTER DELETE ON entries
  BEGIN INSERT INTO entries_text(entries_text,rowid,text) VALUES('delete',old.entry_id,old.text); END;`;
const COLUMNS='entry_id,principal_id,device_id,start_ms,end_ms,speaker,score,text,lang,processed_event_id,segment_index,raw_ref,'+
  'archive_revision,segment_id,conversation_id,wake,wake_cut_ms,event,emotion';
const row=(value:Record<string,unknown>):JournalEntry=>{const {event,emotion,...base}=value;
  return {...base,...(event===null?{}:{event}),...(emotion===null?{}:{emotion})} as unknown as JournalEntry;};

function ownerOnly(path:string,directory:boolean):void {
  const stat=lstatSync(path);
  check(!stat.isSymbolicLink()&&(directory?stat.isDirectory():stat.isFile())&&stat.uid===process.getuid?.(),'AMBIENT_JOURNAL_PATH_UNSAFE',500);
  if((stat.mode&0o077)!==0)chmodSync(path,directory?0o700:0o600);
}
function validUtterance(u:JournalUtterance):void {
  check(Number.isSafeInteger(u.segment_index)&&u.segment_index>=0&&Number.isSafeInteger(u.start_ms)&&Number.isSafeInteger(u.end_ms)&&
    u.start_ms>=0&&u.end_ms>=u.start_ms&&typeof u.text==='string'&&u.text.length<=MAX_TEXT&&
    (u.speaker===null||parseSpeakerLabel(u.speaker)!==undefined)&&(u.score===null||Number.isFinite(u.score)&&u.score>=-1&&u.score<=1)&&
    (u.event===undefined||SOUND_EVENTS.includes(u.event))&&(u.emotion===undefined||SPEECH_EMOTIONS.includes(u.emotion))&&
    (u.lang===null||typeof u.lang==='string'&&/^[a-z]{2,8}$/u.test(u.lang))&&
    (u.wake===null?u.wake_cut_ms===null:typeof u.wake==='string'&&u.wake.length>0&&u.wake.length<=32&&Number.isSafeInteger(u.wake_cut_ms)&&
      u.wake_cut_ms!>=u.start_ms&&u.wake_cut_ms!<=u.end_ms),'AMBIENT_JOURNAL_ENTRY_INVALID');
}

/** The owner's ambient speech journal: one append-only row per transcribed utterance, owner-only on the Mac
 *  (`<storage_root>/ambient-journal`, 0700 directory, 0600 SQLite file, WAL with synchronous FULL). Rows keep labels
 *  (`owner`, `speaker:12`, `assistant` for 依米's own voice heard back); display names are resolved at read time because the owner renames people. Indexed for
 *  time ranges, speakers and (trigram FTS) text over months of rows; the integration's process lock makes it the only writer. */
export class AmbientJournal {
  static resetConversation(directory:string,cutoff:number,apply=false,sources:{removed_raw_refs:readonly string[];known_raw_refs:readonly string[]}={removed_raw_refs:[],known_raw_refs:[]}) {
    return resetOwnerDatabase(join(directory,'journal.sqlite'),[SCHEMA,'paios.ambient-journal.v1','paios.ambient-journal.v3'],apply,db=>{
      const rows=db.prepare('SELECT * FROM entries').all();
      const removed=new Set(sources.removed_raw_refs),known=new Set([...sources.known_raw_refs,...sources.removed_raw_refs]);
      const selected=(r:Record<string,unknown>)=>Number(r.end_ms)<cutoff&&removed.has(String(r.raw_ref));
      const result=resetRowCounts('ambient-journal',rows,selected);
      result.unresolved_sources=new Set(rows.filter(r=>Number(r.end_ms)<cutoff&&!known.has(String(r.raw_ref))).map(r=>String(r.raw_ref))).size;
      result.crossing_sources=new Set(rows.filter(r=>Number(r.end_ms)>=cutoff&&removed.has(String(r.raw_ref))).map(r=>String(r.raw_ref))).size;
      if(apply)check(!result.unresolved_sources,'RESET_AMBIENT_SOURCE_UNRESOLVED');
      if(apply)check(!result.crossing_sources,'RESET_AMBIENT_SOURCE_CROSSES_CUTOFF');
      if(apply&&result.delete_count){
        // A cutoff may split a source: keep its later utterances and erase only selected rows.
        db.exec('DROP TRIGGER entries_no_delete');
        for(const row of rows.filter(selected))db.prepare('DELETE FROM entries WHERE entry_id=?').run(Number(row.entry_id));
        for(const ref of new Set(rows.filter(selected).map(r=>String(r.raw_ref))))db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))").run(`conversation-reset-before:${ref}`,String(cutoff));
        db.exec("CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries WHEN NOT EXISTS(SELECT 1 FROM erased_sources WHERE principal_id=old.principal_id AND raw_ref=old.raw_ref) BEGIN SELECT RAISE(ABORT,'AMBIENT_JOURNAL_APPEND_ONLY'); END;");
      }return result;
    });
  }
  readonly policy:AmbientPolicy;
  private readonly db:DatabaseSync;
  private constructor(db:DatabaseSync,policy:AmbientPolicy){this.db=db;this.policy=policy;}
  static open(directory:string,policy:Partial<AmbientPolicy>={}):AmbientJournal {
    check(isAbsolute(directory),'AMBIENT_JOURNAL_PATH_UNSAFE',500);
    const parsed=parseAmbientPolicy(policy);
    mkdirSync(directory,{recursive:true,mode:0o700});ownerOnly(directory,true);
    const file=join(directory,'journal.sqlite');
    if(!existsSync(file))closeSync(openSync(file,'wx',0o600));
    ownerOnly(file,false);
    const db=new DatabaseSync(file);
    try {
      configureSqlite(db);db.exec('PRAGMA foreign_keys=ON;');
      db.exec(`BEGIN IMMEDIATE;${DDL}`);
      db.prepare('INSERT INTO meta(key,value) VALUES(\'schema\',?) ON CONFLICT(key) DO NOTHING').run(SCHEMA);
      const schema=(db.prepare('SELECT value FROM meta WHERE key=\'schema\'').get() as {value:string}).value;
      check(schema===SCHEMA||schema==='paios.ambient-journal.v3'||schema==='paios.ambient-journal.v1','AMBIENT_JOURNAL_SCHEMA_UNSUPPORTED',503);
      const columns=db.prepare('PRAGMA table_info(entries)').all().map(c=>c.name);
      if(!columns.includes('event'))db.exec('ALTER TABLE entries ADD COLUMN event TEXT;ALTER TABLE entries ADD COLUMN emotion TEXT;'+
        'ALTER TABLE entries ADD COLUMN burst_id TEXT;CREATE INDEX entries_burst ON entries(principal_id,device_id,event,start_ms);CREATE INDEX entries_burst_id ON entries(burst_id,start_ms);');
      db.prepare('UPDATE meta SET value=? WHERE key=\'schema\'').run(SCHEMA);
      db.exec('COMMIT');
      check((db.prepare('SELECT value FROM meta WHERE key=\'schema\'').get() as {value:string}).value===SCHEMA,'AMBIENT_JOURNAL_SCHEMA_UNSUPPORTED',503);
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');db.close();throw error;}
    return new AmbientJournal(db,parsed);
  }
  close():void {if(this.db.isOpen)this.db.close();}
  private transaction<T>(work:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const value=work();this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Read projection identities before erasure removes their source rows. */
  projectionSources(principal:string,raw_refs:readonly string[]):JournalProjectionSource[] {
    return this.db.prepare('SELECT processed_event_id,segment_index,device_id,burst_id FROM entries WHERE principal_id=? AND raw_ref IN (SELECT value FROM json_each(?))')
      .all(principal,JSON.stringify(raw_refs)) as unknown as JournalProjectionSource[];
  }
  /** The original archive's deletion authority calls this for its exact principal/source set. */
  eraseSources(principal:string,raw_refs:readonly string[]):number {
    check(isIdentifier(principal)&&Array.isArray(raw_refs)&&raw_refs.every(ref=>/^l5:[a-f0-9]{64}$/u.test(ref)),
      'AMBIENT_JOURNAL_ERASURE_SCOPE_INVALID');
    const tombstone=this.db.prepare('INSERT INTO erased_sources(principal_id,raw_ref) VALUES(?,?) ON CONFLICT DO NOTHING');
    const remove=this.db.prepare('DELETE FROM entries WHERE principal_id=? AND raw_ref=?');
    return this.transaction(()=>{
      let erased=0;
      for(const ref of new Set(raw_refs)){tombstone.run(principal,ref);erased+=Number(remove.run(principal,ref).changes);}
      return erased;
    });
  }
  /** Rows already journaled for one D: a retried continuous job reuses their stored decisions. */
  entriesOf(principal:string,processedEventId:string):JournalEntry[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM entries WHERE principal_id=? AND processed_event_id=? ORDER BY segment_index`)
      .all(principal,processedEventId).map(row);
  }
  /** The sound bursts one D's rows belong to, each counted over all its rows so far. */
  bursts(principal:string,processedEventId:string):JournalSoundEvent[] {
    return this.db.prepare('SELECT burst_id,device_id,speaker,event,MIN(start_ms) AS start_ms,MAX(end_ms) AS end_ms,COUNT(*) AS count FROM entries '+
      'WHERE burst_id IN (SELECT burst_id FROM entries WHERE principal_id=? AND processed_event_id=? AND burst_id IS NOT NULL) GROUP BY burst_id')
      .all(principal,processedEventId) as unknown as JournalSoundEvent[];
  }
  /** All utterances of one D in one transaction. Each joins the conversation of the closest earlier utterance on the same
   *  device when the silence between them is within the gap; otherwise it opens a conversation. Repeats return the rows. */
  append(source:JournalSource,utterances:JournalUtterance[]):JournalEntry[] {
    check([source.principal_id,source.device_id,source.processed_event_id,source.segment_id].every(isIdentifier)&&
      /^l5:[a-f0-9]{64}$/u.test(source.raw_ref)&&/^[a-f0-9]{64}$/u.test(source.archive_revision)&&utterances.length<=256,'AMBIENT_JOURNAL_ENTRY_INVALID');
    utterances.forEach(validUtterance);
    const previous=this.db.prepare('SELECT conversation_id,end_ms FROM entries WHERE principal_id=? AND device_id=? AND start_ms<=? '+
      'ORDER BY start_ms DESC,entry_id DESC LIMIT 1');
    const insert=this.db.prepare('INSERT INTO entries(entry_key,principal_id,device_id,start_ms,end_ms,speaker,score,text,lang,processed_event_id,'+
      'segment_index,raw_ref,archive_revision,segment_id,conversation_id,wake,wake_cut_ms,event,emotion,burst_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '+
      'ON CONFLICT(entry_key) DO NOTHING');
    const burst=this.db.prepare('SELECT burst_id,(SELECT MIN(start_ms) FROM entries b WHERE b.burst_id=entries.burst_id) AS first_ms FROM entries WHERE principal_id=? AND device_id=? '+
      'AND speaker IS ? AND event=? AND start_ms<=? AND start_ms>=? ORDER BY start_ms DESC,entry_id DESC LIMIT 1');
    return this.transaction(()=>{
      check(!this.db.prepare('SELECT 1 FROM erased_sources WHERE principal_id=? AND raw_ref=?').get(source.principal_id,source.raw_ref),
        'AMBIENT_JOURNAL_SOURCE_ERASED',409);
      const floor=Number((this.db.prepare("SELECT value FROM meta WHERE key=?").get(`conversation-reset-before:${source.raw_ref}`) as {value:string}|undefined)?.value??0);
      utterances=utterances.filter(u=>u.end_ms>=floor);
      for(const u of [...utterances].sort((a,b)=>a.start_ms-b.start_ms||a.segment_index-b.segment_index)) {
        const key=digest([source.principal_id,source.processed_event_id,u.segment_index]);
        const prior=previous.get(source.principal_id,source.device_id,u.start_ms) as {conversation_id:string;end_ms:number}|undefined;
        const conversation=prior&&u.start_ms-prior.end_ms<=this.policy.conversation_gap_ms?prior.conversation_id:`conv:${key.slice(0,24)}`;
        // Fixed span from the first observation bounds a burst even when a sound continues all day.
        const priorBurst=u.event?burst.get(source.principal_id,source.device_id,u.speaker,u.event,u.start_ms,u.start_ms-EVENT_BURST_MS) as
          {burst_id:string;first_ms:number}|undefined:undefined;
        const burstId=u.event?(priorBurst&&u.start_ms-priorBurst.first_ms<=EVENT_BURST_MS?priorBurst.burst_id:`sound:${key.slice(0,24)}`):null;
        insert.run(key,source.principal_id,source.device_id,u.start_ms,u.end_ms,u.speaker,u.score,u.text,u.lang,source.processed_event_id,
          u.segment_index,source.raw_ref,source.archive_revision,source.segment_id,conversation,u.wake,u.wake_cut_ms,u.event??null,u.emotion??null,burstId);
      }
      const stored=this.entriesOf(source.principal_id,source.processed_event_id);
      check(stored.length===utterances.length&&utterances.every(u=>{const s=stored.find(e=>e.segment_index===u.segment_index);
        return s&&(['start_ms','end_ms','speaker','score','text','lang','wake','wake_cut_ms','event','emotion'] as const).every(k=>s[k]===u[k]);}),
      'AMBIENT_JOURNAL_ENTRY_CONFLICT',409);
      return stored;
    });
  }
  /** The conversation before `anchor` (newest first, at most `context_max_ms` back); the caller bounds bytes. */
  context(anchor:JournalEntry,limit=400):JournalEntry[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM entries WHERE conversation_id=? AND start_ms<? AND start_ms>=? `+
      'ORDER BY start_ms DESC,entry_id DESC LIMIT ?').all(anchor.conversation_id,anchor.start_ms,anchor.start_ms-this.policy.context_max_ms,limit).map(row);
  }
  /** Newest first. Text terms of three or more characters use the trigram index; shorter ones a substring match. */
  search(query:JournalQuery):{entries:JournalEntry[];events:JournalSoundEvent[];truncated:boolean} {
    check(isIdentifier(query.principal_id)&&Number.isSafeInteger(query.limit)&&query.limit>0&&query.limit<=200&&
      [query.from_ms,query.until_ms].every(n=>n===undefined||Number.isSafeInteger(n))&&(query.speakers===undefined||
        Array.isArray(query.speakers)&&query.speakers.length<=64)&&(query.text===undefined||typeof query.text==='string'&&query.text.length<=200),
    'AMBIENT_JOURNAL_QUERY_INVALID');
    check(query.event===undefined||SOUND_EVENTS.includes(query.event),'AMBIENT_JOURNAL_QUERY_INVALID');
    const where=['principal_id=?'],params:SQLInputValue[]=[query.principal_id];
    if(query.from_ms!==undefined){where.push('start_ms>=?');params.push(query.from_ms);}
    if(query.until_ms!==undefined){where.push('start_ms<?');params.push(query.until_ms);}
    if(query.speakers){
      const labels=query.speakers.filter(label=>label!=='unknown');
      where.push(`(speaker IN (SELECT value FROM json_each(?))${labels.length<query.speakers.length?' OR speaker IS NULL':''})`);params.push(JSON.stringify(labels));
    }
    if(query.event!==undefined){where.push('event=?');params.push(query.event);}
    const terms=(query.text??'').trim().split(/\s+/u).filter(Boolean).slice(0,8),long=terms.filter(term=>[...term].length>=3);
    if(long.length){where.push('entry_id IN (SELECT rowid FROM entries_text WHERE entries_text MATCH ?)');
      params.push(long.map(term=>`"${term.replaceAll('"','""')}"`).join(' AND '));}
    for(const term of terms.filter(term=>[...term].length<3)){where.push("text LIKE ? ESCAPE '\\'");params.push(`%${term.replace(/[\\%_]/gu,'\\$&')}%`);}
    const rows=this.db.prepare(`SELECT ${COLUMNS} FROM entries WHERE ${where.join(' AND ')} AND (event IS NULL OR text<>'') ORDER BY start_ms DESC,entry_id DESC LIMIT ?`)
      .all(...params,query.limit+1).map(row);
    const events=this.db.prepare('SELECT burst_id,device_id,speaker,event,MIN(start_ms) AS start_ms,MAX(end_ms) AS end_ms,COUNT(*) AS count '+
      `FROM entries WHERE ${where.join(' AND ')} AND event IS NOT NULL GROUP BY burst_id ORDER BY start_ms DESC LIMIT ?`)
      .all(...params,query.limit+1) as unknown as JournalSoundEvent[];
    return {entries:rows.slice(0,query.limit),events:events.slice(0,query.limit),truncated:rows.length>query.limit||events.length>query.limit};
  }
}
