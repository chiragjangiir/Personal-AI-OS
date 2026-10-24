import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createGlassesEnrollment} from '../src/paired-device-registration.ts';
import {RealtimePublicControlController,isRealtimePublicControlRoute} from '../src/realtime-public-control-controller.ts';
import {paymentFixture,phone,signed} from '../../../services/personal-aios-integration/tests/payment-fixture.ts';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
test('reverse QR HTTP flow binds immutable Mac key, requires signed owner phone, expires and consumes once',async t=>{
  const payment=await paymentFixture(t),requests=new Map<string,Record<string,unknown>>(),devices:Record<string,unknown>[]=[];
  let now=payment.now,serial=0,active=true,expireAtLock=false,activationFailure=false,snapshot:unknown;
  const phoneToken='phone-bearer-token-123456';
  const query=async(sql:string,args:unknown[]=[])=>{
    const request=requests.get(String(args[0]));
    if(sql==='BEGIN')snapshot=structuredClone({requests,devices});
    if(sql==='ROLLBACK'){const old=snapshot as {requests:typeof requests;devices:typeof devices};requests.clear();for(const [k,v] of old.requests)requests.set(k,v);devices.splice(0,devices.length,...old.devices);}
    if(sql.startsWith('DELETE FROM mac_pairing_requests WHERE nonce_sha256'))requests.delete(String(args[0]));
    if(sql.startsWith('DELETE FROM mac_pairing_requests WHERE expires_at')){for(const [k,v] of requests)if(String(v.expires_at)<=String(args[0]))requests.delete(k);}
    if(sql.startsWith('INSERT INTO mac_pairing_requests'))requests.set(String(args[0]),{poll:args[1],registration:JSON.parse(String(args[2])),expires_at:args[3],phone_device_id:null});
    if(sql.startsWith("SELECT r.registration->>'label'")){
      if(args[2]!==hash(phoneToken)||!active)return {rows:[]};
      if(request&&String(request.expires_at)>String(args[1]))return {rows:[{label:(request.registration as Record<string,unknown>).label,public_key_sha256:(request.registration as Record<string,unknown>).public_sha256,expires_at:request.expires_at,status:request.phone_device_id===null?'pending':'approved'}]};
      const paired=devices.find(v=>(v.governance as Record<string,unknown>).mac_pairing_nonce_sha256===args[0]);
      return {rows:paired&&Date.parse(String(paired.paired_at))+300_000>Date.parse(String(args[1]))?[{label:paired.label,public_key_sha256:paired.digest,expires_at:new Date(Date.parse(String(paired.paired_at))+300_000),status:'connected'}]:[]};
    }
    if(sql.startsWith('SELECT r.registration'))return {rows:request&&request.phone_device_id===null&&String(request.expires_at)>String(args[1])&&args[2]===hash(phoneToken)&&active?[{...request,device_id:phone.device_id,user_id:phone.principal_id}]:[]};
    if(sql.startsWith('UPDATE mac_pairing_requests')){if(!request||request.phone_device_id!==null||String(request.expires_at)<=String(args[1])||args[2]!==hash(phoneToken)||!active)return {rows:[]};request.phone_device_id=phone.device_id;return {rows:[request]};}
    if(sql.startsWith('SELECT registration,phone_device_id'))return {rows:request&&request.poll===args[1]&&String(request.expires_at)>String(args[2])?[request]:[]};
    if(sql.startsWith('SELECT p.user_id::text, r.expires_at, r.phone_device_id::text FROM mac_pairing_requests')){if(!request||request.poll!==args[1]||!request.phone_device_id||!active||String(request.expires_at)<=String(args[2])||JSON.stringify(request.registration)!==args[3])return {rows:[]};if(expireAtLock)now=Date.parse(String(request.expires_at));return {rows:[{user_id:phone.principal_id,phone_device_id:phone.device_id,expires_at:request.expires_at}]};}
    if(sql.startsWith("SELECT governance->'pairing_exchange_receipts'"))return {rows:devices.filter(v=>v.status==='active'&&(v.governance as Record<string,Record<string,unknown>>).pairing_exchange_receipts?.[String(args[0])]).map(v=>({receipt:(v.governance as Record<string,Record<string,unknown>>).pairing_exchange_receipts[String(args[0])]}))};
    if(sql.startsWith('UPDATE paired_devices SET governance')){const row=devices.find(v=>v.device_id===args[0])!;(row.governance as Record<string,unknown>).pairing_exchange_receipts=JSON.parse(String(args[1]));return {rows:[]};}
    if(sql.startsWith('SELECT user_id::text FROM paired_devices WHERE device_id'))return {rows:active&&args[0]===phone.device_id?[{user_id:phone.principal_id}]:[]};
    if(sql.startsWith('SELECT user_id'))return {rows:[{user_id:phone.principal_id}]};
    if(sql.includes('WHERE recipient_public_key_sha256'))return {rows:devices.filter(v=>v.status==='active'&&v.recipient_public_key_sha256===args[0])};
    if(sql.startsWith("UPDATE paired_devices SET status = 'revoked'")){const revoked=devices.filter(v=>v.status==='active'&&v.recipient_public_key_sha256===args[2]);for(const v of revoked)v.status='revoked';return {rows:revoked};}
    if(sql.startsWith('INSERT INTO paired_devices'))devices.push({device_id:args[0],user_id:args[1],status:'active',device_class:args[9],token_sha256:args[2],publicKey:args[3],recipient_public_key_sha256:args[4],digest:args[4],media:args[6],governance:JSON.parse(String(args[7])),paired_at:args[8],label:args[10]});
    return {rows:[]};
  };
  const enrollment=createGlassesEnrollment({pool:{query,connect:async()=>({query,release(){}})} as never,identity:{createConnectionId:()=>`id-${++serial}`},
    origin:'https://ai.example.invalid',artifactDirectory:payment.directory,now:()=>now,activate:async()=>{if(activationFailure)throw new Error('ACTIVATION_FAILED');},
    verifyMacApproval:async(owner,nonce,digest,input)=>{assert.deepEqual(owner,{deviceId:'phone',userId:'owner'});await payment.authority.verifyMacPairing(phone,input,nonce,digest);}});
  const controller=new RealtimePublicControlController({enabled:true,controlHost:'ai.example.invalid',runtime:Object.fromEntries(['bootstrap','resolveE2eeKey','refresh','stop','endContinuity','close'].map(name=>[name,async()=>{throw new Error('UNEXPECTED_RTC_CALL');}])) as never,
    schemaRegistry:{} as never,edge:{authorize:async()=>{}},bearer:{authorize:async()=>{throw new Error('UNEXPECTED_BEARER_CALL');}},glassesEnrollment:enrollment});
  const server=createServer((req,res)=>{void controller.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address() as {port:number};
  const post=async(action:string,body:unknown,token?:string)=>{const response=await fetch(`http://127.0.0.1:${address.port}/v1/devices/mac/pairing/${action}`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as Record<string,unknown>};};
  const raw=Buffer.alloc(32,9),registration={label:'书房 Mac',device_type:'mac',capabilities:['display','speaker','camera','chat_ui','desktop_tools'],public_raw32_base64url:raw.toString('base64url'),public_sha256:hash(raw)};
  const create=async()=>{const result=await post('request',{registration});assert.equal(result.status,200);assert.equal(result.body.public_key_sha256,registration.public_sha256);return result.body;};
  const proof=(qr:Record<string,unknown>,key=payment.user,digest=registration.public_sha256)=>signed(key,{purpose:'mac_pairing',device_id:'phone',nonce:qr.nonce,public_key_sha256:digest});
  const qr=await create(),poll={nonce:qr.nonce,poll_token:qr.poll_token};
  assert.equal((await post('preview',{nonce:qr.nonce},'guest-token-123456789')).status,403);
  const preview=await post('preview',{nonce:qr.nonce},phoneToken);
  assert.equal(preview.status,200);assert.deepEqual(preview.body,{label:'书房 Mac',public_key_sha256:registration.public_sha256,expires_at:qr.expires_at,status:'pending'});
  assert.equal((await post('exchange',poll)).body.status,'pending');
  assert.equal((await post('exchange',{...poll,poll_token:Buffer.alloc(32,1).toString('base64url')})).status,403);
  assert.equal((await post('approve',{nonce:qr.nonce,owner_confirmed:true},phoneToken)).status,422);
  assert.equal((await post('approve',{nonce:qr.nonce,owner_proof:proof(qr)},'guest-token-123456789')).status,403);
  assert.equal((await post('approve',{nonce:qr.nonce,owner_proof:proof(qr,payment.dev)},phoneToken)).status,403);
  assert.equal((await post('approve',{nonce:qr.nonce,owner_proof:proof(qr,payment.user,'b'.repeat(64))},phoneToken)).status,403);
  assert.equal((await post('approve',{nonce:qr.nonce,owner_proof:proof(qr)},phoneToken)).status,200);
  assert.equal((await post('preview',{nonce:qr.nonce},phoneToken)).body.status,'approved');
  assert.equal((await post('approve',{nonce:qr.nonce,owner_proof:proof(qr)},phoneToken)).status,403);
  const paired=await post('exchange',poll);assert.equal(paired.status,200);assert.equal(paired.body.schema,'paios.device-pairing.v1');
  assert.equal(devices.length,1);assert.equal(devices[0]!.publicKey,registration.public_raw32_base64url);assert.deepEqual(paired.body.media,['data','video']);
  assert.equal((await post('preview',{nonce:qr.nonce},phoneToken)).body.status,'connected');
  await t.test('Mac replay retrieves the committed result after a lost response',async()=>{
    assert.deepEqual(await post('exchange',poll),paired);assert.equal(devices.length,1);
  });
  await assert.rejects(enrollment.exchangeMac(qr.nonce,Buffer.alloc(32,2).toString('base64url')),/MAC_PAIRING_EXPIRED_OR_USED/);
  await t.test('Mac activation failure preserves the committed exchange receipt',async()=>{
    const retry=await create();await enrollment.approveMac(phoneToken,retry.nonce,proof(retry));activationFailure=true;
    await assert.rejects(enrollment.exchangeMac(retry.nonce,retry.poll_token),/ACTIVATION_FAILED/);activationFailure=false;
    const device=devices.at(-1)!;const result=await enrollment.exchangeMac(retry.nonce,retry.poll_token);
    assert.ok('device_id' in result);assert.equal(result.device_id,device.device_id);
    await assert.rejects(enrollment.exchangeMac(qr.nonce,qr.poll_token),/MAC_PAIRING_EXPIRED_OR_USED/);
    device.status='revoked';await assert.rejects(enrollment.exchangeMac(retry.nonce,retry.poll_token),/MAC_PAIRING_EXPIRED_OR_USED/);
  });
  const expired=await create();now+=300_000;
  assert.equal((await post('approve',{nonce:expired.nonce,owner_proof:proof(expired)},phoneToken)).status,403);
  assert.equal((await post('exchange',{nonce:expired.nonce,poll_token:expired.poll_token})).status,403);
  assert.equal((await post('preview',{nonce:expired.nonce},phoneToken)).status,403);
  assert.equal((await post('preview',{nonce:qr.nonce},phoneToken)).status,403);
  const waiting=await create();assert.equal((await post('approve',{nonce:waiting.nonce,owner_proof:proof(waiting)},phoneToken)).status,200);
  expireAtLock=true;assert.equal((await post('exchange',{nonce:waiting.nonce,poll_token:waiting.poll_token})).status,403);expireAtLock=false;
  assert.equal(devices.length,2,'expiry while waiting for the phone lock cannot create a terminal');
  const revoked=await create();assert.equal((await post('approve',{nonce:revoked.nonce,owner_proof:proof(revoked)},phoneToken)).status,200);active=false;
  assert.equal((await post('exchange',{nonce:revoked.nonce,poll_token:revoked.poll_token})).status,403);
  for(const action of ['request','preview','approve','exchange']){assert.ok(isRealtimePublicControlRoute('POST',`/v1/devices/mac/pairing/${action}`));assert.equal(isRealtimePublicControlRoute('GET',`/v1/devices/mac/pairing/${action}`),false);}
});
