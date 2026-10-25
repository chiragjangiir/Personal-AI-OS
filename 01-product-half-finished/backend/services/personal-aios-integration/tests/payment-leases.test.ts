import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentStore} from '../src/payment/store.ts';
import {PaymentKeys} from '../src/payment/keys.ts';
import {PaymentLeases} from '../src/payment/leases.ts';
import {TerminalCards} from '../src/terminal-cards.ts';
import type {PaymentConfig,LockRow} from '../src/payment/contracts.ts';
import {GLASSES_CAPABILITIES,type RegisteredDevice} from '../src/source-authority.ts';
import {paymentFixture,signed as fixtureSigned} from './payment-fixture.ts';
import {PAYMENT_LIVE_LIMIT} from '../src/payment/wire-budget.ts';
const phone:RegisteredDevice={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture',consent_ref:'consent',route_version:'route',output_modes:['text']},glasses:RegisteredDevice={...phone,device_id:'glasses',device_type:'glasses',capabilities:GLASSES_CAPABILITIES};
test('I5 I15: phone presence, approval connection/wear identity, glasses lease invalidation and enrolment lifetime',async()=>{
 const home=mkdtempSync(join(tmpdir(),'payment-leases-')),store=PaymentStore.open(home);let now=1000,active=true,revalidation:Promise<void>|undefined;
 const config={challenge_ttl_s:120,locks:{phone_lease_max_s:60,phone_relock_s:1,glasses_lease_max_s:12,glasses_unlock_request_ttl_s:2},enrolment:{request_ttl_s:2,grant_ttl_s:10}} as PaymentConfig;
 const rows=new Map<string,LockRow>([phone,glasses].map(s=>[s.device_id,{device_id:s.device_id,principal_id:s.principal_id,device_type:s.device_type as 'phone'|'glasses',enabled:true,relock_s:null,updated_at_ms:now}]));
 const revalidate=async(s:RegisteredDevice)=>{assert.ok(active,'revoked');await revalidation;return s;},terminals=new TerminalCards(()=>now),keys=new PaymentKeys({store,challenge_ttl_s:120,revalidate,now:()=>now});
 const leases=new PaymentLeases({store,keys,terminals,config,revalidate,lock:s=>rows.get(s.device_id),now:()=>now});
 const pair=()=>{const p=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),j=p.publicKey.export({format:'jwk'});return {...p,public_x963_b64:Buffer.concat([Buffer.from([4]),Buffer.from(j.x!,'base64url'),Buffer.from(j.y!,'base64url')]).toString('base64')};},dev=pair(),user=pair();
 const signed=(p:typeof dev,s:object)=>{const b=Buffer.from(JSON.stringify(s));return {statement_b64:b.toString('base64'),signature_b64:sign('sha256',b,p.privateKey).toString('base64')};};
 const unlock=async()=>{const {nonce}=await keys.challenge(phone,'phone_unlock');await leases.unlock(phone,signed(user,{purpose:'phone_unlock',device_id:'phone',nonce}));};
 const approve=async(id:string)=>{const a=(await leases.approvals(phone)).find(a=>a.approval_id===id)!;return leases.decideApproval(phone,{approval_id:id,decision:'approve',...signed(user,{purpose:'approval',device_id:'phone',nonce:a.nonce,approval_id:id,kind:a.kind,target_device_id:'glasses',decision:'approve'})});};
 try {
  for(const [p,role] of [[dev,'device'],[user,'user']] as const){const {nonce}=await keys.challenge(phone,'keys_register'),s={purpose:'keys_register',role,device_id:'phone',nonce,key_sha256:createHash('sha256').update(Buffer.from(p.public_x963_b64,'base64')).digest('hex')};await keys.register(phone,{role,public_x963_b64:p.public_x963_b64,...signed(p,s),...(role==='user'?{device_signature_b64:signed(dev,s).signature_b64}:{})});}
  await unlock();assert.equal(await leases.valid(phone),true);assert.equal(await leases.valid(phone,now-1),false);
  await leases.detach(phone);assert.equal(leases.nextDeadline(),now+1001);now+=1000;assert.equal(await leases.valid(phone),true);
  await leases.presence(phone,'background');now++;leases.sweep();assert.equal(await leases.valid(phone),false);
  await leases.presence(phone,'foreground');assert.equal(await leases.valid(phone),false);
  await unlock();await leases.presence(phone,'locked');assert.equal(await leases.valid(phone),false);
  await unlock();now+=60000;assert.equal(await leases.valid(phone),false);
  let disconnect=terminals.connect(glasses,'session');terminals.wear(glasses,true,0);
  const stale=await leases.requestApproval(glasses,'glasses_unlock',undefined,0);disconnect();disconnect=terminals.connect(glasses,'session2');terminals.wear(glasses,true,0);
  await assert.rejects(approve(stale),/APPROVAL_WEAR_CHANGED/);assert.equal(await leases.valid(glasses),false);
  const oldDisconnect=disconnect;disconnect=terminals.connect(glasses,'session3');terminals.wear(glasses,true,0);
  oldDisconnect();assert.equal(terminals.connected(glasses),true);
  let resume!:()=>void;revalidation=new Promise<void>(resolve=>{resume=resolve;});
  const oldRequest=leases.requestApproval(glasses,'glasses_unlock',undefined,0);
  disconnect=terminals.connect(glasses,'session4');terminals.wear(glasses,true,0);revalidation=undefined;resume();
  await assert.rejects(oldRequest,/APPROVAL_WEAR_CHANGED/);
  const offBeforeApprove=await leases.requestApproval(glasses,'glasses_unlock',undefined,0);
  terminals.wear(glasses,false,0);terminals.wear(glasses,true,0);
  await assert.rejects(approve(offBeforeApprove),/APPROVAL_WEAR_CHANGED/);
  const good=await leases.requestApproval(glasses,'glasses_unlock',undefined,0);await approve(good);assert.equal(await leases.valid(glasses),true);assert.equal(await leases.valid(glasses,now-1),false);
  await assert.rejects(leases.decideApproval(phone,{approval_id:good,decision:'deny'}),/APPROVAL_NOT_FOUND/);
  terminals.wear(glasses,false,0);assert.equal(await leases.valid(glasses),false);terminals.wear(glasses,true,0);
  await approve(await leases.requestApproval(glasses,'glasses_unlock',undefined,0));
  const enrol=await leases.requestApproval(glasses,'voiceprint_enrol');await approve(enrol);assert.ok(await leases.enrolment(glasses));
  await leases.consumeEnrolment(glasses,'inconsistent');assert.ok(await leases.enrolment(glasses));
  await leases.consumeEnrolment(glasses,'enrolled');assert.equal(await leases.enrolment(glasses),undefined);
  // An ordinary conversation supplement is its own grant: it neither enables nor consumes the payment sentences.
  await approve(await leases.requestApproval(glasses,'voice_enrollment'));
  assert.equal(await leases.enrolment(glasses),undefined);assert.ok(await leases.enrolment(glasses,false,'voice_enrollment'));
  await leases.consumeEnrolment(glasses,'enrolled','voice_enrollment');assert.equal(await leases.enrolment(glasses,false,'voice_enrollment'),undefined);
  await approve(await leases.requestApproval(glasses,'voiceprint_enrol'));now+=10000;assert.equal(await leases.enrolment(glasses),undefined);await assert.rejects(leases.enrolment(glasses,true),/VOICEPRINT_ENROL_GRANT_EXPIRED/);
  const beforeOff=await leases.requestApproval(glasses,'glasses_unlock',undefined,0);
  leases.lock(glasses,'screen_off');await assert.rejects(approve(beforeOff),/APPROVAL_WEAR_CHANGED/);assert.equal(await leases.valid(glasses),false);
  await approve(await leases.requestApproval(glasses,'glasses_unlock',undefined,0));
  const snapshot=terminals.lease(glasses)!;assert.equal(snapshot.lock_cycle,0);
  const oldCycle=await leases.requestApproval(glasses,'glasses_unlock',undefined,0);
  const newCycle=await leases.requestApproval(glasses,'glasses_unlock',undefined,1);assert.equal(await leases.valid(glasses),false);
  await assert.rejects(leases.decideApproval(phone,{approval_id:oldCycle,decision:'deny'}),/APPROVAL_NOT_FOUND/);await approve(newCycle);
  assert.equal(terminals.lease(glasses)!.lock_cycle,1);assert.equal(snapshot.lock_cycle,0);
  await assert.rejects(leases.requestApproval(glasses,'glasses_unlock',undefined,0),/APPROVAL_WEAR_CHANGED/);
  terminals.wear(glasses,false,2);terminals.wear(glasses,true,2);assert.equal(await leases.valid(glasses),false);
  await approve(await leases.requestApproval(glasses,'glasses_unlock',undefined,2));
  terminals.wear(glasses,true);assert.equal(await leases.valid(glasses),false);await assert.rejects(leases.requestApproval(glasses,'glasses_unlock',undefined,2),/GLASSES_NOT_WORN/);
  terminals.wear(glasses,true,0);
  await approve(await leases.requestApproval(glasses,'glasses_unlock',undefined,0));now+=12000;assert.equal(await leases.valid(glasses),false);
  await approve(await leases.requestApproval(glasses,'glasses_unlock',undefined,0));rows.get('glasses')!.enabled=false;assert.equal(await leases.valid(glasses),false);rows.get('glasses')!.enabled=true;
  const pending=await leases.requestApproval(glasses,'glasses_unlock',undefined,0);now+=2000;await assert.rejects(leases.decideApproval(phone,{approval_id:pending,decision:'deny'}),/APPROVAL_EXPIRED/);
  for(let i=0;i<PAYMENT_LIVE_LIMIT;i++)await leases.requestApproval(glasses,'glasses_unlock',undefined,0);
  await assert.rejects(leases.requestApproval(glasses,'glasses_unlock',undefined,0),{message:'APPROVAL_BUSY',status:409});assert.equal((await leases.approvals(phone)).length,PAYMENT_LIVE_LIMIT);
  active=false;await assert.rejects(leases.valid(glasses),/revoked/);
  const audit=JSON.stringify(store.db.prepare('SELECT * FROM events').all());assert.ok(!audit.includes('statement_b64')&&!audit.includes('nonce'));
  terminals.close();assert.equal(terminals.lease(glasses),undefined);
 } finally {store.close();rmSync(home,{recursive:true,force:true});}
});

test('approval admission preserves the full owner-scoped live set and reuses freed capacity',async t=>{
 const f=await paymentFixture(t),leases=f.authority.leases;
 const otherPhone={...phone,principal_id:'other-owner',device_id:'other-phone'},otherGlasses={...glasses,principal_id:'other-owner',device_id:'other-glasses'};
 f.terminals.connect(otherGlasses,'other-session');f.terminals.wear(otherGlasses,true,0);
 const ids=async(source=phone)=>(await leases.approvals(source)).map(a=>a.approval_id);
 const first:string[]=[],other:string[]=[];
 for(let i=0;i<PAYMENT_LIVE_LIMIT;i++){
  first.push(await leases.requestApproval(glasses,'voiceprint_enrol'));
  other.push(await leases.requestApproval(otherGlasses,'voiceprint_enrol'));
 }
 const eventCount=()=>f.authority.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='approval_requested'").get()!.n;
 const before=eventCount();
 await assert.rejects(leases.requestApproval(glasses,'voiceprint_enrol'),{message:'APPROVAL_BUSY',status:409});
 await assert.rejects(leases.requestApproval(otherGlasses,'voiceprint_enrol'),{message:'APPROVAL_BUSY',status:409});
 assert.deepEqual(await ids(),first);assert.deepEqual(await ids(otherPhone),other);assert.equal(eventCount(),before);
 await leases.decideApproval(phone,{approval_id:first[0]!,decision:'deny'});
 const replacement=await leases.requestApproval(glasses,'voiceprint_enrol');
 assert.deepEqual(await ids(),[...first.slice(1),replacement]);assert.deepEqual(await ids(otherPhone),other);
 f.terminals.wear(glasses,false,0);f.terminals.wear(glasses,true,0);
 const freshWear=await leases.requestApproval(glasses,'voiceprint_enrol');
 assert.deepEqual(await ids(),[freshWear]);assert.deepEqual(await ids(otherPhone),other);
 f.setNow(f.now+f.config.enrolment.request_ttl_s*1000);
 const freshTime=await leases.requestApproval(glasses,'voiceprint_enrol');
 assert.deepEqual(await ids(),[freshTime]);assert.deepEqual(await ids(otherPhone),[]);
});

test('cancelling an enrollment removes only this principal, device and kind, records it, and clears an already issued grant',async t=>{
 const f=await paymentFixture(t),leases=f.authority.leases;
 const other={...glasses,device_id:'other-glasses'},foreign={...glasses,principal_id:'other-owner'};
 for(const source of [other,foreign]){f.terminals.connect(source,'session');f.terminals.wear(source,true,0);}
 const cancelled=await leases.requestApproval(glasses,'voice_enrollment');
 const payment=await leases.requestApproval(glasses,'voiceprint_enrol');
 const foreignId=await leases.requestApproval(foreign,'voice_enrollment');
 await leases.cancelApproval(glasses,'voice_enrollment');
 assert.deepEqual((await leases.approvals(phone)).map(a=>a.approval_id),[payment]);
 const another=await leases.requestApproval(other,'voice_enrollment');
 await leases.cancelApproval(glasses,'voice_enrollment');
 assert.deepEqual((await leases.approvals(phone)).map(a=>a.approval_id),[payment,another]);
 assert.deepEqual((await leases.approvals({...phone,principal_id:'other-owner'})).map(a=>a.approval_id),[foreignId]);
 await assert.rejects(leases.decideApproval(phone,{approval_id:cancelled,decision:'deny'}),{message:'APPROVAL_NOT_FOUND',status:404});
 const event=f.authority.store.events().find(e=>e.kind==='approval_cancelled')!;
 assert.deepEqual(event.data,{approval_id:cancelled,kind:'voice_enrollment',target_device_id:glasses.device_id});
 await f.approve(payment);
 await f.approve(await leases.requestApproval(glasses,'voice_enrollment'));
 await leases.cancelApproval(glasses,'voice_enrollment');
 assert.equal(await leases.enrolment(glasses,false,'voice_enrollment'),undefined);assert.ok(await leases.enrolment(glasses));
});

test('cancelling while Face ID verification is in flight prevents its later synchronous grant commit',async t=>{
 const f=await paymentFixture(t),leases=f.authority.leases;
 const id=await leases.requestApproval(glasses,'voice_enrollment'),a=(await leases.approvals(phone))[0]!;
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),verify=f.authority.keys.verify.bind(f.authority.keys);
 t.mock.method(f.authority.keys,'verify',async(...args:Parameters<PaymentKeys['verify']>)=>{
  const verified=await verify(...args);entered.resolve();await release.promise;return verified;
 });
 const pending=leases.decideApproval(phone,{approval_id:id,decision:'approve',...fixtureSigned(f.user,{purpose:'approval',device_id:phone.device_id,
  nonce:a.nonce,approval_id:id,kind:a.kind,target_device_id:glasses.device_id,decision:'approve'})});
 try{
  await entered.promise;await leases.cancelApproval(glasses,'voice_enrollment');release.resolve();
  await assert.rejects(pending,{message:'APPROVAL_NOT_FOUND',status:404});
  assert.equal(await leases.enrolment(glasses,false,'voice_enrollment'),undefined);
  assert.equal(f.authority.store.events().filter(e=>e.kind==='enrolment_grant_issued').length,0);
 }finally{release.resolve();await pending.catch(()=>{});}
});

test('discarding an ordinary supplement consumes only its grant; clearing a source clears both grant kinds',async t=>{
 const f=await paymentFixture(t),leases=f.authority.leases;
 const other={...glasses,device_id:'other-glasses'};
 f.terminals.connect(other,'other-session');f.terminals.wear(other,true,0);
 const approve=async(source:RegisteredDevice,kind:'voiceprint_enrol'|'voice_enrollment')=>{
  const id=await leases.requestApproval(source,kind),a=(await leases.approvals(phone)).find(a=>a.approval_id===id)!;
  await leases.decideApproval(phone,{approval_id:id,decision:'approve',...fixtureSigned(f.user,{purpose:'approval',device_id:phone.device_id,
   nonce:a.nonce,approval_id:id,kind,target_device_id:source.device_id,decision:'approve'})});
 };
 for(const source of [glasses,other])for(const kind of ['voiceprint_enrol','voice_enrollment'] as const)await approve(source,kind);
 await leases.consumeEnrolment(glasses,'discarded','voice_enrollment');
 assert.equal(await leases.enrolment(glasses,false,'voice_enrollment'),undefined);
 assert.ok(await leases.enrolment(glasses));
 await approve(glasses,'voice_enrollment');
 leases.clear(glasses,'source_inactive');
 for(const kind of ['voiceprint_enrol','voice_enrollment'] as const){
  assert.equal(await leases.enrolment(glasses,false,kind),undefined);
  assert.ok(await leases.enrolment(other,false,kind));
 }
 leases.clear(other,'source_inactive');await leases.presence(phone,'locked');
 assert.equal(leases.nextDeadline(),undefined,'cleared grants leave no authorization deadline behind');
});

for(const ordering of ['pending verification','verified before commit'] as const)test(`locked presence cancels ${ordering} with real P-256 keys and no lease`,async t=>{
 const f=await paymentFixture(t);await f.locks();await f.authority.leases.presence(phone,'locked');
 const startedBefore=f.authority.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='lease_started' AND device_id='phone'").get()!.n;
 const {nonce}=await f.authority.keys.challenge(phone,'phone_unlock');
 const input=fixtureSigned(f.user,{purpose:'phone_unlock',device_id:phone.device_id,nonce});
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const revalidate=f.ports.revalidate,verify=f.authority.keys.verify.bind(f.authority.keys);
 let calls=0;
 if(ordering==='pending verification')f.ports.revalidate=async source=>{
  if(++calls===2){entered.resolve();await release.promise;}return revalidate(source);
 };
 else t.mock.method(f.authority.keys,'verify',async(...args:Parameters<PaymentKeys['verify']>)=>{
  const verified=await verify(...args);entered.resolve();await release.promise;return verified;
 });
 const pending=f.authority.leases.unlock(phone,input);
 try {
  await entered.promise;
  assert.equal(f.authority.leases.validNow(phone),false);
  await f.authority.leases.presence(phone,'locked');
  release.resolve();await assert.rejects(pending,{message:'PAYMENT_CHALLENGE_INVALID',status:403});
  assert.equal(await f.authority.leases.valid(phone),false);
  assert.equal(f.authority.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='lease_started' AND device_id='phone'").get()!.n,startedBefore);
  f.ports.revalidate=revalidate;t.mock.restoreAll();
  await f.unlock();assert.equal(await f.authority.leases.valid(phone),true);
 }finally{release.resolve();await pending.catch(()=>{});f.ports.revalidate=revalidate;}
});
