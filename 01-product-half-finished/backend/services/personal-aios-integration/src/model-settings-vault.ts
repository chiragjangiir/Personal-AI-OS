import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {check} from './contracts.ts';

export interface SealedModelKey {ref:string;version:number;nonce:string;tag:string;ciphertext:string;last4:string;updated_at:string}
export function loadModelMasterKey(path:string):Buffer {
  const stat=lstatSync(path);
  check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o777)===0o600&&stat.uid===process.getuid?.(),'MODEL_VAULT_MASTER_PERMISSIONS',503);
  const key=readFileSync(path);check(key.length===32,'MODEL_VAULT_MASTER_INVALID',503);return key;
}
/** The vault stores one current ciphertext per credential. Revisions contain only its version. */
export class ModelVault {
  private readonly db:DatabaseSync;
  private readonly environment:string;
  private readonly master:Buffer;
  private readonly now:()=>number;
  constructor(db:DatabaseSync,environment:string,master:Buffer,now:()=>number){
    this.db=db;this.environment=environment;this.master=master;this.now=now;
    check(master.length===32,'MODEL_VAULT_MASTER_INVALID',503);
    db.exec(`PRAGMA secure_delete=ON;CREATE TABLE IF NOT EXISTS model_credentials(
      ref TEXT PRIMARY KEY,version INTEGER NOT NULL,nonce TEXT NOT NULL,tag TEXT NOT NULL,ciphertext TEXT NOT NULL,
      last4 TEXT NOT NULL,updated_at TEXT NOT NULL,test_status TEXT NOT NULL DEFAULT 'untested') STRICT;`);
  }
  version(ref:string):number|undefined {return (this.db.prepare('SELECT version FROM model_credentials WHERE ref=?').get(ref) as {version:number}|undefined)?.version;}
  seal(ref:string,key:string,version=(this.version(ref)??0)+1):SealedModelKey {
    check(typeof key==='string'&&key.trim()===key&&key.length>=8&&key.length<=8192&&!/[\r\n\0]/u.test(key),'MODEL_SETTINGS_KEY_INVALID');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.master,nonce);
    cipher.setAAD(Buffer.from(`${this.environment}\n${ref}\n${version}`));
    const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    return {ref,version,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64'),last4:key.slice(-4),updated_at:new Date(this.now()).toISOString()};
  }
  save(value:SealedModelKey):void {
    check(value.version>(this.version(value.ref)??0),'MODEL_SETTINGS_KEY_CONFLICT',409);
    this.db.prepare(`INSERT INTO model_credentials(ref,version,nonce,tag,ciphertext,last4,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(ref) DO UPDATE SET version=excluded.version,nonce=excluded.nonce,tag=excluded.tag,ciphertext=excluded.ciphertext,
      last4=excluded.last4,updated_at=excluded.updated_at,test_status='untested'`).run(value.ref,value.version,value.nonce,value.tag,value.ciphertext,value.last4,value.updated_at);
  }
  reveal(ref:string,version:number,staged?:SealedModelKey):string {
    const value=staged??this.db.prepare('SELECT * FROM model_credentials WHERE ref=?').get(ref) as unknown as SealedModelKey|undefined;
    check(value&&value.ref===ref&&value.version===version,'MODEL_SETTINGS_KEY_REENTRY_REQUIRED',409);
    const cipher=createDecipheriv('aes-256-gcm',this.master,Buffer.from(value.nonce,'base64'));
    cipher.setAAD(Buffer.from(`${this.environment}\n${ref}\n${version}`));cipher.setAuthTag(Buffer.from(value.tag,'base64'));
    return Buffer.concat([cipher.update(Buffer.from(value.ciphertext,'base64')),cipher.final()]).toString('utf8');
  }
  projection(ref:string,staged?:SealedModelKey) {
    const value=staged??this.db.prepare('SELECT last4,updated_at,test_status FROM model_credentials WHERE ref=?').get(ref) as {last4:string;updated_at:string;test_status:string}|undefined;
    return {configured:!!value,last4:value?.last4??null,updated_at:value?.updated_at??null,test_status:('test_status' in (value??{})?(value as {test_status:string}).test_status:'untested')};
  }
  untested(ref:string):void {this.db.prepare("UPDATE model_credentials SET test_status='untested' WHERE ref=?").run(ref);}
  tested(ref:string,version:number,status:'passed'|'failed'):void {this.db.prepare('UPDATE model_credentials SET test_status=? WHERE ref=? AND version=?').run(status,ref,version);}
}
