import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNavigation} from '../src/navigation-progress.ts';
import type {NavPlan,NavStep} from '../src/movement.ts';

function step(index:number,start:number,end:number,duration_s=100):NavStep {
  return {index,maneuver:'straight',instruction:'Continue',distance_m:100,duration_s,
    polyline:[{lat:0,lng:start},{lat:0,lng:end}],maneuver_location:{lat:0,lng:end}};
}
function plan(steps=[step(0,0,0.001),step(1,0.001,0.002,300)]):NavPlan&{nav_id:string;revision:number} {
  return {nav_id:'route',revision:2,mode:'bicycling',destination:{name:'End',lat:0,lng:0.002},
    total_m:400,total_s:800,steps};
}
function near(actual:number,expected:number){assert.ok(Math.abs(actual-expected)<0.001,`${actual} != ${expected}`);}

test('advances steps and projects remaining distance and ETA with provider totals',()=>{
  const projected=projectNavigation(plan(),{lat:0,lng:0.0015});
  assert.equal(projected.progress.step_index,1);
  assert.equal(projected.progress.route_segment_index,2);
  near(projected.progress.segment_fraction,0.5);
  near(projected.progress.distance_to_maneuver_m,50);
  near(projected.progress.remaining_m,100);
  near(projected.progress.remaining_s,300);
  near(projected.distance_from_route_m,0);
  assert.equal(projected.arrived,false);
});
test('keeps the previous step when moving backwards or off route',()=>{
  assert.equal(projectNavigation(plan(),{lat:0,lng:0.0002},1).progress.step_index,1);
  const projected=projectNavigation(plan(),{lat:0.001,lng:0.0015});
  assert.equal(projected.progress.step_index,0);
  assert.ok(projected.distance_from_route_m>110);
  assert.equal(projected.arrived,false);
});
test('one-point steps preserve concatenated route segment bounds',()=>{
  const terminal={...step(1,0.002,0.002),polyline:[{lat:0,lng:0.002}]};
  const projected=projectNavigation(plan([step(0,0,0.001),terminal]),{lat:0,lng:0.002});
  assert.equal(projected.progress.step_index,1);
  assert.equal(projected.progress.route_segment_index,1);
  assert.equal(projected.progress.segment_fraction,1);
  assert.equal(projected.arrived,true);
  const single=projectNavigation(plan([{...terminal,index:0}]),{lat:0,lng:0.002});
  assert.equal(single.progress.route_segment_index,0);
  assert.ok(Number.isFinite(single.progress.remaining_s));
});
test('arrival uses destination distance with a 25 meter boundary',()=>{
  assert.equal(projectNavigation(plan(),{lat:0,lng:0.0022}).arrived,true);
  assert.equal(projectNavigation(plan(),{lat:0,lng:0.0023}).arrived,false);
});

test('background GPS skips a full intermediate step beyond the route proximity threshold',()=>{
  const route=plan([step(0,0,0.001),step(1,0.001,0.002),step(2,0.002,0.003)]);
  route.destination={name:'End',lat:0,lng:0.003};route.total_m=300;route.total_s=300;
  const initial=projectNavigation(route,{lat:0,lng:0.0001});
  assert.equal(initial.progress.step_index,0);
  const advanced=projectNavigation(route,{lat:0,lng:0.0025},initial.progress.step_index);
  assert.equal(advanced.progress.step_index,2);
  assert.equal(advanced.progress.route_segment_index,4);
  near(advanced.progress.segment_fraction,0.5);
  near(advanced.progress.remaining_m,50);
});
