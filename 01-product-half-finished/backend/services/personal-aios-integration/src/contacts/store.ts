import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {check,digest,isIdentifier} from '../contracts.ts';
import {inTransaction,openOwnerDatabase} from '../owner-db.ts';

export interface ContactRecord {id:string;name:string;phones:{number:string;label:string}[];relations:{label:string;name:string}[]}
/** Only changed cards and deleted identifiers. The phone checkpoints its snapshot after the matching durable ACK. */
export interface ContactsBatch {control_id:string;contacts:ContactRecord[];deleted:string[]}
export interface ContactsQuery {name?:string;relation?:string;limit?:number}
export interface ContactsResult {
  contacts:Omit<ContactRecord,'id'>[];truncated:boolean;last_received_at_ms:number|null;age_ms:number|null;
  /** Pages carry no sync lifecycle marker. Freshness and query truncation cannot attest snapshot completeness. */
  sync_completeness:'unknown';
  relation_direction:'from_contact_to_named_person';
}
const SCHEMA='paios.contacts-store.v1';
const DDL=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS contacts(principal_id TEXT NOT NULL,device_id TEXT NOT NULL,contact_id TEXT NOT NULL,
  name TEXT NOT NULL,phones TEXT NOT NULL,relations TEXT NOT NULL,received_ms INTEGER NOT NULL,
  PRIMARY KEY(principal_id,device_id,contact_id)) STRICT;
CREATE INDEX IF NOT EXISTS contacts_name ON contacts(principal_id,name);
CREATE TABLE IF NOT EXISTS batches(principal_id TEXT NOT NULL,device_id TEXT NOT NULL,control_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,received_ms INTEGER NOT NULL,stored INTEGER NOT NULL,deleted INTEGER NOT NULL,
  PRIMARY KEY(principal_id,device_id,control_id)) STRICT;`;
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const keys=(v:object,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const text=(v:unknown,max:number,nonempty=false):v is string=>typeof v==='string'&&Array.from(v).length<=max&&(!nonempty||v.trim().length>0)&&!v.includes('\0');
const contactId=(v:unknown):v is string=>text(v,256,true);

/** CNContact identifiers are opaque device-local strings, not UUIDs. Reject malformed or oversized pages atomically. */
export function parseContactsBatch(value:unknown):ContactsBatch {
  check(record(value)&&keys(value,['control_id','contacts','deleted'])&&isIdentifier(value.control_id)&&
    Array.isArray(value.contacts)&&value.contacts.length<=16&&Array.isArray(value.deleted)&&value.deleted.length<=128&&
    value.deleted.every(contactId)&&new Set(value.deleted).size===value.deleted.length,'CONTACTS_BATCH_INVALID',422);
  const contacts=value.contacts;
  for(const c of contacts){
    check(record(c)&&keys(c,['id','name','phones','relations'])&&contactId(c.id)&&text(c.name,160)&&
      Array.isArray(c.phones)&&c.phones.length<=16&&Array.isArray(c.relations)&&c.relations.length<=16,'CONTACTS_RECORD_INVALID',422);
    check(c.phones.every(p=>record(p)&&keys(p,['number','label'])&&text(p.number,80,true)&&text(p.label,80))&&
      c.relations.every(r=>record(r)&&keys(r,['label','name'])&&text(r.label,80,true)&&text(r.name,160,true)),
    'CONTACTS_RECORD_INVALID',422);
  }
  const ids=contacts.map(c=>c.id);
  check(new Set(ids).size===ids.length&&!value.deleted.some(id=>ids.includes(id)),'CONTACTS_BATCH_INVALID',422);
  return value as unknown as ContactsBatch;
}
const like=(s:string)=>`%${s.replace(/[\\%_]/gu,'\\$&')}%`;

/** The sole Mac contact source. Queries use the device namespace of the latest authorised, committed page.
 * Relations are directed FROM each card TO its named person. They do not identify the card's relationship to the owner.
 * A relation filter also searches card names and phone labels, without inventing relation edges or emergency contacts. */
export class ContactsStore {
  private readonly db:DatabaseSync;private readonly now:()=>number;
  private constructor(db:DatabaseSync,now:()=>number){this.db=db;this.now=now;}
  static open(directory:string,now:()=>number=Date.now):ContactsStore {
    return new ContactsStore(openOwnerDatabase(directory,'contacts.sqlite',DDL,SCHEMA,'CONTACTS_STORE'),now);
  }
  close():void {if(this.db.isOpen)this.db.close();}
  ingest(principal:string,device:string,value:ContactsBatch):{stored:number;deleted:number} {
    check(isIdentifier(principal)&&isIdentifier(device),'CONTACTS_BATCH_INVALID',422);
    const batch=parseContactsBatch(value),hash=digest(batch),received=this.now();
    check(Number.isSafeInteger(received)&&received>=0,'CONTACTS_CLOCK_INVALID',500);
    return inTransaction(this.db,()=>{
      const replay=this.db.prepare('SELECT body_hash,stored,deleted FROM batches WHERE principal_id=? AND device_id=? AND control_id=?')
        .get(principal,device,batch.control_id) as {body_hash:string;stored:number;deleted:number}|undefined;
      if(replay){check(replay.body_hash===hash,'CONTACTS_BATCH_CONFLICT',409);return {stored:replay.stored,deleted:replay.deleted};}
      const upsert=this.db.prepare('INSERT INTO contacts(principal_id,device_id,contact_id,name,phones,relations,received_ms) VALUES(?,?,?,?,?,?,?) '+
        'ON CONFLICT(principal_id,device_id,contact_id) DO UPDATE SET name=excluded.name,phones=excluded.phones,'+
        'relations=excluded.relations,received_ms=excluded.received_ms');
      for(const c of batch.contacts)upsert.run(principal,device,c.id,c.name,JSON.stringify(c.phones),JSON.stringify(c.relations),received);
      const remove=this.db.prepare('DELETE FROM contacts WHERE principal_id=? AND device_id=? AND contact_id=?');
      let deleted=0;
      for(const id of batch.deleted)deleted+=Number(remove.run(principal,device,id).changes);
      const stored=batch.contacts.length;
      this.db.prepare('INSERT INTO batches(principal_id,device_id,control_id,body_hash,received_ms,stored,deleted) VALUES(?,?,?,?,?,?,?)')
        .run(principal,device,batch.control_id,hash,received,stored,deleted);
      return {stored,deleted};
    });
  }
  private snapshot(principal:string):{device_id:string;received_ms:number}|undefined {
    return this.db.prepare('SELECT device_id,received_ms FROM batches WHERE principal_id=? ORDER BY rowid DESC LIMIT 1')
      .get(principal) as {device_id:string;received_ms:number}|undefined;
  }
  /** Cards whose name (two characters or more) appears in `text`: the card an owner-memory line names. */
  named(principal:string,text:string):Omit<ContactRecord,'id'|'relations'>[] {
    return (this.db.prepare('SELECT name,phones FROM contacts WHERE principal_id=? AND device_id=? AND length(name)>=2 AND instr(?,name)>0 ORDER BY name,contact_id')
      .all(principal,this.snapshot(principal)?.device_id??null,text) as {name:string;phones:string}[]).map(r=>({name:r.name,phones:JSON.parse(r.phones)}));
  }
  /** Literal substring filters. Name and relation, when both supplied, must match the same card. */
  search(principal:string,args:ContactsQuery):ContactsResult {
    check(isIdentifier(principal)&&record(args as unknown)&&keys(args,['name','relation','limit'])&&
      [args.name,args.relation].every(s=>s===undefined||text(s,160,true))&&
      (args.name!==undefined||args.relation!==undefined),'CONTACTS_QUERY_INVALID',422);
    const limit=args.limit??10;
    check(Number.isSafeInteger(limit)&&limit>=1&&limit<=20,'CONTACTS_QUERY_INVALID',422);
    const snapshot=this.snapshot(principal),where=['principal_id=?','device_id=?'],params:SQLInputValue[]=[principal,snapshot?.device_id??null];
    if(args.name!==undefined){where.push("name LIKE ? ESCAPE '\\'");params.push(like(args.name.trim()));}
    if(args.relation!==undefined){
      where.push("(name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(phones) p WHERE json_extract(p.value,'$.label') LIKE ? ESCAPE '\\') "+
        "OR EXISTS(SELECT 1 FROM json_each(relations) r WHERE json_extract(r.value,'$.label') LIKE ? ESCAPE '\\'))");
      params.push(...Array(3).fill(like(args.relation.trim())));
    }
    const rows=this.db.prepare('SELECT name,phones,relations FROM contacts WHERE '+where.join(' AND ')+
      ' ORDER BY name COLLATE NOCASE,device_id,contact_id LIMIT ?').all(...params,limit+1) as {name:string;phones:string;relations:string}[];
    const last=snapshot?.received_ms??null;
    return {contacts:rows.slice(0,limit).map(r=>({name:r.name,phones:JSON.parse(r.phones),relations:JSON.parse(r.relations)})),
      truncated:rows.length>limit,last_received_at_ms:last,age_ms:last===null?null:Math.max(0,this.now()-last),
      sync_completeness:'unknown',relation_direction:'from_contact_to_named_person'};
  }
}
