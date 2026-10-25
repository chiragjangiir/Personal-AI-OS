import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {canonical, sha256} from '../contracts.ts';
import {inTransaction, openOwnerDatabase} from '../owner-db.ts';
import type {AuditEvent, LockRow, Payment, PaymentGrant, PaymentIntent, PaymentPolicy} from './contracts.ts';
export {canonical} from '../contracts.ts';

const DDL=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS intents(
  intent_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
  session_id TEXT NOT NULL, processed_event_id TEXT NOT NULL,
  initiating TEXT NOT NULL,            -- JSON Initiating (A4.0); utterance refs, never audio or embeddings
  initiating_text TEXT,                -- ≤ 80 chars of the owner's words, for the record timeline
  purpose TEXT NOT NULL, app TEXT NOT NULL, budget_fen INTEGER CHECK(budget_fen IS NULL OR budget_fen > 0),
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','bound','closed')), closed_reason TEXT,
  UNIQUE(run_id, tool_call_id)) STRICT;
CREATE TABLE IF NOT EXISTS payments(
  payment_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(intent_id), principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq >= 1), supersedes TEXT REFERENCES payments(payment_id),
  app TEXT NOT NULL, checkout TEXT NOT NULL CHECK(checkout IN ('order_card','cashier')),
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0), payee TEXT, payee_key TEXT, items TEXT NOT NULL, delivery TEXT,
  screen_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('awaiting_owner','auto_pending','verifying','granted','paying',
    'paid','outcome_unknown','cancelled','expired','superseded','failed')),
  version INTEGER NOT NULL, decision_nonce TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, auto_at_ms INTEGER,
  voice_attempts INTEGER NOT NULL DEFAULT 0, method TEXT CHECK(method IN ('card','voice','auto')),
  decided_by_device TEXT, decision TEXT CHECK(decision IN ('pay','cancel')), reason TEXT, notice TEXT,
  next_payment_id TEXT, order_cancel TEXT CHECK(order_cancel IN ('pending','done','failed','not_attempted','not_needed')),
  finished_at_ms INTEGER,
  UNIQUE(intent_id, job_id, seq)) STRICT;
CREATE INDEX IF NOT EXISTS payments_payee ON payments(principal_id, payee_key, state, created_at_ms);
CREATE INDEX IF NOT EXISTS payments_day ON payments(principal_id, method, state, created_at_ms);
CREATE TABLE IF NOT EXISTS grants(
  grant_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL UNIQUE REFERENCES payments(payment_id),
  amount_fen INTEGER NOT NULL, payee_key TEXT, method TEXT NOT NULL CHECK(method IN ('card','voice','auto')),
  device_id TEXT NOT NULL, issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  taps INTEGER NOT NULL DEFAULT 0, first_tap_at_ms INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS policy(
  principal_id TEXT PRIMARY KEY, version INTEGER NOT NULL, voice_enabled INTEGER NOT NULL, auto_enabled INTEGER NOT NULL,
  limits TEXT NOT NULL,                -- JSON {auto_order_fen?, auto_day_fen?, voice_order_fen?}: owner overrides only
  paused_until_ms INTEGER, updated_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS locks(
  device_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, device_type TEXT NOT NULL CHECK(device_type IN ('phone','glasses')),
  enabled INTEGER NOT NULL, relock_s INTEGER, updated_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS device_keys(
  device_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('device','user','model_settings','model_settings_pending')), principal_id TEXT NOT NULL,
  public_x963_b64 TEXT NOT NULL, created_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
  PRIMARY KEY(device_id, role)) STRICT;
CREATE TABLE IF NOT EXISTS voice_attempts(
  attempt_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(payment_id), device_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('pass','uncertain','fail','insufficient','unavailable')),
  reason TEXT, initiating_score REAL, pay_score REAL, combined_score REAL, initiating_speech_ms INTEGER,
  pay_speech_ms INTEGER, channel TEXT, initiating_audio TEXT, pay_audio TEXT) STRICT;   -- audio = JSON L5 ref+span
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, principal_id TEXT NOT NULL, kind TEXT NOT NULL,
  intent_id TEXT, payment_id TEXT, actor TEXT NOT NULL, device_id TEXT, data TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS events_payment ON events(payment_id, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'PAYMENT_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'PAYMENT_AUDIT_IMMUTABLE'); END;
`;
const JSON_FIELDS=new Set(['initiating','items','notice','limits','data']);
const BOOLEAN_FIELDS=new Set(['voice_enabled','auto_enabled','enabled']);
function decode<T>(row:unknown):T|undefined {
  if(!row)return undefined;
  return Object.fromEntries(Object.entries(row as Record<string,unknown>).map(([k,v])=>[k,
    JSON_FIELDS.has(k)&&typeof v==='string'?JSON.parse(v):BOOLEAN_FIELDS.has(k)?Boolean(v):v])) as T;
}
function values(row:object):SQLInputValue[] {
  return Object.entries(row).map(([k,v])=>JSON_FIELDS.has(k)&&v!==null?canonical(v):typeof v==='boolean'?Number(v):v as SQLInputValue);
}
/** A3 payee identity: punctuation and symbols do not distinguish a payee; branch names do. */
export function payeeKey(principal:string,app:string,payee:string|null):string|null {
  if(payee===null)return null;
  const normalized=payee.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').replace(/[A-Z]/g,c=>c.toLowerCase());
  return sha256(`${principal}\n${app}\n${normalized}`);
}
/** The payment authority owns transactions. Methods do not start nested transactions. */
export class PaymentStore {
  public readonly db:DatabaseSync;
  private constructor(db:DatabaseSync){this.db=db;}
  static open(directory:string):PaymentStore {
    const store=new PaymentStore(openOwnerDatabase(directory,'payment.sqlite',DDL,'paios.payment-store.v1','PAYMENT_STORE'));
    const table=store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='device_keys'").get() as {sql:string};
    if(!table.sql.includes("'model_settings_pending'"))store.tx(()=>store.db.exec(`
      ALTER TABLE device_keys RENAME TO device_keys_previous;
      CREATE TABLE device_keys(device_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('device','user','model_settings','model_settings_pending')),
        principal_id TEXT NOT NULL,public_x963_b64 TEXT NOT NULL,created_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER,
        PRIMARY KEY(device_id,role)) STRICT;
      INSERT INTO device_keys SELECT * FROM device_keys_previous;
      DROP TABLE device_keys_previous;`));
    return store;
  }
  close():void {if(this.db.isOpen)this.db.close();}
  tx<T>(fn:()=>T):T {return inTransaction(this.db,fn);}
  private insert(table:string,row:object):void {
    const keys=Object.keys(row);this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...values(row));
  }
  private update(table:string,key:string,id:string,patch:object):void {
    const keys=Object.keys(patch);if(keys.length===0)return;
    this.db.prepare(`UPDATE ${table} SET ${keys.map(k=>`${k}=?`).join(',')} WHERE ${key}=?`).run(...values(patch),id);
  }
  getIntent(id:string):PaymentIntent|undefined {return decode(this.db.prepare('SELECT * FROM intents WHERE intent_id=?').get(id));}
  getPayment(id:string):Payment|undefined {return decode(this.db.prepare('SELECT * FROM payments WHERE payment_id=?').get(id));}
  getGrant(paymentId:string):PaymentGrant|undefined {return decode(this.db.prepare('SELECT * FROM grants WHERE payment_id=?').get(paymentId));}
  insertIntent(intent:PaymentIntent):void {this.insert('intents',intent);}
  insertPayment(payment:Payment):void {this.insert('payments',payment);}
  insertGrant(grant:PaymentGrant):void {this.insert('grants',grant);}
  updateIntent(id:string,patch:Partial<PaymentIntent>):void {this.update('intents','intent_id',id,patch);}
  updatePayment(id:string,patch:Partial<Payment>):void {this.update('payments','payment_id',id,patch);}
  updateGrant(paymentId:string,patch:Partial<PaymentGrant>):void {this.update('grants','payment_id',paymentId,patch);}
  payments(intentId:string):Payment[] {return this.db.prepare('SELECT * FROM payments WHERE intent_id=? ORDER BY seq').all(intentId).map(r=>decode<Payment>(r)!);}
  principalPayments(principal:string,before?:readonly [number,string]):Payment[] {
    const rows=before?this.db.prepare('SELECT * FROM payments WHERE principal_id=? AND (created_at_ms<? OR (created_at_ms=? AND payment_id>?)) ORDER BY created_at_ms DESC,payment_id').all(principal,before[0],before[0],before[1]):
      this.db.prepare('SELECT * FROM payments WHERE principal_id=? ORDER BY created_at_ms DESC,payment_id').all(principal);
    return rows.map(r=>decode<Payment>(r)!);
  }
  policy(principal:string):PaymentPolicy {
    return decode<PaymentPolicy>(this.db.prepare('SELECT * FROM policy WHERE principal_id=?').get(principal))??
      {principal_id:principal,version:1,voice_enabled:false,auto_enabled:false,limits:{},paused_until_ms:null,updated_at_ms:0};
  }
  setPolicy(policy:PaymentPolicy):void {
    this.db.prepare('INSERT INTO policy VALUES(?,?,?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET version=excluded.version,voice_enabled=excluded.voice_enabled,auto_enabled=excluded.auto_enabled,limits=excluded.limits,paused_until_ms=excluded.paused_until_ms,updated_at_ms=excluded.updated_at_ms').run(policy.principal_id,policy.version,Number(policy.voice_enabled),Number(policy.auto_enabled),canonical(policy.limits),policy.paused_until_ms,policy.updated_at_ms);
  }
  locks(principal:string):LockRow[] {return this.db.prepare('SELECT * FROM locks WHERE principal_id=?').all(principal).map(r=>decode<LockRow>(r)!);}
  setLock(lock:LockRow):void {
    this.db.prepare('INSERT INTO locks(device_id,principal_id,device_type,enabled,relock_s,updated_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET principal_id=excluded.principal_id,device_type=excluded.device_type,enabled=excluded.enabled,relock_s=excluded.relock_s,updated_at_ms=excluded.updated_at_ms').run(lock.device_id,lock.principal_id,lock.device_type,Number(lock.enabled),lock.relock_s,lock.updated_at_ms);
  }
  event(input:Omit<AuditEvent,'seq'|'hash'|'prev_hash'|'intent_id'|'payment_id'|'device_id'>&Partial<Pick<AuditEvent,'intent_id'|'payment_id'|'device_id'>>):AuditEvent {
    const previous=this.db.prepare('SELECT seq,hash FROM events ORDER BY seq DESC LIMIT 1').get() as {seq:number;hash:string}|undefined;
    const body={seq:(previous?.seq??0)+1,at_ms:input.at_ms,kind:input.kind,intent_id:input.intent_id??null,
      payment_id:input.payment_id??null,actor:input.actor,device_id:input.device_id??null,data:input.data};
    const prev_hash=previous?.hash??'0'.repeat(64),hash=sha256(prev_hash+canonical(body));
    this.db.prepare('INSERT INTO events(seq,at_ms,principal_id,kind,intent_id,payment_id,actor,device_id,data,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(body.seq,body.at_ms,input.principal_id,body.kind,body.intent_id,body.payment_id,body.actor,body.device_id,canonical(body.data),prev_hash,hash);
    return {...body,principal_id:input.principal_id,prev_hash,hash};
  }
  events(paymentId?:string):AuditEvent[] {
    const rows=paymentId===undefined?this.db.prepare('SELECT * FROM events ORDER BY seq').all():
      this.db.prepare('SELECT * FROM events WHERE payment_id=? ORDER BY seq').all(paymentId);
    return rows.map(r=>decode<AuditEvent>(r)!);
  }
  recordEvents(paymentId:string,beforeSeq?:number):AuditEvent[] {
    const rows=beforeSeq===undefined?this.db.prepare('SELECT * FROM events WHERE payment_id=? ORDER BY seq DESC LIMIT 65').all(paymentId):
      this.db.prepare('SELECT * FROM events WHERE payment_id=? AND seq<? ORDER BY seq DESC LIMIT 65').all(paymentId,beforeSeq);
    return rows.map(r=>decode<AuditEvent>(r)!);
  }
  knownPayee(principal:string,key:string|null):boolean {
    return key!==null&&Boolean(this.db.prepare("SELECT 1 FROM payments WHERE principal_id=? AND payee_key=? AND state='paid' LIMIT 1").get(principal,key));
  }
  recentSamePayee(principal:string,key:string|null,excludeId:string,since:number):boolean {
    return key!==null&&Boolean(this.db.prepare("SELECT 1 FROM payments WHERE principal_id=? AND payee_key=? AND payment_id<>? AND created_at_ms>=? AND state IN ('granted','paying','paid','outcome_unknown') LIMIT 1").get(principal,key,excludeId,since));
  }
  autoUsed(principal:string,start:number,end:number):number {
    // A grant reserves its issue day's budget; card creation and later result delivery do not move it.
    return (this.db.prepare("SELECT COALESCE(SUM(g.amount_fen),0) AS used FROM grants g JOIN payments p ON p.payment_id=g.payment_id WHERE p.principal_id=? AND g.method='auto' AND p.state IN ('granted','paying','paid','outcome_unknown') AND g.issued_at_ms>=? AND g.issued_at_ms<?").get(principal,start,end) as {used:number}).used;
  }
  anomalyCount(principal:string,start:number,end:number):number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE principal_id=? AND at_ms>=? AND at_ms<? AND (kind='amount_changed' OR (kind='voice_attempt' AND json_extract(data,'$.verdict') IN ('uncertain','fail')))").get(principal,start,end) as {n:number}).n;
  }
}
