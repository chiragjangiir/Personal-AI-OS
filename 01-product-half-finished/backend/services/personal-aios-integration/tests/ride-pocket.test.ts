import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {DeviceLocations} from '../src/location.ts';
import {EVENT_SCHEMA,sha256,type CaptureLocation,ContractError} from '../src/contracts.ts';
import {PHONE_CAPABILITIES,GLASSES_CAPABILITIES,MAC_CAPABILITIES,StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {policy} from './sealed-replay-check.ts';
import type {Navigation} from '../src/movement.ts';
import {createAmapNavigation} from '../../../phase0/gateway/src/amap-navigation.ts';
import amapRecorded from '../../../phase0/gateway/tests/fixtures/amap-recorded.json' with {type:'json'};

async function fixture(t:import('node:test').TestContext,options:{worn?:boolean;alternative?:boolean;navigation?:Navigation}={}) {
  const directory=await mkdtemp(join(tmpdir(),'ride-pocket-')),storage=new PosixStorage(directory);
  let now=Date.now();
  const run:NativeRun={run_id:'pocket-run',session_id:'mac-session',conversation_session_id:'mac-session',status:'running'};
  const native={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,policy),packets:Record<string,any>[]=[],cards:Record<string,any>[]=[],shown:string[]=[],captures:string[]=[];
  const devices=[['phone','phone',PHONE_CAPABILITIES],['glasses','glasses',GLASSES_CAPABILITIES],['mac','mac',MAC_CAPABILITIES]].map(([device_id,device_type,capabilities])=>({
    principal_id:'owner',device_id,device_type,capabilities,channel:'fixture',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256(String(device_id))}));
  const registry=new StaticFixtureDeviceAuthority(devices as never);let registryWait:Promise<void>|undefined;
  const registryEntered=Promise.withResolvers<void>();
  const sourceAuthority={authenticate:registry.authenticate.bind(registry),revalidate:async(source:Parameters<typeof registry.revalidate>[0])=>{
    if(registryWait){registryEntered.resolve();await registryWait;}return registry.revalidate(source);
  }};
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage),sourceAuthority,
    skill:'fixture',max_read_bytes:8192,locations:new DeviceLocations(()=>now),movement:{now:()=>now},navigation:options.navigation??{search:async name=>[{name,lat:30.252,lng:120.15}],
      plan:async(origin,destination,mode)=>{
        const route={total_m:222,total_s:80,steps:[{index:0,maneuver:'straight' as const,instruction:'沿路直行',
          distance_m:222,duration_s:80,polyline:[origin,{lat:30.252,lng:120.15}],maneuver_location:{lat:30.252,lng:120.15}}]};
        return {mode,destination,...route,...(options.alternative?{alternative:{...route,total_m:333,total_s:120}}:{})};}}});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const phone=await runtime.authenticate('phone'),glasses=await runtime.authenticate('glasses'),mac=await runtime.authenticate('mac');
  const attachGlasses=()=>runtime.watchCare(glasses,async(_id,text)=>{shown.push(text);return true;},undefined,undefined,undefined,undefined,undefined,
    {session:'glasses',deliver:async card=>{cards.push(card);},captureOnce:async frame=>{captures.push(frame);},
      move:async(body,current)=>{if(!current||current())packets.push(body);}});
  const detachGlasses=await attachGlasses();await runtime.wearState(glasses,options.worn??true);
  const fix=(age=0,lat=30.25):CaptureLocation=>({latitude:lat,longitude:120.15,accuracy_m:5,observed_at:new Date(now-age).toISOString(),datum:'wgs84'});
  const accepted=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'mac-ride-nav',device_id:'mac',device_type:'mac',captured_at:new Date(now).toISOString(),
    source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',
    payload:Buffer.from('测试：帮我在眼镜上打开骑行模式并导航到西湖，选择骑行路线去。')},mac,'mac-session',true);
  for(let n=0;n<200&&!admission.find(run.run_id,'mac-session');n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(admission.find(run.run_id,'mac-session'));
  const tool=(name:string,args:Record<string,unknown>)=>runtime.tool(name,{context:{run_id:run.run_id,session_id:'mac-session',tool_call_id:crypto.randomUUID()},args}) as Promise<any>;
  return {runtime,phone,glasses,mac,run,accepted,packets,cards,shown,captures,attachGlasses,detachGlasses,fix,tool,advance:(ms:number)=>{now+=ms;},blockRegistry:()=>{
    const gate=Promise.withResolvers<void>();registryWait=gate.promise;
    return {entered:registryEntered.promise,release:()=>{registryWait=undefined;gate.resolve();}};
  }};
}

async function amapFixture(t:import('node:test').TestContext,fetcher:typeof fetch) {
  const directory=await mkdtemp(join(tmpdir(),'navigation-provider-')),keyFile=join(directory,'amap.key');
  t.after(()=>rm(directory,{recursive:true,force:true}));await writeFile(keyFile,'synthetic-navigation-key');
  return createAmapNavigation({keyFile,fetch:fetcher});
}

for(const failed of ['search','plan'] as const)test(`AMap ${failed} cause reaches the navigation tool and log with no route publication`,async t=>{
  const logs:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>logs.push(args));
  let requests=0;
  const navigation=await amapFixture(t,(async()=>{
    requests++;
    // https://lbs.amap.com/api/webservice/guide/tools/info: Web Service platform mismatch.
    return Response.json(requests===1&&failed==='plan'?{status:'1',pois:[{name:'终点',location:'120.15,30.252'}]}:
      {status:'0',infocode:'10009',info:'USERKEY_PLAT_NOMATCH'});
  }) as typeof fetch);
  const f=await fixture(t,{navigation});await f.runtime.locate(f.phone,f.fix());
  const result=await f.tool('paios_navigate',{destination:'终点',mode:'bicycling'});
  assert.equal(result.error_code,'NAVIGATION_PROVIDER_FAILED');assert.equal(result.provider_code,'10009');
  assert.equal(result.provider_reason,'USERKEY_PLAT_NOMATCH');
  assert.equal(result.provider_path,failed==='search'?'/v5/place/text':'/v5/direction/bicycling');
  assert.equal(requests,failed==='search'?1:2);assert.equal(logs.length,1);
  assert.ok(JSON.stringify(logs).includes('USERKEY_PLAT_NOMATCH'));
  assert.equal(f.packets.some(body=>body.operation==='nav_route'),false);
});

test('synthetic v5 bicycling reaches the phone while glasses are unworn, advances and stops',async t=>{
  const requests:string[]=[],navigation=await amapFixture(t,(async(input:URL)=>{
    requests.push(input.pathname);
    return Response.json(input.pathname==='/v5/place/text'?
      {status:'1',pois:[{name:'虚构广场',location:'0.006000,0.003000'}]}:amapRecorded.bicycling);
  }) as typeof fetch);
  const f=await fixture(t,{worn:false,navigation}),phone:Record<string,any>[]=[];
  await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'phone',move:async(body,current)=>{if(!current||current())phone.push(body);}});
  await f.runtime.locate(f.phone,{...f.fix(),latitude:0,longitude:0});
  const started=await f.tool('paios_navigate',{destination:'虚构广场',mode:'bicycling'});
  assert.deepEqual(requests,['/v5/place/text','/v5/direction/bicycling']);
  assert.equal(started.mode,'bicycling');assert.equal(started.phone_status,'requested');assert.equal(started.distance_m,2666);
  const route=phone.find(body=>body.operation==='nav_route')!;assert.equal(route.mode,'bicycling');assert.equal(route.nav_id,started.nav_id);
  f.advance(1000);const end=route.steps[0].polyline.at(-1);
  await f.runtime.locate(f.phone,{...f.fix(),latitude:end.lat,longitude:end.lng},true);
  assert.ok(f.packets.findLast(body=>body.operation==='move_hud')!.nav.remaining_m<route.total_m);
  await f.tool('paios_navigate',{action:'stop'});
  assert.deepEqual(phone.findLast(body=>body.operation==='nav_control'),{operation:'nav_control',nav_id:started.nav_id,action:'stop'});
});

test('Mac ride/nav turn completes with absent phone and one-minute background fix; glasses advance and phone joins once',{timeout:5000},async t=>{
  const f=await fixture(t);await f.runtime.locate(f.phone,f.fix(60000));
  const started=performance.now(),nav=await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});
  const sensed=await f.tool('paios_senses',{sense:'phone_location'}),ride=await f.tool('paios_ride',{action:'start'});
  assert.ok(performance.now()-started<1500);
  assert.equal(nav.destination,'西湖');assert.equal(nav.mode,'bicycling');assert.equal(nav.phone_status,'PHONE_NOT_CONNECTED');
  assert.equal(nav.origin.age_ms,60000);assert.equal(nav.origin.freshness_bound_ms,120000);
  assert.equal(sensed.status,'last_known');assert.equal(sensed.error_code,'PHONE_NOT_CONNECTED');assert.equal(sensed.last_fix_age_ms,60000);
  assert.equal(ride.status,'glasses_started');assert.equal(ride.phone_recording,'unconfirmed');assert.equal(ride.last_fix_age_ms,60000);
  assert.equal(f.packets.find(body=>body.operation==='nav_route')!.mode,'bicycling');
  const hud=f.packets.at(-1)!;assert.equal(hud.kind,'ride_nav');assert.equal(hud.ride,undefined);assert.equal(hud.position.at,f.fix(60000).observed_at);
  const initialRemaining=hud.nav.remaining_m;
  f.advance(1000);await f.runtime.locate(f.phone,f.fix(0,30.251),true);
  assert.equal(f.packets.at(-1)!.kind,'ride_nav');assert.ok(f.packets.at(-1)!.nav.remaining_m<initialRemaining);
  const count=f.packets.length;await f.runtime.locate(f.phone,f.fix(60000,30.25),true);assert.equal(f.packets.length,count);
  await f.tool('paios_open_reply',{reply_mode:'text'});f.run.status='completed';f.run.output='眼镜骑行导航已打开，起点采用一分钟前手机定位；手机记录尚未确认。';
  const result=await f.runtime.result(f.mac,'mac-session',f.accepted.processed_event.processed_event_id);
  assert.equal(result.result.result_status,'completed');assert.match(result.chunks.map(chunk=>chunk.text).join(''),/手机记录尚未确认/);
  const delivered:Record<string,unknown>[]=[];
  const attach=()=>f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,{session:'phone',move:async(body,current)=>{if(!current||current())delivered.push(body);}});
  let detach=await attach();await f.runtime.movementReady(f.phone);assert.deepEqual(delivered.map(body=>body.operation),['ride_control','nav_route']);detach();
  detach=await attach();await f.runtime.movementReady(f.phone);assert.equal(delivered.filter(body=>body.operation==='ride_control').length,1);detach();
});

test('glasses navigation switch keeps the active route when no alternative exists',async t=>{
  const f=await fixture(t);await f.runtime.locate(f.phone,f.fix());
  const initial=await f.tool('paios_navigate',{destination:'西湖',mode:'walking'}),sent=f.packets.length;
  const result=await f.runtime.move(f.glasses,{operation:'nav_control',action:'switch'});
  assert.deepEqual(result,{status:'no_alternative',nav_id:initial.nav_id,revision:1});
  assert.equal(f.packets.length,sent);
  assert.deepEqual(await f.tool('paios_navigate',{action:'switch'}),result);
});

test('expired/lost phone fix reports age and cannot start navigation; stop replaces pending start',{timeout:5000},async t=>{
  const f=await fixture(t);await f.runtime.locate(f.phone,f.fix(120001));
  const sensed=await f.tool('paios_senses',{sense:'phone_location'});
  assert.equal(sensed.status,'unavailable');assert.equal(sensed.last_fix_age_ms,120001);assert.equal(sensed.location,undefined);
  const nav=await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});
  assert.equal(nav.status,'failed');assert.equal(nav.error_code,'PHONE_NOT_CONNECTED');assert.equal(nav.last_fix_age_ms,120001);
  assert.equal(f.packets.some(body=>body.operation==='nav_route'),false);
  await f.runtime.locate(f.phone,f.fix());await f.runtime.locate(f.phone,null);
  const silent=await f.tool('paios_senses',{sense:'phone_location'});assert.equal(silent.status,'unavailable');assert.equal(silent.phone_reason,undefined);
  await f.runtime.locate(f.phone,null,false,'permission_denied');
  const why=await f.tool('paios_senses',{sense:'phone_location'});assert.equal(why.status,'unavailable');assert.equal(why.phone_reason,'permission_denied');
  const refused=await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});assert.equal(refused.status,'failed');assert.equal(refused.phone_reason,'permission_denied');
  assert.equal((await f.tool('paios_ride',{action:'start'})).phone_reason,'permission_denied');
  f.advance(1000);await f.runtime.locate(f.phone,f.fix(),false);
  assert.equal((await f.tool('paios_senses',{sense:'phone_location'})).phone_reason,undefined);
  await f.runtime.locate(f.phone,null);
  await f.tool('paios_ride',{action:'start'});await f.tool('paios_ride',{action:'stop'});
  const commands:Record<string,unknown>[]=[];
  await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,{session:'phone',move:async(body,current)=>{if(!current||current())commands.push(body);}});
  await f.runtime.movementReady(f.phone);assert.deepEqual(commands.map(body=>[body.operation,body.action]),[['ride_control','stop']]);
});

test('glasses route preserves pending ride start for phone join',{timeout:5000},async()=>{
  const {Movement}=await import('../src/movement.ts');let connected=false;const sent:Record<string,unknown>[]=[];
  const movement=new Movement({position:async()=>({lat:30.25,lng:120.15}),navigation:{search:async name=>[{name,lat:30.252,lng:120.15}],
    plan:async(origin,destination,mode)=>({mode,destination,total_m:200,total_s:60,steps:[{index:0,maneuver:'straight',instruction:'直行',distance_m:200,duration_s:60,polyline:[origin,destination],maneuver_location:destination}]})},
    event:async()=>{},say:async()=>{},send:async(_principal,terminal,body,current)=>{if(terminal==='phone'&&!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);if(!current||current())sent.push({terminal,...body});}});
  await movement.controlRide('owner','start','glasses');await movement.navigate('owner',{destination:'西湖',mode:'bicycling'},'glasses');
  connected=true;await movement.phoneConnected('owner');
  assert.equal(sent.filter(body=>body.terminal==='phone'&&body.operation==='ride_control').length,1);
  assert.equal(sent.filter(body=>body.terminal==='phone'&&body.operation==='nav_route').length,1);
});

test('phone failure age reaches senses and navigation even before the first standby upload',async t=>{
  const f=await fixture(t);
  await f.runtime.locate(f.phone,null,false,'timeout',240000);
  const sensed=await f.tool('paios_senses',{sense:'phone_location'});
  assert.equal(sensed.status,'unavailable');assert.equal(sensed.phone_reason,'timeout');assert.equal(sensed.last_fix_age_ms,240000);
  f.advance(1000);
  const nav=await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});
  assert.equal(nav.status,'failed');assert.equal(nav.phone_reason,'timeout');assert.equal(nav.last_fix_age_ms,241000);
  assert.equal(f.packets.some(body=>body.operation==='nav_route'),false);
  await f.runtime.locate(f.phone,null,false,'reduced_accuracy',242000);
  assert.equal((await f.tool('paios_senses',{sense:'phone_location'})).phone_reason,'reduced_accuracy');
  f.advance(1000);await f.runtime.locate(f.phone,f.fix());
  const recovered=await f.tool('paios_senses',{sense:'phone_location'});
  assert.equal(recovered.last_fix_age_ms,0);assert.equal(recovered.phone_reason,undefined);
});

test('navigation completion cannot rewind a newer background fix while glasses route delivery waits',{timeout:5000},async()=>{
  const {Movement}=await import('../src/movement.ts'),now=Date.now();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),packets:Record<string,any>[]=[];
  const fix=(latitude:number,age:number):CaptureLocation=>({latitude,longitude:120.15,accuracy_m:5,observed_at:new Date(now-age).toISOString(),datum:'wgs84'});
  const initial=fix(30.25,1000),newer=fix(30.251,0);
  const movement=new Movement({now:()=>now,position:async()=>({lat:initial.latitude,lng:initial.longitude,location:initial}),
    navigation:{search:async name=>[{name,lat:30.252,lng:120.15}],
      plan:async(origin,destination,mode)=>({mode,destination,total_m:222,total_s:80,steps:[{index:0,maneuver:'straight',instruction:'直行',
        distance_m:222,duration_s:80,polyline:[origin,destination],maneuver_location:destination}]})},event:async()=>{},say:async()=>{},
    send:async(_principal,terminal,body,current)=>{
      if(terminal==='phone')throw new ContractError('PHONE_NOT_CONNECTED',409);
      if(current?.()===false)return false;
      if(body.operation==='nav_route'){entered.resolve();await release.promise;}
      packets.push(body);return true;
    }});
  const navigation=movement.navigate('owner',{destination:'西湖',mode:'bicycling'});
  await entered.promise;await movement.location('owner',newer);
  const midpoint=packets.find(body=>body.operation==='move_hud');
  assert.ok(midpoint);assert.equal(midpoint.position.at,newer.observed_at);
  assert.ok(midpoint.nav.remaining_m>100&&midpoint.nav.remaining_m<120);
  release.resolve();await navigation;
  const hud=packets.filter(body=>body.operation==='move_hud');
  assert.equal(hud.length,1);
  for(const body of hud){
    assert.ok(Date.parse(body.position.at)>=Date.parse(newer.observed_at));
    assert.ok(body.nav.remaining_m<=midpoint.nav.remaining_m);
  }
});

for(const [name,args,budget] of [['paios_senses',{sense:'phone_location'},12000],['paios_ride',{action:'start'},16000],['paios_navigate',{destination:'西湖',mode:'bicycling'},40000]] as const)
test(`${name} total deadline includes held registry and fences late device publication`,{timeout:5000},async t=>{
  const f=await fixture(t);await f.runtime.locate(f.phone,f.fix(60000));
  const held=f.blockRegistry(),before=f.packets.length;t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.tool(name,args);await held.entered;t.mock.timers.tick(budget);
  const result=await pending;assert.equal(result.error_code,'TERMINAL_TOOL_TIMEOUT');assert.equal(result.deadline_ms,budget);assert.equal(result.last_fix_age_ms,60000);
  t.mock.timers.reset();held.release();await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(f.packets.length,before,'expired registry work cannot publish a later action');
});

test('a retained ride from an expired tool cannot start when the phone later reconnects',async()=>{
  const {Movement}=await import('../src/movement.ts');let active=true,connected=false;
  const commands:Record<string,unknown>[]=[];
  const movement=new Movement({position:async()=>({lat:0,lng:0}),event:async()=>{},say:async()=>{},send:async(_principal,terminal,body,current)=>{
    if(terminal==='phone'&&!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);
    if(!current||current())commands.push({terminal,...body});
  }});
  await movement.controlRide('owner','start','voice',()=>active);active=false;connected=true;
  await movement.phoneConnected('owner');
  assert.equal(commands.some(body=>body.terminal==='phone'&&body.operation==='ride_control'),false);
  assert.equal(commands.at(-1)!.error_code,'TERMINAL_TOOL_TIMEOUT');
});

test('a backgrounded phone with a stale binding still pushes ride and navigation to connected unworn glasses',{timeout:5000},async t=>{
  const f=await fixture(t);await f.runtime.locate(f.phone,f.fix(30000));
  await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,{session:'phone',deliver:async()=>{},move:async()=>{throw new ContractError('SOURCE_BINDING_INACTIVE',403);}});
  await f.runtime.wearState(f.glasses,false);f.packets.length=0;
  const ride=await f.tool('paios_ride',{action:'start'}),nav=await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});
  assert.equal(ride.phone_status,'PHONE_NOT_CONNECTED');assert.equal(ride.glasses_status,'shown');assert.equal(ride.status,'glasses_started');
  assert.equal(nav.phone_status,'PHONE_NOT_CONNECTED');assert.equal(nav.glasses_status,'route_sent');assert.equal(nav.mode,'bicycling');
  assert.equal(f.packets.find(body=>body.operation==='nav_route')!.mode,'bicycling');assert.equal(f.packets.at(-1)!.kind,'ride_nav');
  const count=f.packets.length;
  await f.runtime.wearState(f.glasses,true);
  assert.deepEqual(f.packets.slice(count).map(body=>body.operation),['nav_route','move_hud']);
});

test('connected unworn glasses receive ride metrics, route overview, switch, turn updates and stop',{timeout:5000},async t=>{
  const f=await fixture(t,{worn:false,alternative:true}),phone:Record<string,any>[]=[];
  await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'phone',move:async(body,current)=>{if(!current||current())phone.push(body);}});
  await f.runtime.locate(f.phone,f.fix());await f.tool('paios_ride',{action:'start'});
  assert.equal(f.packets.at(-1)!.kind,'ride');
  const navigation=await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});
  const route=f.packets.find(body=>body.operation==='nav_route')!;
  assert.equal(route.overview.show,true);assert.equal(route.overview.alternatives.length,1);
  const ride_id=crypto.randomUUID(),at=f.fix().observed_at,metrics={speed_kmh:24,hr_bpm:130,avg_kmh:22,max_kmh:30,distance_m:500,moving_s:80,elapsed_s:90};
  await f.runtime.move(f.phone,{operation:'ride_state',ride_id,state:'started',started_by:'phone',at});
  f.advance(1000);const fix=f.fix();
  await f.runtime.move(f.phone,{operation:'move_frame',ride_id,nav_id:navigation.nav_id,seq:1,at:fix.observed_at,ride:metrics,
    position:{lat:fix.latitude,lng:fix.longitude,accuracy_m:5,at:fix.observed_at},
    nav:{nav_id:navigation.nav_id,revision:1,step_index:0,maneuver:'straight',distance_to_maneuver_m:100,remaining_m:100,remaining_s:40,route_segment_index:0,segment_fraction:0.5}});
  const hud=f.packets.findLast(body=>body.operation==='move_hud')!;
  assert.equal(hud.kind,'ride_nav');assert.equal(hud.ride.speed_kmh,24);assert.equal(hud.ride.hr_bpm,130);assert.equal(hud.nav.maneuver,'straight');
  assert.ok(f.packets.some(body=>body.operation==='move_say'));
  const switched=await f.runtime.move(f.glasses,{operation:'nav_control',action:'switch'}) as any;
  assert.equal(switched.revision,2);assert.equal(f.packets.findLast(body=>body.operation==='nav_route')!.overview.selected,1);
  assert.equal(f.packets.findLast(body=>body.operation==='move_hud')!.nav.revision,2);
  await f.tool('paios_navigate',{action:'stop'});assert.equal(f.packets.at(-1)!.nav,undefined);assert.equal(f.packets.at(-1)!.kind,'ride');
  await f.tool('paios_ride',{action:'stop'});assert.equal(f.packets.at(-1)!.kind,'walk_nav');assert.equal(f.packets.at(-1)!.ride,undefined);
  await f.runtime.move(f.phone,{operation:'ride_state',ride_id,state:'ended',started_by:'phone',at:fix.observed_at,
    summary:{started_at:at,ended_at:fix.observed_at,distance_m:500,moving_s:80,elapsed_s:90,avg_kmh:22,max_kmh:30}});
  assert.equal(f.packets.at(-1)!.operation,'ride_summary');assert.equal(f.packets.at(-1)!.distance_m,500);
  assert.equal((await f.tool('paios_ride',{action:'status'})).ride_mode,false);
  assert.ok(phone.some(body=>body.operation==='nav_control'&&body.action==='stop'));
});

test('take-off clears wear-scoped cards while both wear changes and reconnect replay current movement',{timeout:5000},async t=>{
  const f=await fixture(t);await f.runtime.locate(f.phone,f.fix());
  await f.tool('paios_ride',{action:'start'});await f.tool('paios_navigate',{destination:'西湖',mode:'bicycling'});
  await f.runtime.ownerInput(f.glasses);
  const card=await f.tool('paios_terminal_question',{question:'继续吗',options:[{id:'yes',label:'继续',lines:[]},{id:'no',label:'取消',lines:[]}]});
  assert.equal(f.cards.at(-1)!.card_id,card.card_id);
  const before=await f.tool('paios_ride',{action:'status'});f.packets.length=0;
  assert.deepEqual(await f.runtime.wearState(f.glasses,false),{worn:false,owner_verified:false});
  assert.deepEqual(f.packets.map(body=>body.operation),['nav_route','move_hud']);assert.equal(f.packets.at(-1)!.kind,'ride_nav');
  assert.equal(f.packets.at(-1)!.position.at,f.fix().observed_at);
  assert.deepEqual(await f.tool('paios_ride',{action:'status'}),before);
  await assert.rejects(f.runtime.submitGlassesGesture({event_id:'stale-card',captured_at:f.fix().observed_at},f.glasses,{card_id:card.card_id,kind:'nod'}),/CARD_REQUIRED/);
  f.packets.length=0;await f.runtime.wearState(f.glasses,true);
  assert.deepEqual(f.packets.map(body=>body.operation),['nav_route','move_hud']);
  f.detachGlasses();const detach=await f.attachGlasses();f.packets.length=0;await f.runtime.movementReady(f.glasses);
  assert.deepEqual(f.packets.map(body=>body.operation),['nav_route','move_hud']);assert.equal(f.packets.at(-1)!.kind,'ride_nav');
  assert.equal(f.packets.at(-1)!.position.at,f.fix().observed_at);
  detach();f.packets.length=0;await f.tool('paios_ride',{action:'stop'});assert.equal(f.packets.length,0);
});

test('movement delivery does not open payment, camera or private notifications on unworn glasses',{timeout:5000},async t=>{
  const f=await fixture(t,{worn:false});await f.runtime.locate(f.phone,f.fix());
  assert.equal((await f.tool('paios_ride',{action:'start'})).glasses_status,'shown');
  assert.deepEqual(await f.tool('paios_glasses_pay',{}),{status:'failed',error_code:'GLASSES_NOT_CONNECTED'});
  assert.deepEqual(await f.tool('paios_senses',{sense:'glasses_photo'}),{status:'unavailable',error_code:'CAMERA_NOT_WORN'});
  await assert.rejects(f.runtime.scheduledDelivery({principal_id:'owner',device_id:'glasses',id:'private-message',text:'私信内容',captured_at:f.fix().observed_at}),/CARE_OUTREACH_UNAVAILABLE/);
  assert.deepEqual(f.captures,[]);assert.deepEqual(f.shown,[]);assert.deepEqual(f.cards,[]);
  assert.equal(f.packets.some(body=>body.operation==='pay_open'),false);
  await assert.rejects(f.runtime.voiceEnrollmentControl(f.glasses,'status'),/VOICEPRINT_DEVICE_REQUIRED/);
});
