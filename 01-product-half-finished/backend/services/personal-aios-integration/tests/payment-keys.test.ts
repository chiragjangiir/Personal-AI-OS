import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentStore} from '../src/payment/store.ts';
import {PaymentKeys} from '../src/payment/keys.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';
const phone:RegisteredDevice={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture',consent_ref:'consent',route_version:'route',output_modes:['text']};
function pair(){const p=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),j=p.publicKey.export({format:'jwk'});return {...p,public_x963_b64:Buffer.concat([Buffer.from([4]),Buffer.from(j.x!,'base64url'),Buffer.from(j.y!,'base64url')]).toString('base64')};}
function signed(p:ReturnType<typeof pair>,statement:object){const b=Buffer.from(JSON.stringify(statement));return {statement_b64:b.toString('base64'),signature_b64:sign('sha256',b,p.privateKey).toString('base64')};}
test('I6 I8 I15: P256 DER exact-byte registration, co-signing, binding, transactional single-use challenges and no sensitive audit data',async()=>{
 const home=mkdtempSync(join(tmpdir(),'payment-keys-')),store=PaymentStore.open(home);let now=1000,active=true;
 const keys=new PaymentKeys({store,challenge_ttl_s:2,now:()=>now,revalidate:async s=>{assert.ok(active,'revoked');return s;}}),dev=pair(),user=pair();
 try {
  const register=async(p:ReturnType<typeof pair>,role:'device'|'user')=>{
   const {nonce}=await keys.challenge(phone,'keys_register'),statement={purpose:'keys_register',role,device_id:phone.device_id,nonce,key_sha256:createHash('sha256').update(Buffer.from(p.public_x963_b64,'base64')).digest('hex')};
   await keys.register(phone,{role,public_x963_b64:p.public_x963_b64,...signed(p,statement),...(role==='user'?{device_signature_b64:signed(dev,statement).signature_b64}:{})});
  };
  await register(dev,'device');await register(user,'user');await assert.rejects(register(dev,'device'),/PAYMENT_KEYS_ALREADY_REGISTERED/);
  const macNonce=Buffer.alloc(32,7).toString('base64url'),digest='a'.repeat(64);
  const macStatement={purpose:'mac_pairing',device_id:'phone',nonce:macNonce,public_key_sha256:digest};
  await keys.verify(phone,'mac_pairing',signed(user,macStatement),{public_key_sha256:digest},macNonce);
  await assert.rejects(keys.verify(phone,'mac_pairing',signed(dev,macStatement),{public_key_sha256:digest},macNonce),/PAYMENT_SIGNATURE_INVALID/);
  await assert.rejects(keys.verify(phone,'mac_pairing',signed(user,macStatement),{public_key_sha256:'b'.repeat(64)},macNonce),/PAYMENT_SIGNATURE_INVALID/);
  await assert.rejects(keys.verify(phone,'mac_pairing',signed(user,macStatement),{public_key_sha256:digest},Buffer.alloc(32,8).toString('base64url')),/PAYMENT_CHALLENGE_INVALID/);
  const {nonce}=await keys.challenge(phone,'phone_unlock'),input=signed(user,{purpose:'phone_unlock',device_id:'phone',nonce});
  await assert.rejects(keys.verify(phone,'phone_unlock',signed(dev,{purpose:'phone_unlock',device_id:'phone',nonce}),{}),/PAYMENT_SIGNATURE_INVALID/);
  const verified=await keys.verify(phone,'phone_unlock',input,{});
  assert.throws(()=>verified.commit(()=>{throw Error('mutation failed');}),/mutation failed/);
  verified.commit(()=>1);assert.throws(()=>verified.commit(()=>2),/PAYMENT_CHALLENGE_INVALID/);
  await assert.rejects(keys.verify(phone,'phone_unlock',input,{}),/PAYMENT_CHALLENGE_INVALID/);
  const challenge=await keys.challenge(phone,'settings');
  const statement={purpose:'settings',device_id:'phone',nonce:challenge.nonce,policy_version:1,change:{kind:'auto',enabled:true}};
  await assert.rejects(keys.verify(phone,'settings',signed(user,statement),{policy_version:1,change:{kind:'auto',enabled:false}}),/PAYMENT_SIGNATURE_INVALID/);
  await assert.rejects(keys.verify(phone,'settings',signed(user,{...statement,extra:true}),{policy_version:1,change:statement.change}),/PAYMENT_SIGNATURE_INVALID/);
  await assert.rejects(keys.verify(phone,'settings',{...signed(user,statement),statement_b64:Buffer.from(JSON.stringify(statement,null,2)).toString('base64')},{policy_version:1,change:statement.change}),/PAYMENT_SIGNATURE_INVALID/);
  now+=2001;await assert.rejects(keys.verify(phone,'settings',signed(user,statement),{policy_version:1,change:statement.change}),/PAYMENT_CHALLENGE_INVALID/);
  const oldest=await keys.challenge(phone,'phone_unlock');for(let i=0;i<8;i++)await keys.challenge(phone,'phone_unlock');
  await assert.rejects(keys.verify(phone,'phone_unlock',signed(user,{purpose:'phone_unlock',device_id:'phone',nonce:oldest.nonce}),{}),/PAYMENT_CHALLENGE_INVALID/);
  const wrongPurpose=await keys.challenge(phone,'approval');
  await assert.rejects(keys.verify(phone,'phone_unlock',signed(user,{purpose:'phone_unlock',device_id:'phone',nonce:wrongPurpose.nonce}),{}),/PAYMENT_CHALLENGE_INVALID/);
  await assert.rejects(keys.challenge(phone,'payment_decide' as never),/PAYMENT_CHALLENGE_PURPOSE_INVALID/);
  await assert.rejects(keys.verify(phone,'phone_unlock',{...input,signature_b64:Buffer.from([1,2,3]).toString('base64')},{}),/PAYMENT_SIGNATURE_INVALID/);
  active=false;await assert.rejects(keys.challenge(phone,'phone_unlock'),/revoked/);
  const audit=JSON.stringify(store.db.prepare('SELECT * FROM events').all());assert.ok(!audit.includes('statement_b64')&&!audit.includes(nonce)&&!audit.includes(input.signature_b64));
 } finally {store.close();rmSync(home,{recursive:true,force:true});}
});
test('challenge limit evicts oldest, binds device and purpose; card signatures bind exact authority nonce',async()=>{
 const home=mkdtempSync(join(tmpdir(),'payment-keys-')),store=PaymentStore.open(home),keys=new PaymentKeys({store,challenge_ttl_s:120,revalidate:async s=>s}),dev=pair();
 try {
  const {nonce}=await keys.challenge(phone,'keys_register');await keys.register(phone,{role:'device',public_x963_b64:dev.public_x963_b64,...signed(dev,{purpose:'keys_register',role:'device',device_id:'phone',nonce,key_sha256:createHash('sha256').update(Buffer.from(dev.public_x963_b64,'base64')).digest('hex')})});
  const expected={payment_id:'pay-id',decision:'pay',amount_fen:101,payee_key:null},cardNonce=Buffer.alloc(32,1).toString('base64url');
  const input=signed(dev,{purpose:'payment_decide',device_id:'phone',nonce:cardNonce,...expected});
  await keys.verify(phone,'payment_decide',input,expected,cardNonce);
  await assert.rejects(keys.verify(phone,'payment_decide',input,{...expected,amount_fen:102},cardNonce),/PAYMENT_SIGNATURE_INVALID/);
  await assert.rejects(keys.verify(phone,'payment_decide',input,expected,Buffer.alloc(32,2).toString('base64url')),/PAYMENT_CHALLENGE_INVALID/);
  const first=await keys.challenge(phone,'keys_register');for(let i=0;i<8;i++)await keys.challenge(phone,'keys_register');
  await assert.rejects(keys.register({...phone,device_id:'other'},{role:'device',public_x963_b64:dev.public_x963_b64,...signed(dev,{purpose:'keys_register',role:'device',device_id:'other',nonce:first.nonce,key_sha256:createHash('sha256').update(Buffer.from(dev.public_x963_b64,'base64')).digest('hex')})}),/PAYMENT_CHALLENGE_INVALID/);
 } finally {store.close();rmSync(home,{recursive:true,force:true});}
});

test('model settings Mac authorization uses existing registry, single-use nonce and cannot unlock payments',async()=>{
 const home=mkdtempSync(join(tmpdir(),'model-settings-keys-')),store=PaymentStore.open(home),keys=new PaymentKeys({store,challenge_ttl_s:120,now:()=>1000,revalidate:async s=>s});
 const user=pair(),macKey=pair(),mac={...phone,device_id:'mac',device_type:'mac' as const};
 try {
  store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run(phone.device_id,'user',phone.principal_id,user.public_x963_b64,1000);
  await assert.rejects(keys.challenge(mac,'model_settings'),/MODEL_SETTINGS_MAC_UNAUTHORIZED/);
  store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run(mac.device_id,'model_settings_pending',mac.principal_id,macKey.public_x963_b64,1000);
  const expected={action:'authorize_mac',draft_id:'draft',expected_revision:1,change_sha256:'a'.repeat(64),expires_at_ms:2000,principal_id:'owner'};
  const {nonce}=await keys.challenge(phone,'model_settings');
  const verified=await keys.verify(phone,'model_settings',signed(user,{purpose:'model_settings',device_id:'phone',nonce,...expected}),expected);
  await keys.registerModelSettings(phone,mac,macKey.public_x963_b64,verified);
  assert.equal(keys.registered(mac,'model_settings')?.public_x963_b64,macKey.public_x963_b64);
  await assert.rejects(keys.registerModelSettings(phone,mac,macKey.public_x963_b64,verified),/PAYMENT_CHALLENGE_INVALID/);
  const challenge=await keys.challenge(mac,'model_settings'),commit={...expected,action:'commit'};
  const input=signed(macKey,{purpose:'model_settings',device_id:'mac',nonce:challenge.nonce,...commit});
  const a=await keys.verify(mac,'model_settings',input,commit),b=await keys.verify(mac,'model_settings',input,commit);
  assert.throws(()=>a.commit(()=>{throw Error('CAS');}),/CAS/);b.commit(()=>1);
  assert.throws(()=>a.commit(()=>2),/PAYMENT_CHALLENGE_INVALID/);
  await assert.rejects(keys.challenge(mac,'phone_unlock'),/PAYMENT_SETTINGS_DEVICE_REQUIRED/);
  await assert.rejects(keys.verify(mac,'payment_decide',input,{}),/PAYMENT_SETTINGS_DEVICE_REQUIRED/);
  await assert.rejects(keys.verify(mac,'model_settings',input,{...commit,principal_id:'other'}),/PAYMENT_SIGNATURE_INVALID/);
  const expiredNonce=(await keys.challenge(mac,'model_settings')).nonce;
  await assert.rejects(keys.verify(mac,'model_settings',signed(macKey,{purpose:'model_settings',device_id:'mac',nonce:expiredNonce,...commit,expires_at_ms:999}),{...commit,expires_at_ms:999}),/MODEL_SETTINGS_SIGNATURE_EXPIRED/);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});

test('existing payment database migrates the device key role constraint without changing payment keys',()=>{
 const home=mkdtempSync(join(tmpdir(),'payment-key-migrate-'));let store=PaymentStore.open(home);const key=pair();
 try {
  store.db.exec("DROP TABLE device_keys;CREATE TABLE device_keys(device_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('device','user')),principal_id TEXT NOT NULL,public_x963_b64 TEXT NOT NULL,created_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER,PRIMARY KEY(device_id,role)) STRICT;");
  store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run('phone','user','owner',key.public_x963_b64,1000);store.close();
  store=PaymentStore.open(home);
  const row=store.db.prepare('SELECT * FROM device_keys WHERE device_id=?').get('phone');
  assert.equal(row?.public_x963_b64,key.public_x963_b64);assert.equal(row?.role,'user');assert.equal(row?.revoked_at_ms,null);
  store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run('mac','model_settings','owner',key.public_x963_b64,2000);
  store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run('mac','model_settings_pending','owner',key.public_x963_b64,2000);
  store.close();store=PaymentStore.open(home);assert.equal(store.db.prepare('SELECT count(*) AS n FROM device_keys').get()?.n,3);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
