import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry, type SpeakerModel} from '../src/voiceprint/registry.ts';

const DIM=32, AT='2026-10-17T08:00:00.000Z';
const MODEL:SpeakerModel={id:'call-boundary-test',sha256:'c'.repeat(64),dim:DIM};
function vector(owner:number, sign=1, seed?:number) {
  const value=new Float32Array(DIM);value[0]=owner;value[1]=sign*Math.sqrt(1-owner*owner);
  if(seed!==undefined)value[2+seed%30]=.01+.0001*seed;
  const norm=Math.hypot(...value);return Float32Array.from(value,x=>x/norm);
}
function axes(a:number,b:number){const v=new Float32Array(DIM);v[0]=a;v[1]=b;v[2]=Math.sqrt(1-a*a-b*b);return v;}
const BASE=vector(1), CALL=vector(.68), UNCERTAIN=vector(.5), TV=vector(.42);
const input=(mode:'call'|'verify'|'interrupt'|'observe'='call',speech_ms=1500,offset_ms=0)=>({mode,speech_ms,observed_at:new Date(Date.parse(AT)+offset_ms).toISOString()});
async function setup(t:test.TestContext, call_learning=true) {
  const root=await fs.mkdtemp(join(tmpdir(),'paios-call-learning-'));
  const storage=new PosixStorage(root),registries:VoiceprintRegistry[]=[];
  const open=(learning=call_learning)=>{const r=new VoiceprintRegistry(storage,MODEL,{call_learning:learning});registries.push(r);return r;};
  t.after(async()=>{for(const r of registries)await r.close();await fs.rm(root,{recursive:true,force:true});});
  const registry=open();
  await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'replace',samples:Array.from({length:5},()=>({embedding:BASE,speech_ms:2000})),at:AT});
  const document=async(flush=true)=>{if(flush)await registry.flush();return JSON.parse(await fs.readFile(join(root,'voiceprints',(await fs.readdir(join(root,'voiceprints')))[0]!), 'utf8'));};
  return {registry,open,document,root,storage};
}
async function seed(registry:VoiceprintRegistry,n=5) {
  for(let i=0;i<n;i++){const identity=await registry.identify(vector(.68,1,i),input('call',1500,i*1500));assert.equal(identity.kind,'owner');assert.equal(identity.kind==='owner'&&identity.band,'verified');assert.ok(identity.kind==='owner'&&!identity.call_only&&identity.score>=.65);}
}
function promoted(identity:Awaited<ReturnType<VoiceprintRegistry['identify']>>) {
  assert.equal(identity.kind,'owner');
  assert.equal(identity.kind==='owner'&&identity.band,'verified');
  assert.equal(identity.kind==='owner'&&identity.call_only,true);
}

test('call learning requires five independent-base-verified windows, persists and leaves payment/ordinary modes unchanged',async t=>{
  const {registry,open,document}=await setup(t);const before=(await document()).owner_sets;
  await assert.rejects(registry.enrollOwner({speaker_model:MODEL,channel:'call',mode:'replace',
    samples:Array.from({length:5},()=>({embedding:BASE,speech_ms:2000})),at:AT}),/VOICEPRINT_CHANNEL_INVALID/);
  await seed(registry,4);assert.equal((await registry.owner('call')).enrolled,false);
  assert.deepEqual(await registry.identify(UNCERTAIN,input()),{kind:'owner',band:'uncertain',score:.5});
  await registry.identify(vector(.68,1,4),input('call',1500,6000));
  assert.equal((await registry.owner('call')).enrolled,true);
  for(const ms of [400,600])assert.deepEqual(await registry.identify(UNCERTAIN,input('call',ms)),{kind:'unknown',reason:'too_short'});
  promoted(await registry.identify(UNCERTAIN,input('call',1000)));
  assert.deepEqual(await registry.identify(UNCERTAIN,input('call',199)),{kind:'unknown',reason:'too_short'});
  assert.deepEqual((await registry.owner()).channels.map(c=>c.channel),['file','call']);
  const snapshot=await document();assert.deepEqual(snapshot.owner_sets,before);assert.equal(snapshot.call_owner.samples.length,5);
  for(const mode of ['verify','interrupt','observe'] as const)
    assert.deepEqual(await registry.identify(UNCERTAIN,input(mode)),{kind:'owner',band:'uncertain',score:.5},mode);
  assert.deepEqual((await document()).call_owner,snapshot.call_owner,'verification, interruption and observation never train the call profile');
  await registry.close();const reopened=open();promoted(await reopened.identify(UNCERTAIN,input()));
  assert.deepEqual(await reopened.identify(UNCERTAIN,input('verify')),{kind:'owner',band:'uncertain',score:.5});
  const baseline=open(false);assert.deepEqual(await baseline.identify(UNCERTAIN,input()),{kind:'owner',band:'uncertain',score:.5});
});

test('call profile rejects short windows, exact duplicates, inconsistent seeds and cannot learn from its own verdict',async t=>{
  const {registry,document}=await setup(t);
  await registry.identify(CALL,input('call',999));assert.equal((await document()).call_owner,undefined);
  await registry.identify(CALL,input('call',1000));await registry.identify(CALL,input('call',1000,1000));
  assert.equal((await document()).call_owner.samples.length,1,'an exact duplicate is not fresh evidence');
  await registry.identify(vector(.68,-1),input('call',1500,1500));
  assert.equal((await document()).call_owner.samples.length,1,'inconsistent independent-base-verified seed is rejected');
  for(let i=0;i<4;i++)await registry.identify(vector(.68,1,i),input('call',1500,(i+1)*1500));
  const before=(await document()).call_owner;
  for(let i=0;i<8;i++)promoted(await registry.identify(vector(.5,1,10+i),input('call',1500,10000+i*1500)));
  assert.deepEqual((await document()).call_owner,before,'derived verified verdicts never become training evidence');
  const scores=await registry.scoreChannels(TV);assert.ok(scores.call!>.9);assert.ok(scores.file!<.45);
  assert.deepEqual(await registry.identify(TV,input()),{kind:'unknown',reason:'unmatched'},'TV remains unmatched despite strong call similarity');
  assert.deepEqual((await document()).call_owner,before);
});

test('call samples remain bounded and disabled baseline never learns',async t=>{
  const {registry,document}=await setup(t);await seed(registry,25);
  assert.equal((await registry.owner('call')).samples,20);assert.equal((await document()).call_owner.samples.length,20);
  const baseline=await setup(t,false);await seed(baseline.registry);
  assert.equal((await baseline.document()).call_owner,undefined);
});

test('better known guest and assistant evidence cannot seed or use the call profile',async t=>{
  for(const kind of ['guest','assistant'] as const){
    const {registry,document}=await setup(t);await seed(registry);
    if(kind==='guest'){
      await registry.forgetOwner();await registry.identify(axes(.5,.3),input('observe',2500));
      await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'replace',samples:Array.from({length:5},()=>({embedding:BASE,speech_ms:2000})),at:AT});
      await seed(registry);
    }else await registry.observeAssistant({voice:'system_tts',embedding:UNCERTAIN,speech_ms:2000,at:AT});
    const before=(await document()).call_owner;
    assert.equal(before.samples.length,5);
    const query=kind==='guest'?axes(.5,.75):UNCERTAIN;
    assert.ok((await registry.scoreChannels(query)).call!>.65);
    const identity=await registry.identify(query,input());assert.equal(identity.kind,kind==='guest'?'speaker':'assistant');
    await registry.identify(kind==='guest'?axes(.68,.2):vector(.68,1,29),input('call',1500,10000));
    assert.deepEqual((await document()).call_owner,before,'a better competing voice also blocks seed admission');
  }
});

test('forget invalidates derived call evidence',async t=>{
  for(const reset of ['call','file','all'] as const){
    const {registry,open,document}=await setup(t);await seed(registry);
    await registry.forgetOwner(reset==='all'?undefined:reset);
    assert.equal((await document()).call_owner,undefined,reset);
    await registry.close();const reopened=open();assert.equal((await reopened.owner('call')).enrolled,false);
    assert.notEqual((await reopened.identify(UNCERTAIN,input()) as {band?:string}).band,'verified');
    if(reset==='call')assert.equal((await reopened.owner('file')).enrolled,true);
  }
});

test('a legacy writer changing independent enrollment invalidates the persisted call source binding',async t=>{
  const {registry,root,open,document}=await setup(t);await seed(registry);await registry.close();
  const doc=await document(false);doc.owner_sets[0].updated_at='2026-10-17T09:00:00.000Z';
  const path=join(root,'voiceprints',(await fs.readdir(join(root,'voiceprints')))[0]!);await fs.writeFile(path,JSON.stringify(doc));
  const reopened=open();assert.equal((await reopened.owner('call')).enrolled,false);
  assert.deepEqual(await reopened.identify(UNCERTAIN,input()),{kind:'owner',band:'uncertain',score:.5});
});


test('legacy registry reads independent enrollment and its re-enrollment invalidates the call profile',async t=>{
  const {registry,root,open}=await setup(t);await seed(registry);await registry.close();
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-legacy-reader-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const sourceRoot=fileURLToPath(new URL('../src/',import.meta.url));
  let legacy=execFileSync('git',['show','94006762:01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/registry.ts'],{encoding:'utf8'});
  for(const [specifier,path] of Object.entries({'../contracts.ts':'contracts.ts','../storage.ts':'storage.ts','../ambient/lane.ts':'ambient/lane.ts','../visual/store.ts':'visual/store.ts','./contracts.ts':'voiceprint/contracts.ts','./cipher.ts':'voiceprint/cipher.ts'}))
    legacy=legacy.replace(JSON.stringify(specifier).replaceAll('"',"'"),JSON.stringify(join(sourceRoot,path)));
  const file=join(directory,'registry.ts');await fs.writeFile(file,legacy);
  const {VoiceprintRegistry:LegacyRegistry}=await import(pathToFileURL(file).href);
  const old=new LegacyRegistry(new PosixStorage(root),MODEL);
  try{
    assert.equal((await old.owner()).samples,5);assert.deepEqual((await old.owner()).channels.map((c:{channel:string})=>c.channel),['file']);
    assert.deepEqual(await old.identify(UNCERTAIN,input('verify')),{kind:'owner',band:'uncertain',score:.5});
    await old.enrollOwner({speaker_model:MODEL,channel:'file',mode:'replace',samples:Array.from({length:5},()=>({embedding:BASE,speech_ms:2000})),at:'2026-10-17T10:00:00.000Z'});
  }finally{await old.close();}
  const reopened=open();assert.equal((await reopened.owner('call')).enrolled,false);
  assert.deepEqual(await reopened.identify(UNCERTAIN,input()),{kind:'owner',band:'uncertain',score:.5});
});

test('absent POSIX storage reads never create a root or namespace',async t=>{
  const parent=await fs.mkdtemp(join(tmpdir(),'paios-storage-read-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const root=join(parent,'absent'),storage=new PosixStorage(root),key='0'.repeat(64);
  await assert.rejects(storage.read('voiceprints',key),{code:'ENOENT'});await assert.rejects(fs.stat(root),{code:'ENOENT'});
  await fs.mkdir(root);await assert.rejects(storage.read('voiceprints',key),{code:'ENOENT'});
  assert.deepEqual(await storage.list('stream-revisions'),[]);
  assert.deepEqual(await fs.readdir(root),[]);
});


test('overlapping updates of one long utterance cannot fill the call set; exact window gaps survive restart',async t=>{
  const {registry,document,open}=await setup(t);
  for(let i=0;i<5;i++)await registry.identify(vector(.68,1,i),input('call',1200,i*400));
  assert.equal((await registry.owner('call')).samples,2);
  assert.equal((await registry.owner('call')).enrolled,false);
  assert.deepEqual((await document()).call_owner.samples.map((s:{added_at:string})=>Date.parse(s.added_at)-Date.parse(AT)),[0,1200]);
  await registry.close();const reopened=open();
  await reopened.identify(vector(.68,1,8),input('call',1200,2399));
  assert.equal((await reopened.owner('call')).samples,2);
  await reopened.identify(vector(.68,1,9),input('call',1200,2400));
  assert.equal((await reopened.owner('call')).samples,3);
  await reopened.identify(vector(.68,1,10),input('call',1500,3600));
  assert.equal((await reopened.owner('call')).samples,3,'gap must cover the new, longer window');
  await reopened.identify(vector(.68,1,11),input('call',1500,3900));
  await reopened.identify(vector(.68,1,12),input('call',1000,4900));
  assert.equal((await reopened.owner('call')).samples,5);
  promoted(await reopened.identify(UNCERTAIN,input()));
});


test('biometric approval bootstraps a bounded call-only set below base matching floor', async t => {
  const {registry, document, open} = await setup(t);
  await registry.forgetOwner();
  const confirmed = vector(.2, 1, 0);
  const confirm = (embedding: Float32Array, offset=0, speech_ms=1500, quality=1) => registry.confirmCallOwner(embedding,
    {...input('call', speech_ms, offset), speaker_model: MODEL, quality});
  assert.deepEqual(await confirm(confirmed, 0, 999), {accepted:false});
  assert.deepEqual(await confirm(confirmed, 0, 1500, .1), {accepted:false});
  assert.deepEqual(await confirm(confirmed), {accepted:true});
  assert.equal((await registry.owner('call')).enrolled, false);
  for(let n=1;n<5;n++) await registry.identify(vector(.2,1,n), input('call',1500,n*1500));
  assert.equal((await registry.owner('call')).samples,5);
  assert.equal((await document()).call_owner.provenance,'biometric_confirmed');
  promoted(await registry.identify(vector(.2,1,6),input('call',1500,9000)));
  const prior=(await registry.owner('call')).samples;
  assert.deepEqual(await confirm(vector(.2,-1),11000),{accepted:false});
  await registry.identify(vector(.2,-1,8),input('call',1500,12000));
  assert.equal((await registry.owner('call')).samples,prior);
  for(let n=7;n<35;n++) await registry.identify(vector(.2,1,n),input('call',1500,15000+n*1500));
  assert.equal((await registry.owner('call')).samples,20);
  const snapshot=(await document()).call_owner;
  await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'add',samples:Array.from({length:5},()=>({embedding:BASE,speech_ms:2000})),at:'2026-10-17T10:00:00.000Z'});
  assert.deepEqual((await document()).call_owner.samples,snapshot.samples);
  await registry.close(); const reopened=open();
  promoted(await reopened.identify(vector(.2,1,6),input()));
  for(const mode of ['payment','verify','observe'] as const) assert.notEqual((await reopened.identify(confirmed,{...input(),mode})).kind,'owner');
  assert.deepEqual(reopened.matchCallAnchor(confirmed,{anchor:confirmed,speech_ms:199}),{kind:'unknown',reason:'too_short'});
  promoted(reopened.matchCallAnchor(confirmed,{anchor:confirmed,speech_ms:200}));
  assert.deepEqual(reopened.matchCallAnchor(vector(.2,-1),{anchor:confirmed,speech_ms:1500}),{kind:'unknown',reason:'unmatched'});
  await reopened.forgetOwner(); assert.equal((await reopened.owner('call')).samples,0);
});

test('enrollment add bootstraps and preserves revalidated independent learned sets',async t=>{
  const {registry,document}=await setup(t); await seed(registry);
  await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'add',samples:[{embedding:BASE,speech_ms:2000}],at:'2026-10-17T10:00:00.000Z'});
  assert.equal((await registry.owner('file')).samples,6); assert.equal((await registry.owner('call')).samples,5);
  await registry.enrollOwner({speaker_model:MODEL,channel:'mac',mode:'add',samples:Array.from({length:5},()=>({embedding:BASE,speech_ms:2000})),at:AT});
  assert.equal((await registry.owner('mac')).samples,5);
  await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'add',samples:Array.from({length:20},()=>({embedding:BASE,speech_ms:2000})),at:'2026-10-17T11:00:00.000Z'});
  const doc=await document(); const fileSet=doc.owner_sets.find((s:{channel:string})=>s.channel==='file');
  assert.equal(fileSet.samples.length,20); assert.equal(fileSet.samples[0].added_at,AT,'add retains earlier enrollment samples at the cap');
  assert.equal((await registry.owner('call')).enrolled,true);
});


test('device trust windows are scoped, expire after sixty seconds, and explicit calls hold until hangup', async t => {
  const {registry} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'phone'}, other = {...scope,device_id:'glasses'};
  let now = Date.parse(AT); t.mock.method(Date, 'now', () => now);
  const iso = () => new Date(now).toISOString();
  registry.openTrustWindow(scope, {at:iso()});
  assert.equal(registry.trustWindowActive(scope,iso()),true);
  assert.equal(registry.trustWindowActive(other,iso()),false);
  now += 1000;
  promoted(await registry.identify(CALL,{...input('call',1000,1000),...scope,call_id:'call-1',channel:'call'}));
  now += 70000; assert.equal(registry.trustWindowActive(scope,iso()),true);
  registry.closeTrustCall(scope,'call-1');
  assert.equal(registry.trustWindowActive(scope,iso()),false);
  registry.openTrustWindow(scope,{at:iso(),call_id:'call-2'});
  registry.closeTrustCall(scope,'call-2');
  now += 59999; assert.equal(registry.trustWindowActive(scope,iso()),true);
  now += 1; assert.equal(registry.trustWindowActive(scope,iso()),false);
  registry.openTrustWindow(scope,{at:iso()});
  now += 1000;
  promoted(await registry.identify(CALL,{...input('observe',1000,now-Date.parse(AT)),...scope,call_id:'ambient-stream',channel:'glasses'}));
  now += 60000; assert.equal(registry.trustWindowActive(scope,iso()),false,'ambient transport ID does not hold a call open');
});

test('trusted device capture learns separate bounded chains while different voices only receive call scope', async t => {
  const {registry,document,open} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'paired-device'};
  let now = Date.parse(AT); t.mock.method(Date, 'now', () => now);
  registry.openTrustWindow(scope,{at:AT});
  for (const channel of ['glasses','phone_app','mac'] as const) {
    for (let i=0;i<5;i++) {
      now += 1500;
      promoted(await registry.identify(vector(.2,1,i),{...input('verify',1500,now-Date.parse(AT)),...scope,channel}));
    }
  }
  const learned = (await document()).learned_owner;
  assert.deepEqual(Object.keys(learned),['glasses','phone_app','mac']);
  for (const set of Object.values(learned) as any[]) assert.equal(set.samples.length,5);
  now += 1500;
  promoted(await registry.identify(vector(.2,-1,15),{...input('verify',1500,now-Date.parse(AT)),...scope,channel:'glasses'}));
  assert.deepEqual((await document()).learned_owner,learned,'different speaker is answered without poisoning the owner chain');
  await registry.close(); const reopened = open();
  assert.equal(reopened.trustWindowActive(scope,new Date(now).toISOString()),false,'windows never survive restart');
  for (const channel of ['glasses','phone_app','mac'] as const) {
    promoted(await reopened.identify(vector(.2,1,7),{...input('verify'),channel}));
    assert.notEqual((await reopened.identify(vector(.2,1,7),{...input(),mode:'payment',channel})).kind,'owner');
  }
  await reopened.forgetOwner(); assert.deepEqual((await reopened.status() as any).learned_samples,{});
});

test('trusted processing rejects preapproval audio and excludes low quality, overlap, payment and interrupt from learning', async t => {
  const {registry,document} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'phone'};
  let now = Date.parse(AT)+10000; t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:new Date(now).toISOString()});
  assert.equal((await registry.identify(CALL,{...input('call',1500,9000),...scope})).kind,'unknown');
  now += 1000;
  promoted(await registry.identify(CALL,{...input('call',1500,11000),...scope}));
  assert.equal((await document()).call_owner,undefined,'evidence beginning before approval never enters learning');
  now += 1000;
  promoted(await registry.identify(CALL,{...input('call',1500,12000),...scope,quality:.1}));
  assert.equal((await document()).call_owner,undefined);
  now += 1500;
  promoted(await registry.identify(CALL,{...input('call',1500,13500),...scope}));
  now += 500;
  promoted(await registry.identify(vector(.68,1,4),{...input('call',1500,14000),...scope}));
  assert.equal((await document()).call_owner.samples.length,1);
  for (const mode of ['payment','interrupt'] as const) {
    const identity = await registry.identify(CALL,{...input('call',1500,14000),...scope,mode});
    assert.notEqual(identity.kind,'owner');
  }
  assert.equal((await document()).call_owner.samples.length,1);
  now += 60000;
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false);
  promoted(await registry.identify(CALL,{...input('call',1500,13500),...scope}));
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false,'queued capture evidence does not revive the current window');
  registry.openTrustWindow(scope,{at:new Date(now).toISOString()}); await registry.forgetOwner();
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false);
});


test('biometric ground truth repairs a cross-chain self cluster before trusted glasses learning and the next call', async t => {
  const {registry,document,open} = await setup(t);
  const scope = {principal_id:'owner',device_id:'glasses'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  const self = vector(.2,1,0), stranger = vector(.2,-1,0);
  const heardSelf = await registry.identify(self,{...input('observe',2500),channel:'glasses'});
  const heardOther = await registry.identify(stranger,{...input('observe',2500),channel:'glasses'});
  assert.equal(heardSelf.kind,'speaker'); assert.equal(heardOther.kind,'speaker');
  if (heardOther.kind !== 'speaker') throw new Error('stranger fixture must be a speaker');
  await registry.renameCluster(heardOther.cluster_id,{display_name:'Other person'});
  assert.deepEqual(await registry.confirmDeviceOwner(self,{...input('call',2500),channel:'glasses',speaker_model:MODEL}),{accepted:true});
  assert.deepEqual((await registry.clusters()).map(cluster=>cluster.cluster_id),[heardOther.cluster_id]);
  registry.openTrustWindow(scope,{at:AT});
  for (let n=1;n<5;n++) {
    now += 2500;
    promoted(await registry.identify(vector(.2,1,n),{...input('observe',2500,n*2500),...scope,channel:'glasses'}));
  }
  now += 2500;
  promoted(await registry.identify(stranger,{...input('observe',2500,12500),...scope,channel:'glasses'}));
  assert.equal((await document()).learned_owner.glasses.samples.length,5,'different speaker still receives trust scope but never becomes owner evidence');
  now += 60000;
  promoted(await registry.identify(vector(.2,1,6),{...input('call',1500,72500),channel:'glasses'}));
  assert.equal((await registry.identify(stranger,{...input('call',1500,72500),channel:'glasses'})).kind,'speaker');
  assert.notEqual((await registry.identify(self,{...input(),mode:'payment',channel:'glasses'})).kind,'owner');
  await registry.close(); const reopened = open();
  promoted(await reopened.identify(vector(.2,1,7),{...input('call'),channel:'glasses'}));
  assert.equal((await reopened.identify(stranger,{...input('call'),channel:'glasses'})).kind,'speaker');
});


test('a short biometric-confirmed utterance guards later collection without entering the durable sample set', async t => {
  const {registry,document} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'phone'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  assert.equal((await registry.identify(vector(.2,1),{...input('observe',2500),channel:'call'})).kind,'speaker');
  registry.openTrustWindow(scope,{at:AT,call_id:'short-call'});
  assert.deepEqual(await registry.confirmDeviceOwner(vector(.2,1),{speaker_model:MODEL,channel:'call',
    ...input('call',400),trust_scope:scope,call_id:'short-call'}),{accepted:false});
  assert.equal((await document()).call_owner,undefined);
  now += 1500;
  promoted(await registry.identify(vector(.2,-1),{...input('call',1500,1500),...scope,call_id:'short-call',channel:'call'}));
  assert.equal((await document()).call_owner,undefined,'different future voice receives a reply but cannot become the first library sample');
  now += 1500;
  promoted(await registry.identify(vector(.2,1,1),{...input('call',1500,3000),...scope,call_id:'short-call',channel:'call'}));
  assert.equal((await document()).call_owner.samples.length,1);
  assert.equal((await registry.clusters()).length,0,'the first anchor-matched full sample repairs the earlier self cluster');
});


test('a manual Mac trust window holds an explicitly identified call until hangup', async t => {
  const {registry} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'mac'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:AT});
  now += 1500;
  promoted(await registry.identify(vector(.2,1),{...input('call',1500,1500),...scope,channel:'mac',call_id:'explicit-mac-call'}));
  now += 61000;
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),true);
  registry.closeTrustCall(scope,'explicit-mac-call');
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false);
});


test('window capture at second 59 remains trusted when processed at second 65 without reviving expiry', async t => {
  const {registry,document} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'glasses'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:AT});
  now += 65000;
  const at = () => new Date(now).toISOString();
  assert.equal(registry.trustWindowActive(scope,at()),false);
  promoted(await registry.identify(vector(.2,1),{...input('verify',1500,59000),...scope,channel:'glasses',
    evidence_start_at:new Date(Date.parse(AT)+57500).toISOString()}));
  assert.equal((await document()).learned_owner.glasses.samples.length,1);
  assert.equal(registry.trustWindowActive(scope,at()),false);
  assert.notEqual((await registry.identify(vector(.2,1,1),{...input('verify',1500,60000),...scope,channel:'glasses'})).kind,'owner');
  assert.notEqual((await registry.identify(vector(.2,1,1),{...input('verify',1500,-1),...scope,channel:'glasses'})).kind,'owner');
  assert.equal((await document()).learned_owner.glasses.samples.length,1);
  promoted(await registry.identify(vector(.2,1,2),{...input('call',1500,59000),...scope,channel:'mac',call_id:'expired-job-call'}));
  assert.equal(registry.trustWindowActive(scope,at()),false,'an expired queued job cannot attach a new call hold');
  registry.openTrustWindow(scope,{at:at()});
  assert.notEqual((await registry.identify(vector(.2,1),{...input('verify',1500,59000),...scope,channel:'glasses'})).kind,'owner','reopening replaces the old expired window');
});

test('closed calls reject late evidence without collecting or resurrecting a hold', async t => {
  const {registry,document} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'phone'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:AT,call_id:'closed-call'});
  now += 70000;
  registry.closeTrustCall(scope,'closed-call');
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false);
  assert.deepEqual(await registry.identify(vector(.2,1),{...input('call',1500,59000),...scope,channel:'call',call_id:'closed-call'}),
    {kind:'unknown',reason:'unmatched'});
  assert.equal((await document()).call_owner,undefined);
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false);
  registry.openTrustWindow(scope,{at:new Date(now).toISOString()});
  registry.closeTrustCall(scope,'never-attached-call');
  now += 1000;
  assert.deepEqual(await registry.identify(vector(.2,1),{...input('call',1000,71000),...scope,channel:'call',call_id:'never-attached-call'}),
    {kind:'unknown',reason:'unmatched'},'a call that closed before its first identity job cannot attach later');
});

test('an aborted identity job waiting for the registry lock cannot learn from expired capture evidence', async t => {
  const {registry,document,storage} = await setup(t);
  const scope = {principal_id:'owner',device_id:'glasses'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:AT}); now += 65000;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const replace = storage.replace.bind(storage);
  t.mock.method(storage,'replace',async (...args: Parameters<PosixStorage['replace']>) => {
    entered.resolve(); await release.promise; await replace(...args);
  });
  const writing = registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'add',samples:[{embedding:BASE,speech_ms:2000}],at:AT});
  await entered.promise;
  const controller = new AbortController();
  const identity = registry.identify(vector(.2,1),{...input('verify',1500,59000),...scope,channel:'glasses',signal:controller.signal});
  controller.abort(); release.resolve();
  await writing;
  await assert.rejects(identity,{name:'AbortError'});
  assert.equal((await document()).learned_owner,undefined);
});


test('trusted windows still ignore known assistant echo while a stronger owner match remains usable', async t => {
  const {registry,document} = await setup(t);
  const scope = {principal_id:'owner',device_id:'phone'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  await registry.observeAssistant({voice:'known-tts',embedding:UNCERTAIN,speech_ms:2000,at:AT});
  registry.openTrustWindow(scope,{at:AT});
  assert.deepEqual(await registry.confirmDeviceOwner(BASE,{...input('call',1500),channel:'call',speaker_model:MODEL,trust_scope:scope}),{accepted:true});
  const before = (await document()).call_owner;
  now += 1500;
  assert.deepEqual(await registry.identify(UNCERTAIN,{...input('call',1500,1500),...scope,channel:'call'}),{kind:'assistant',score:1});
  assert.deepEqual((await document()).call_owner,before,'known assistant playback cannot become owner evidence');
  now += 1500;
  promoted(await registry.identify(vector(.99,1,2),{...input('call',1500,3000),...scope,channel:'call'}));
  assert.equal((await document()).call_owner.samples.length,2,'owner similarity beats adjacent assistant evidence');
});


test('replaying an older biometric approval cannot shorten a renewed trust window', async t => {
  const {registry} = await setup(t);
  const scope = {principal_id:'owner',device_id:'phone'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:AT});
  now += 30000;
  registry.openTrustWindow(scope,{at:new Date(now).toISOString()});
  registry.openTrustWindow(scope,{at:AT});
  now = Date.parse(AT)+89999;
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),true);
  now += 1;
  assert.equal(registry.trustWindowActive(scope,new Date(now).toISOString()),false);
});


test('read-only window attribution returns the owner without seeding a sampling guard or library', async t => {
  const {registry,document} = await setup(t); await registry.forgetOwner();
  const scope = {principal_id:'owner',device_id:'glasses'};
  let now = Date.parse(AT); t.mock.method(Date,'now',()=>now);
  registry.openTrustWindow(scope,{at:AT});
  now += 1500;
  promoted(await registry.identify(vector(.2,1),{...input('call',1500,1500),...scope,channel:'glasses',learning:false}));
  assert.equal((await document()).learned_owner,undefined);
  now += 1500;
  promoted(await registry.identify(vector(.2,-1),{...input('call',1500,3000),...scope,channel:'glasses'}));
  assert.equal((await document()).learned_owner.glasses.samples.length,1,'read-only speech does not anchor the next eligible sample to its voice');
});
