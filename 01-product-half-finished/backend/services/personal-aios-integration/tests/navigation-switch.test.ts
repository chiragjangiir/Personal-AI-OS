import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import {Movement,type NavRoute,type NavPlan} from '../src/movement.ts';
import {ContractError} from '../src/contracts.ts';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
const at='2026-10-19T00:00:00.000Z';
function route(total_m:number,lat=0):NavRoute {
  return {total_m,total_s:total_m/2,steps:[{index:0,maneuver:'straight',instruction:'Continue',distance_m:total_m,duration_s:total_m/2,
    polyline:[{lat,lng:0},{lat,lng:0.01}],maneuver_location:{lat,lng:0.01}}]};
}
function fixture(alternative=true) {
  const sent:{terminal:string;body:any}[]=[];let calls=0,pause:Promise<void>|undefined,positionOffline=false;
  const movement=new Movement({now:()=>Date.parse(at),position:async()=>{if(positionOffline)throw new ContractError('PHONE_NOT_CONNECTED',409);return {lat:0,lng:0};},event:async()=>{},say:async()=>{},
    navigation:{search:async name=>[{name,lat:0,lng:0.01}],plan:async(_origin,destination,mode):Promise<NavPlan>=>{
      calls++;await pause;return {mode,destination,...route(1000),...(alternative?{alternative:route(1200,0.001)}:{})};}},
    send:async(_principal,terminal,body,current)=>{if(!current||current())sent.push({terminal,body});}});
  return {movement,sent,offline:(value:boolean)=>{positionOffline=value;},calls:()=>calls,pause:(value:Promise<void>)=>{pause=value;}};
}
test('switch uses authoritative alternative, advances revision and projects latest fix immediately',async()=>{
  const f=fixture(),initial=await f.movement.navigate('owner',{destination:'End',mode:'walking'}) as any;
  await f.movement.location('owner',{datum:'wgs84',latitude:0.001,longitude:0.005,accuracy_m:5,observed_at:at},true);
  const switched=await f.movement.controlNavigation('owner','switch') as any;
  assert.equal(f.calls(),1);assert.equal(switched.status,'switched');assert.equal(switched.nav_id,initial.nav_id);assert.equal(switched.revision,2);
  const routes=f.sent.filter(s=>s.body.operation==='nav_route');
  assert.deepEqual(routes.slice(-2).map(s=>s.terminal),['phone','glasses']);
  const active=routes.at(-1)!.body;
  assert.equal(active.total_m,1200);assert.equal(active.overview.selected,1);assert.equal(active.overview.show,true);
  assert.deepEqual(active.overview.alternatives,[{total_m:1000,total_s:500,polyline:route(1000).steps[0]!.polyline}]);
  assert.equal(f.sent.at(-1)!.body.nav.revision,2);assert.ok(Math.abs(f.sent.at(-1)!.body.nav.remaining_m-600)<0.1);
  await f.movement.frame('owner',{nav_id:initial.nav_id,seq:1,at,position:{lat:0,lng:0,accuracy_m:5,at},nav:{nav_id:initial.nav_id,revision:1,
    step_index:0,maneuver:'straight',distance_to_maneuver_m:1,remaining_m:1,remaining_s:1,route_segment_index:0,segment_fraction:1}});
  await f.movement.glassesConnected('owner');
  assert.equal(f.sent.at(-1)!.body.nav.revision,2);assert.ok(f.sent.at(-1)!.body.nav.remaining_m>500);
  assert.equal(f.sent.findLast(s=>s.body.operation==='nav_route')!.body.overview.show,false);
  const back=await f.movement.controlNavigation('owner','switch') as any;
  assert.equal(back.revision,3);assert.equal(back.distance_m,1000);assert.equal(f.calls(),1);
  assert.equal(f.sent.findLast(s=>s.body.operation==='nav_route')!.body.overview.selected,0);
});
test('missing alternate returns explicit status without provider or publication',async()=>{
  const f=fixture(false);
  assert.deepEqual(await f.movement.controlNavigation('owner','switch'),{status:'no_active_navigation'});
  await f.movement.navigate('owner',{destination:'End',mode:'walking'});const count=f.sent.length;
  assert.equal((await f.movement.controlNavigation('owner','switch') as any).status,'no_alternative');
  assert.equal(f.sent.length,count);assert.equal(f.calls(),1);
});
test('switch invalidates an in-flight replan and concurrent switches keep one revision sequence',async()=>{
  const f=fixture(),initial=await f.movement.navigate('owner',{destination:'End',mode:'walking'}) as any;
  const gate=Promise.withResolvers<void>();f.pause(gate.promise);
  const replan=f.movement.navState('owner',{operation:'nav_state',nav_id:initial.nav_id,state:'off_route',at,position:{lat:0,lng:0}});
  await Promise.resolve();
  const switches=await Promise.allSettled([f.movement.controlNavigation('owner','switch'),f.movement.controlNavigation('owner','switch')]);
  assert.equal(switches[1]!.status,'fulfilled');assert.equal(f.movement.status('owner').navigation!.revision,3);
  gate.resolve();await assert.rejects(replan,{code:'NAVIGATION_SESSION_CHANGED'});
  assert.equal(f.movement.status('owner').navigation!.revision,3);
});
test('switch supersedes a retained offline destination request before reconnect',async()=>{
  const f=fixture();await f.movement.navigate('owner',{destination:'End',mode:'walking'});f.offline(true);
  await assert.rejects(f.movement.navigate('owner',{destination:'Other',mode:'walking'},'glasses'),{code:'PHONE_NOT_CONNECTED'});
  await f.movement.controlNavigation('owner','switch');f.offline(false);await f.movement.phoneConnected('owner');
  assert.equal(f.calls(),1);assert.equal(f.movement.status('owner').navigation!.destination.name,'End');
  assert.equal(f.sent.at(-1)!.body.revision,2);assert.equal(f.sent.at(-1)!.body.overview.show,false);
});
test('public tool and formal route schema expose additive switch and overview contract',async()=>{
  const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:true,strictRequired:false});ajv.addFormat('uuid',/^[0-9a-f-]{36}$/);
  const tool=enabledToolSchemas({memory:false,movement:true}).find(s=>s.name==='paios_navigate')!;
  const validateTool=ajv.compile(tool.parameters);
  assert.equal(validateTool({action:'switch'}),true);assert.equal(validateTool({action:'switch',destination:'End'}),false);
  const input=ajv.compile(contract.inputs.nav_control.definition);
  assert.equal(input({operation:'nav_control',action:'switch'}),true);
  const f=fixture();await f.movement.navigate('owner',{destination:'End',mode:'walking'});
  const output=ajv.compile({...contract.outputs.nav_route,$defs:contract.$defs}),body={schema_version:contract.schema,session_id:'fixture',...f.sent[0]!.body};
  assert.equal(output(body),true,JSON.stringify(output.errors));
  assert.equal(output({...body,overview:{...body.overview,alternatives:[...body.overview.alternatives,...body.overview.alternatives]}}),false);
});
