import test from 'node:test';
import assert from 'node:assert/strict';
import {Movement,type MoveFrame,type NavPlan} from '../src/movement.ts';
import {ContractError} from '../src/contracts.ts';

function fixture() {
  let now=Date.parse('2026-10-20T00:00:00.000Z'),calls=0,connected=true;
  let planner=async(route:NavPlan)=>route,position=async()=>({lat:0,lng:0});
  const sent:{terminal:string;body:any}[]=[],spoken:{text:string;kind:string}[]=[];
  const movement=new Movement({now:()=>now,position:()=>position(),event:async()=>{},
    say:async(_principal,text,kind)=>{spoken.push({text,kind});},
    send:async(_principal,terminal,body,current)=>{
      if(terminal==='phone'&&!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);
      if(current?.()!==false)sent.push({terminal,body});
    },
    navigation:{search:async name=>[{name,lat:0,lng:0.01}],plan:async(_origin,destination,mode)=>{
      calls++;
      const step={index:0,maneuver:'straight' as const,instruction:'继续前行',distance_m:1000,duration_s:500,
        polyline:[{lat:0,lng:0},{lat:0,lng:0.01}],maneuver_location:{lat:0,lng:0.01}};
      return planner({mode,destination,total_m:1000,total_s:500,steps:[step],alternative:{total_m:1200,total_s:600,steps:[step]}});
    }}});
  const at=()=>new Date(now).toISOString();
  const frame=(nav_id:string,revision:number,seq:number,distance=40):MoveFrame=>({nav_id,seq,at:at(),position:{lat:0,lng:0.005,accuracy_m:5,at:at()},
    nav:{nav_id,revision,step_index:0,maneuver:'straight',distance_to_maneuver_m:distance,remaining_m:distance,remaining_s:20,route_segment_index:0,segment_fraction:0.5}});
  const offRoute=(nav_id:string)=>({operation:'nav_state' as const,nav_id,state:'off_route' as const,at:at(),position:{lat:0,lng:0}});
  const start=()=>movement.navigate('owner',{destination:'End',mode:'walking'}) as Promise<{nav_id:string;revision:number}>;
  const hud=()=>sent.filter(s=>s.body.operation==='move_hud');
  return {movement,sent,spoken,start,frame,offRoute,hud,at,calls:()=>calls,advance:()=>{now+=1000;},
    planner:(run:typeof planner)=>{planner=run;},position:(run:typeof position)=>{position=run;},connected:(value:boolean)=>{connected=value;}};
}

test('replan accepts revision 2 progress, HUD and 200/50m prompts while rejecting revision 1 and late frames',async()=>{
  const f=fixture(),nav=await f.start(),off=f.offRoute(nav.nav_id);
  await f.movement.navState('owner',off);
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,2,1,190));
  assert.equal(f.movement.status('owner').progress?.revision,2);
  assert.equal(f.hud().at(-1)!.body.nav.distance_to_maneuver_m,190);
  assert.deepEqual(f.spoken.map(s=>s.text),['走过了，正在重新规划','继续前行']);
  const late=f.frame(nav.nav_id,2,100,1),count=f.hud().length;
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,1,2,1));
  assert.equal(f.hud().length,count);assert.equal(f.spoken.length,2);
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,2,3));
  assert.equal(f.movement.status('owner').progress?.distance_to_maneuver_m,40);
  assert.equal(f.hud().at(-1)!.body.nav.revision,2);assert.equal(f.spoken.length,3);
  await f.movement.frame('owner',late);assert.equal(f.movement.status('owner').progress?.distance_to_maneuver_m,40);
  await f.movement.navState('owner',off);assert.equal(f.calls(),2);assert.equal(f.spoken.length,3);
  await f.movement.phoneConnected('owner');await f.movement.glassesConnected('owner');
  assert.equal(f.sent.findLast(s=>s.terminal==='phone')!.body.revision,2);
  assert.equal(f.hud().at(-1)!.body.nav.distance_to_maneuver_m,40);
});

test('failed replan surfaces the error and releases the old revision for progress and a later replan',async()=>{
  const f=fixture(),nav=await f.start(),off=f.offRoute(nav.nav_id);
  f.planner(async()=>{throw new Error('provider unavailable');});
  await assert.rejects(f.movement.navState('owner',off),{code:'NAVIGATION_PROVIDER_FAILED'});
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,1,1));
  assert.equal(f.movement.status('owner').progress?.revision,1);assert.equal(f.hud().at(-1)!.body.nav.revision,1);
  await f.movement.navState('owner',off);assert.equal(f.calls(),2);
  f.planner(async route=>route);await f.movement.navState('owner',f.offRoute(nav.nav_id));
  assert.equal(f.movement.status('owner').navigation?.revision,2);
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,2,2));
  assert.equal(f.movement.status('owner').progress?.revision,2);
});

test('Stop and a replacement navigation invalidate an in-flight replan without publishing its late route',async()=>{
  for(const action of ['stop','replace']){
    const f=fixture(),nav=await f.start(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<NavPlan>();
    f.planner(async()=>{entered.resolve();return gate.promise;});
    const pending=f.movement.navState('owner',f.offRoute(nav.nav_id)),settled=Promise.allSettled([pending]);await entered.promise;
    await f.movement.frame('owner',f.frame(nav.nav_id,1,1));assert.equal(f.hud().length,0);
    f.planner(async route=>route);
    if(action==='stop')await f.movement.stopNavigation('owner');else await f.start();
    const count=f.sent.length;
    gate.resolve({mode:'walking',destination:{name:'Late',lat:0,lng:1},total_m:1,total_s:1,steps:[{
      index:0,maneuver:'arrive',instruction:'Late',distance_m:1,duration_s:1,polyline:[{lat:0,lng:0},{lat:0,lng:1}],maneuver_location:{lat:0,lng:1}}]});
    const result=(await settled)[0]!;assert.equal(result.status,'rejected');
    assert.equal((result as PromiseRejectedResult).reason.code,'NAVIGATION_SESSION_CHANGED');assert.equal(f.sent.length,count);
    assert.equal(f.movement.status('owner').navigation?.nav_id===nav.nav_id,false);
  }
});

test('the latest off-route request wins and repeated or older events cannot replan it again',async()=>{
  const f=fixture(),nav=await f.start(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<NavPlan>();
  let route!:NavPlan;f.planner(async value=>{route=value;entered.resolve();return gate.promise;});
  const old=f.offRoute(nav.nav_id),pending=f.movement.navState('owner',old),settled=Promise.allSettled([pending]);await entered.promise;
  f.advance();f.planner(async value=>value);const latest=f.offRoute(nav.nav_id);await f.movement.navState('owner',latest);
  gate.resolve(route);assert.equal((await settled)[0]!.status,'rejected');
  assert.equal(f.movement.status('owner').navigation?.revision,2);assert.equal(f.calls(),3);
  await f.movement.navState('owner',old);await f.movement.navState('owner',latest);assert.equal(f.calls(),3);
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,2,1));assert.equal(f.hud().at(-1)!.body.nav.revision,2);
});

test('switch releases an in-flight replan barrier, preserves event dedup and accepts only the new revision',async()=>{
  const f=fixture(),nav=await f.start(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<NavPlan>();
  let route!:NavPlan;f.planner(async value=>{route=value;entered.resolve();return gate.promise;});
  const off=f.offRoute(nav.nav_id),pending=f.movement.navState('owner',off),settled=Promise.allSettled([pending]);await entered.promise;
  await f.movement.controlNavigation('owner','switch');
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,2,1,190));
  assert.equal(f.movement.status('owner').progress?.revision,2);assert.equal(f.hud().at(-1)!.body.nav.distance_to_maneuver_m,190);
  f.advance();const count=f.hud().length;await f.movement.frame('owner',f.frame(nav.nav_id,1,2));assert.equal(f.hud().length,count);
  await f.movement.navState('owner',off);assert.equal(f.calls(),2);
  gate.resolve(route);assert.equal((await settled)[0]!.status,'rejected');
  f.advance();await f.movement.frame('owner',f.frame(nav.nav_id,2,3));assert.equal(f.spoken.filter(s=>s.text==='继续前行').length,2);
});

test('a position resolving after Stop cannot resurrect navigation and offline replans reconnect at revision 2',async()=>{
  const f=fixture(),nav=await f.start(),position=Promise.withResolvers<{lat:number;lng:number}>();f.position(()=>position.promise);
  const {position:_position,...off}=f.offRoute(nav.nav_id),pending=f.movement.navState('owner',off),settled=Promise.allSettled([pending]);
  await f.movement.stopNavigation('owner');position.resolve({lat:0,lng:0});
  assert.equal((await settled)[0]!.status,'rejected');assert.equal(f.calls(),1);assert.equal(f.movement.status('owner').navigation,undefined);
  f.position(async()=>({lat:0,lng:0}));const next=await f.start();f.connected(false);
  await f.movement.navState('owner',f.offRoute(next.nav_id));f.connected(true);await f.movement.phoneConnected('owner');
  assert.equal(f.sent.at(-1)!.body.revision,2);
  f.advance();await f.movement.frame('owner',f.frame(next.nav_id,2,1));assert.equal(f.hud().at(-1)!.body.nav.revision,2);
});
