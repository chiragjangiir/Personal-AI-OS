import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AvatarProfileService,type AvatarProfileStore,type AvatarLook} from '../src/avatar-profile.ts';
import {ViduAvatarRequestRejected} from '../src/vidu-avatar-assets.ts';
import type {AvatarCommandRecord,AvatarProfileRecord,AvatarProfileTransaction} from '../../../services/platform-data/src/avatar-profile-repository.ts';

class Store implements AvatarProfileStore {
  profiles=new Map<string,AvatarProfileRecord>();commands=new Map<string,AvatarCommandRecord>();
  #tail:Promise<unknown>=Promise.resolve();
  async read(id:string){return structuredClone(this.profiles.get(id)??null);}
  async outstanding(){return [...this.commands.values()].filter(c=>['queued','submitting','pending'].includes(c.state)||c.state==='failed'&&c.error==='processing_timeout').map(c=>({principal_id:c.principal_id,command_id:c.command_id}));}
  async transact<T>(id:string,work:(tx:AvatarProfileTransaction)=>Promise<T>):Promise<T>{
    const task=this.#tail.then(async()=>{
      const profile=structuredClone(this.profiles.get(id)??{principal_id:id,version:0,active:null,active_avatar_id:null,requested_command:null});
      const commands=structuredClone(this.commands);
      const result=await work({profile,command:async key=>commands.get(id+':'+key)??null,
        saveCommand:async command=>{commands.set(id+':'+command.command_id,command);},
        creationBusy:async()=>[...commands.values()].some(c=>(['submitting','pending','submission_uncertain'].includes(c.state)||c.state==='failed'&&c.error==='processing_timeout'))});
      this.profiles.set(id,profile);this.commands=commands;return result;
    });
    this.#tail=task.catch(()=>{});return task;
  }
}
const ready:AvatarLook={look_id:'approved',style:'illustration',image_url:'https://assets.example/immutable/approved.jpg',focus:{x:0.5,y:0.4},vidu_avatar_id:'approved-provider-id'};
const fresh:AvatarLook={...ready,look_id:'new',image_url:'https://assets.example/immutable/new.jpg'};
delete fresh.vidu_avatar_id;
const command=(id='first',look='approved',version=0)=>({principal_id:'owner',device_id:'phone',command_id:id,expected_version:version,look_id:look,owner_request:'换成这个样子'});

test('ready appearance commits once, pins provider id, and rejects stale/reused commands',async()=>{
  const store=new Store();const service=new AvatarProfileService({store,looks:[ready]});
  const events:unknown[]=[];service.watch((principal,profile)=>events.push({principal,profile}));
  assert.equal(await service.read('owner'),null);
  const first=await service.change(command());
  assert.equal(first.status,'ready');assert.equal(first.profile?.version,1);
  assert.equal(await service.activeAvatarId('owner'),'approved-provider-id');
  assert.equal('vidu_avatar_id' in first.profile!,false);
  assert.deepEqual(await service.change(command()),first);assert.equal(events.length,1);
  await assert.rejects(service.change(command('stale')),/AVATAR_VERSION_CONFLICT/);
  await assert.rejects(service.change({...command(),owner_request:'different'}),/AVATAR_COMMAND_REUSED/);
  const restarted=new AvatarProfileService({store,looks:[ready]});
  assert.deepEqual(await restarted.read('owner'),first.profile);
  assert.equal(await restarted.read('other-owner'),null);
});

test('pending asset leaves all public state unchanged and restart GET commits after readiness',async()=>{
  const store=new Store();let creates=0;let gets=0;
  const assets={create:async()=>{creates++;return{id:'new-id',state:'pending' as const};},get:async()=>{gets++;return{id:'new-id',state:'ready' as const};}};
  const first=new AvatarProfileService({store,looks:[ready,fresh],assets});
  await first.change(command());const before=await first.read('owner');
  assert.equal((await first.change(command('generation','new',1))).status,'pending');
  assert.deepEqual(await first.read('owner'),before);assert.equal(await first.activeAvatarId('owner'),'approved-provider-id');
  const restarted=new AvatarProfileService({store,looks:[ready,fresh],assets});
  await restarted.reconcilePending();
  assert.equal((await restarted.read('owner'))?.version,2);assert.equal(await restarted.activeAvatarId('owner'),'new-id');
  assert.equal(creates,1);assert.equal(gets,1);
});

test('superseded provider success cannot replace the newer selected ready look',async()=>{
  const store=new Store();const assets={create:async()=>({id:'old-id',state:'pending' as const}),get:async()=>({id:'old-id',state:'ready' as const})};
  const service=new AvatarProfileService({store,looks:[ready,fresh],assets});
  await service.change(command('old','new'));
  const next=await service.change(command('latest'));
  assert.equal((await service.reconcile('owner','old')).status,'superseded');
  assert.deepEqual(await service.read('owner'),next.profile);
});

test('unknown POST outcome remains durable and is never automatically repeated',async()=>{
  const store=new Store();let attempts=0;
  const assets={create:async()=>{attempts++;throw new Error('connection lost after submission');},get:async()=>{throw new Error('must have known id');}};
  const service=new AvatarProfileService({store,looks:[fresh],assets});
  assert.equal((await service.change(command('uncertain','new'))).status,'submission_uncertain');
  const restarted=new AvatarProfileService({store,looks:[fresh],assets});
  await restarted.reconcilePending();
  assert.equal((await restarted.change(command('uncertain','new'))).status,'submission_uncertain');
  assert.equal((await restarted.change(command('queued','new'))).status,'pending');
  assert.equal(attempts,1);assert.equal(await restarted.read('owner'),null);
});

test('concurrent approved commands use version CAS and publish the winner only',async()=>{
  const store=new Store();const service=new AvatarProfileService({store,looks:[ready]});
  const results=await Promise.allSettled([service.change(command('phone')),service.change({...command('mac'),device_id:'mac'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await service.read('owner'))?.version,1);
});

test('disabled provider leaves durable preparation queued without claiming a submission',async()=>{
  const store=new Store();
  store.profiles.set('owner',{principal_id:'owner',version:0,active:null,active_avatar_id:null,requested_command:'queued'});
  store.commands.set('owner:queued',{...command('queued','new'),look:fresh,state:'queued',avatar_id:null,error:null,
    created_at:new Date().toISOString()});
  const service=new AvatarProfileService({store,looks:[ready,fresh]});
  await service.reconcilePending();
  assert.equal((await service.reconcile('owner','queued')).status,'pending');
  assert.equal(store.commands.get('owner:queued')!.state,'queued');
  assert.equal(store.commands.get('owner:queued')!.submission_started_at,undefined);
  assert.equal((await service.change(command())).status,'ready');
});

test('timed-out known assets retain account admission until provider terminal reconciliation',async()=>{
  const store=new Store();let creates=0;let readyNow=false;
  const assets={create:async()=>{creates++;return{id:'timed-id',state:'pending' as const};},get:async()=>({id:'timed-id',state:readyNow?'ready' as const:'pending' as const})};
  const service=new AvatarProfileService({store,looks:[fresh],assets});
  await service.change(command('timeout','new'));
  const stored=store.commands.get('owner:timeout')!;stored.submission_started_at=new Date(Date.now()-301_000).toISOString();
  assert.equal((await service.reconcile('owner','timeout')).error,'processing_timeout');
  assert.equal((await service.change({...command('other','new'),principal_id:'other-owner'})).status,'pending');
  assert.equal(creates,1);
  readyNow=true;assert.equal((await service.reconcile('owner','timeout')).status,'ready');
  await service.reconcilePending();assert.equal(creates,2);
});

test('source rejects configured projections that formal clients cannot publish',()=>{
  const invalid=[{...ready,look_id:'contains space'},{...ready,style:'a'.repeat(81)},
    {...ready,image_url:'HTTPS://assets.example/x'},{...ready,image_url:'https://assets.example/x?token=private'},
    {...ready,focus:{x:0.5,y:0.5,extra:1}},{...ready,extra:true}];
  for(const look of invalid)assert.throws(()=>new AvatarProfileService({store:new Store(),looks:[look]}),/AVATAR_/);
});

test('shutdown drains an admitted provider call and rejects new changes',async()=>{
  const store=new Store();let release!:(value:{id:string;state:'ready'})=>void;
  let submitted!:()=>void;const started=new Promise<void>(resolve=>{submitted=resolve;});
  const assets={create:async()=>{submitted();return new Promise<{id:string;state:'ready'}>(resolve=>{release=resolve;});},get:async()=>({id:'new-id',state:'ready' as const})};
  const service=new AvatarProfileService({store,looks:[fresh],assets});
  const changing=service.change(command('shutdown','new'));await started;
  let closed=false;const closing=service.close().then(()=>{closed=true;});
  await assert.rejects(service.change(command('later','new')),/AVATAR_PROFILE_CLOSED/);
  assert.equal(closed,false);release({id:'new-id',state:'ready'});
  assert.equal((await changing).status,'ready');await closing;assert.equal(closed,true);
});


test('restart without provider preserves pending and unknown durable commands for owner resume',async()=>{
  for(const uncertain of [false,true]){
    const store=new Store();let creates=0,gets=0;
    const assets={create:async()=>{creates++;if(uncertain)throw new Error('lost POST result');return{id:'pending-id',state:'pending' as const};},
      get:async()=>{gets++;return{id:'pending-id',state:'ready' as const};}};
    const first=new AvatarProfileService({store,looks:[ready,fresh],assets});
    await first.change(command());
    const before=await first.read('owner');
    const submitted=await first.change(command('resume','new',1));
    const restarted=new AvatarProfileService({store,looks:[ready,fresh]});
    assert.deepEqual(await restarted.readPreparation('owner'),submitted);
    assert.deepEqual(await restarted.reconcile('owner','resume'),submitted);
    assert.equal(await restarted.readPreparation('other-owner'),null);
    assert.deepEqual(await restarted.read('owner'),before);
    assert.equal(creates,1);assert.equal(gets,0);
    const enabled=new AvatarProfileService({store,looks:[ready,fresh],assets});
    assert.equal((await enabled.reconcile('owner','resume')).status,uncertain?'submission_uncertain':'ready');
    assert.equal(creates,1,'resume must never repeat the original provider POST');
  }
});

test('cancel during provider submission never activates the asset and retains admission until terminal reconciliation',async()=>{
  const store=new Store();let creates=0,done=false;
  const submitted=Promise.withResolvers<void>(),release=Promise.withResolvers<{id:string;state:'pending'}>();
  const assets={create:async()=>{creates++;submitted.resolve();return release.promise;},get:async()=>({id:'cancelled-asset',state:done?'ready' as const:'pending' as const})};
  const service=new AvatarProfileService({store,looks:[ready,fresh],assets});
  await service.change(command());const before=await service.read('owner');
  const generating=service.change(command('cancel-me','new',1));await submitted.promise;
  assert.equal((await service.cancel('owner','cancel-me')).status,'cancelled');
  release.resolve({id:'cancelled-asset',state:'pending'});
  assert.equal((await generating).status,'cancelled');
  assert.equal(store.commands.get('owner:cancel-me')?.avatar_id,'cancelled-asset');
  await service.change({...command('next','new'),principal_id:'other'});
  assert.equal(creates,1,'cancellation does not release a still-billable provider submission');
  const restarted=new AvatarProfileService({store,looks:[ready,fresh],assets});
  done=true;await restarted.reconcilePending();
  assert.equal((await restarted.readPreparation('owner','cancel-me'))?.status,'cancelled');
  assert.deepEqual(await restarted.read('owner'),before);
  assert.equal(store.commands.get('owner:cancel-me')?.state,'superseded');
  assert.equal(creates,2,'terminal reconciliation releases the original creation reservation');
});

test('cancelled unknown submission cannot be retried or lose its durable account reservation',async()=>{
  const store=new Store();let creates=0;
  const assets={create:async()=>{creates++;throw new Error('POST result lost');},get:async()=>{throw Error('no asset id');}};
  const service=new AvatarProfileService({store,looks:[fresh],assets});
  await service.change(command('unknown','new'));
  await service.cancel('owner','unknown');
  assert.equal((await service.change(command('unknown','new'))).status,'cancelled');
  assert.equal((await service.change(command('next','new'))).status,'pending');
  assert.equal(creates,1);assert.equal(store.commands.get('owner:unknown')?.state,'submission_uncertain');
  await service.cancel('owner','next');await service.reconcilePending();
  assert.equal(store.commands.get('owner:next')?.state,'superseded');
  assert.equal((await service.reconcile('owner','next')).status,'cancelled');assert.equal(creates,1);
});

test('ready history reuses the original asset and focus, restores the default, and keeps only the recent three versions',async()=>{
  const store=new Store();let creates=0;
  const assets={create:async()=>{creates++;return{id:'generated',state:'ready' as const};},get:async(id:string)=>({id,state:'ready' as const})};
  const service=new AvatarProfileService({store,looks:[ready,fresh],assets});
  await service.change({...command(),focus:{x:.2,y:.7}});
  await service.change(command('new-look','new',1));
  const reuse={principal_id:'owner',device_id:'mac',command_id:'reuse',expected_version:2,version:1,owner_request:'复用最近形象'};
  const reused=await service.reuse(reuse);
  assert.equal(reused.profile_version,3);assert.deepEqual(reused.profile?.focus,{x:.2,y:.7});
  assert.equal(await service.activeAvatarId('owner'),'approved-provider-id');assert.equal(creates,1);
  assert.deepEqual(await service.reuse(reuse),reused);
  const restored=await service.reuse({...reuse,command_id:'default',expected_version:3,version:0});
  assert.equal(restored.profile,null);assert.equal(restored.profile_version,4);assert.equal(await service.activeAvatarId('owner'),null);
  assert.deepEqual((await service.history('owner')).recent_versions.map(item=>item.version),[2,3,4]);
  await assert.rejects(service.reuse({...reuse,command_id:'stale',expected_version:4}),/AVATAR_VERSION_UNKNOWN/);
  await assert.rejects(service.change(command('wrong-base','approved',0)),/AVATAR_VERSION_CONFLICT/);
  assert.equal(store.commands.get('owner:first')?.avatar_id,'approved-provider-id','history pruning preserves command provenance and assets');
  const offline=new AvatarProfileService({store,looks:[ready,fresh]});
  await assert.rejects(offline.reuse({...reuse,command_id:'offline-reuse',expected_version:4,version:3}),/AVATAR_GENERATION_UNAVAILABLE/);
  assert.equal((await offline.snapshot('owner')).profile_version,4,'provider readiness is required before restoring a historical asset');
});

test('expired historical provider assets fail reuse without replacing the current appearance',async()=>{
  const store=new Store();
  const service=new AvatarProfileService({store,looks:[ready]});
  await service.change(command());await service.reuse({principal_id:'owner',device_id:'mac',command_id:'default',expected_version:1,version:0,owner_request:'恢复默认'});
  const restarted=new AvatarProfileService({store,looks:[ready],assets:{create:async()=>{throw Error('reuse must not POST');},get:async()=>{throw new ViduAvatarRequestRejected('AVATAR_VIDU_HTTP_404');}}});
  const result=await restarted.reuse({principal_id:'owner',device_id:'mac',command_id:'expired',expected_version:2,version:1,owner_request:'复用'});
  assert.equal(result.status,'failed');assert.equal(result.error,'provider_rejected');assert.equal(result.profile_version,2);assert.equal(result.profile,null);
});

test('device receipts keep the actual loaded version, isolate owners, reject future versions, and do not echo forever',async()=>{
  const store=new Store();const service=new AvatarProfileService({store,looks:[ready]});
  await service.change(command());let events=0;service.watch(()=>{events++;});
  await service.loaded('owner','mac','mac',1);await service.loaded('owner','mac','mac',1);
  assert.equal(events,1);
  await service.reuse({principal_id:'owner',device_id:'mac',command_id:'default',expected_version:1,version:0,owner_request:'恢复默认'});
  assert.equal((await service.snapshot('owner')).loaded_receipts[0]?.profile_version,1,'offline clients stay visibly behind');
  await service.loaded('owner','glasses','glasses',1);await service.loaded('owner','mac','mac',2);await service.loaded('owner','mac','mac',0);
  const state=await new AvatarProfileService({store,looks:[ready]}).snapshot('owner');
  assert.equal(state.profile,null);assert.equal(state.profile_version,2);
  assert.deepEqual(state.loaded_receipts.map(item=>[item.device_id,item.profile_version]),[['glasses',1],['mac',2]]);
  assert.deepEqual((await service.snapshot('other')).loaded_receipts,[]);
  await assert.rejects(service.loaded('other','forged','mac',2),/AVATAR_VERSION_CONFLICT/);
});
