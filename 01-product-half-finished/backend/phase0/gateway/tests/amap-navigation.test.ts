import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {createAmapNavigation} from '../src/amap-navigation.ts';
import recorded from './fixtures/amap-recorded.json' with {type: 'json'};

const KEY = 'synthetic-amap-secret-never-a-real-key';
const origin = {lat: 0, lng: 0}, destination = {name: '虚构广场', lat: 0.003, lng: 0.006};
async function keyFile(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'amap-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'amap.key'); await writeFile(file, KEY + '\n', {mode: 0o600}); return file;
}
const response = (body: unknown) => new Response(JSON.stringify(body));
const metres = (a: {lat: number; lng: number}, b: {lat: number; lng: number}) =>
  111_320*Math.hypot(a.lat-b.lat, (a.lng-b.lng)*Math.cos(a.lat*Math.PI/180));

test('documented v5 bicycling cost response plans without the legacy path duration field', async t => {
  // https://lbs.amap.com/api/webservice/guide/api/newroute: bicycling, show_fields=cost,polyline.
  const body = {...recorded.bicycling, route: {paths: recorded.bicycling.route.paths.map(({duration, ...path}) =>
    ({...path, cost: {duration}}))}};
  const navigation = createAmapNavigation({keyFile: await keyFile(t), fetch: (async () => response(body)) as typeof fetch});
  const plan = await navigation.plan(origin, destination, 'bicycling');
  assert.equal(plan.total_s, 934); assert.equal(plan.total_m, 2666);
  assert.equal(plan.steps[0]!.duration_s, 190); assert.equal(plan.steps[0]!.distance_m, 541);
});

test('provider, HTTP, transport and JSON failures log and retain a short cause without credentials', async t => {
  const logs: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  const file = await keyFile(t);
  const cases = [
    {fetcher: async () => response({status: '0', infocode: '10009', info: 'USERKEY_PLAT_NOMATCH'}), code: '10009', reason: 'USERKEY_PLAT_NOMATCH'},
    {fetcher: async () => new Response(KEY, {status: 403, statusText: 'Forbidden'}), code: 'HTTP_403', reason: 'Forbidden'},
    {fetcher: async () => {throw new TypeError('fetch failed', {cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), {code: 'ENOTFOUND'})});}, code: 'ENOTFOUND', reason: 'getaddrinfo ENOTFOUND'},
    {fetcher: async () => new Response(KEY), code: 'INVALID_JSON', reason: 'JSON'},
    {fetcher: async () => response({status: '0', infocode: '10001', info: 'Invalid key ' + KEY + ' https://restapi.amap.com?key=' + KEY}), code: '10001', reason: 'Invalid key'},
  ];
  for (const {fetcher, code, reason} of cases) {
    const navigation = createAmapNavigation({keyFile: file, fetch: fetcher as typeof fetch});
    await assert.rejects(navigation.plan(origin, destination, 'bicycling'), (e: any) => {
      assert.equal(e.code, 'NAVIGATION_PROVIDER_FAILED'); assert.equal(e.provider_code, code);
      assert.ok(e.provider_reason.includes(reason), e.provider_reason); assert.equal(e.provider_path, '/v5/direction/bicycling');
      assert.ok(!inspect(e).includes(KEY.slice(0, 12))); assert.ok(!inspect(e).includes('https://'));
      assert.ok(e.provider_reason.length <= 160); return true;
    });
  }
  assert.equal(logs.length, cases.length);
  for (const [i, log] of logs.entries()) {
    assert.ok(inspect(log).includes(cases[i]!.code)); assert.ok(inspect(log).includes(cases[i]!.reason));
    assert.ok(!inspect(log).includes(KEY.slice(0, 12))); assert.ok(!inspect(log).includes('https://'));
  }
});

test('a v4 fixture or a malformed v5 segment is diagnosed instead of silently changing API versions', async t => {
  t.mock.method(console, 'error', () => {});
  const malformed = structuredClone(recorded.bicycling); delete (malformed.route.paths[0]!.steps[0] as any).cost;
  for (const [body, reason] of [[{errcode: 0, errmsg: 'OK', data: {paths: []}}, 'status'], [malformed, 'cost.duration']] as const) {
    const navigation = createAmapNavigation({keyFile: await keyFile(t), fetch: (async () => response(body)) as typeof fetch});
    await assert.rejects(navigation.plan(origin, destination, 'bicycling'), (e: any) => {
      assert.equal(e.provider_code, 'INVALID_RESPONSE'); assert.ok(e.provider_reason.includes(reason), e.provider_reason); return true;
    });
  }
});

for (const mode of ['bicycling', 'walking'] as const) test(`synthetic v5 ${mode} preserves totals, geometry and arrival, and names the road entered`, async t => {
  const file = await keyFile(t);
  const body = recorded[mode], path = body.route.paths[0]!;
  let sent: URL;
  const navigation = createAmapNavigation({keyFile: file, fetch: (async (input: URL) => {sent = input; return response(body);}) as typeof fetch});
  const plan = await navigation.plan(origin, destination, mode);
  assert.equal(sent!.pathname, `/v5/direction/${mode}`);
  assert.equal(sent!.searchParams.get('show_fields'), 'polyline,cost');
  assert.equal(sent!.searchParams.get('alternative_route'), '2');
  assert.equal(plan.alternative, undefined);
  assert.equal(sent!.searchParams.get('origin'), '0.000000,0.000000');
  assert.equal(plan.mode, mode); assert.deepEqual(plan.destination, destination);
  assert.equal(plan.total_m, Number(path.distance));
  assert.equal(plan.total_s, Number(mode === 'bicycling' ? recorded.bicycling.route.paths[0]!.duration : recorded.walking.route.paths[0]!.cost.duration));
  assert.equal(plan.steps.length, path.steps.length+1);
  assert.deepEqual(plan.steps.slice(0,-1).map(s => s.maneuver), mode === 'bicycling' ?
    ['left','left','right','right','right','right','right','arrive'] : ['right','left','right','arrive']);
  for (const [i, step] of plan.steps.slice(0,-1).entries()) {
    const raw = path.steps[i]!;
    assert.deepEqual(step.maneuver_location,step.polyline.at(-1)); assert.equal(step.index, i); assert.equal(step.instruction, raw.instruction);
    assert.equal(step.road, path.steps[i+1]?.road_name || undefined); assert.equal(step.distance_m, Number(raw.step_distance));
    assert.equal(step.duration_s, Number(raw.cost.duration)); assert.ok(step.polyline.length <= raw.polyline.split(';').length);
    assert.ok(i !== 0 || metres(step.polyline[0]!, origin) < 25);
  }
  assert.deepEqual(plan.steps.at(-1), {index: path.steps.length, maneuver: 'arrive', instruction: '到达虚构广场',
    distance_m: 0, duration_s: 0, maneuver_location: plan.steps.at(-2)!.polyline.at(-1)!, polyline: [plan.steps.at(-2)!.polyline.at(-1)!]});
});

test('route geometry escalates above 5 m to fit the full formal packet and retains segment endpoints',async t=>{
  const body=structuredClone(recorded.walking),start={lat:37.77,lng:-122.4};
  const line=Array.from({length:1201},(_,i)=>`${start.lng+i*0.0005},${start.lat+(i%2)*0.0001}`);
  body.route.paths[0]!.steps=[{...body.route.paths[0]!.steps[0]!,polyline:line.join(';')}];
  const navigation=createAmapNavigation({keyFile:await keyFile(t),fetch:(async()=>response(body)) as typeof fetch});
  const plan=await navigation.plan(start,{name:'终点',lat:start.lat,lng:start.lng+0.6},'walking');
  assert.deepEqual(plan.steps[0]!.polyline,[start,{lat:start.lat,lng:start.lng+0.6}]);
  assert.ok(Buffer.byteLength(JSON.stringify({schema_version:'paios.central.text-envelope.v1',operation:'nav_route',session_id:'s'.repeat(200),coordinate_system:'wgs84',
    nav_id:'00000000-0000-4000-8000-000000000000',revision:Number.MAX_SAFE_INTEGER,...plan}))<=12288);
});

test('a route still above the packet cap at 25 m reports NAVIGATION_ROUTE_TOO_LONG',async t=>{
  const body=structuredClone(recorded.walking),step={...body.route.paths[0]!.steps[0]!,instruction:'沿路步行'.repeat(150),polyline:'-122.4,37.77;-122.3,37.77'};
  body.route.paths[0]!.steps=Array.from({length:20},()=>step);
  const navigation=createAmapNavigation({keyFile:await keyFile(t),fetch:(async()=>response(body)) as typeof fetch});
  await assert.rejects(navigation.plan(origin,destination,'walking'),{code:'NAVIGATION_ROUTE_TOO_LONG',status:413});
});

test('WGS-84 crosses the public port unchanged within 1 m; GCJ is confined to requests and responses', async t => {
  const file = await keyFile(t);
  let sent = '';
  const navigation = createAmapNavigation({keyFile: file, fetch: (async (input: URL) => {
    sent = input.searchParams.get('location')!;
    return response({status: '1', pois: [{name: 'echo', location: sent, address: ''}]});
  }) as typeof fetch});
  await rm(file); // Creation owns the key snapshot; later calls never reread the file.
  for (const near of [{lat:39.908823,lng:116.39747},{lat:31.2304,lng:121.4737},
    {lat:22.5431,lng:114.0579},{lat:30.5728,lng:104.0668},{lat:43.8256,lng:87.6168},{lat:37.7749,lng:-122.4194}]) {
    const [place] = await navigation.search('echo', near); assert.ok(metres(near, place!) < 1);
    if (near.lng === 116.39747) assert.equal(sent, '116.403714,39.910226');
    if (near.lng < 0) {assert.equal(sent, '-122.419400,37.774900'); assert.deepEqual(place, {name:'echo',...near});}
  }
});

test('place search returns at most five candidates ordered by distance when near is given', async t => {
  const navigation = createAmapNavigation({keyFile: await keyFile(t), fetch: (async (input: URL) => {
    assert.equal(input.pathname, '/v5/place/text'); assert.equal(input.searchParams.get('keywords'), '虚构广场');
    assert.equal(input.searchParams.get('page_size'), '5');
    return response({...recorded.text, pois: [...recorded.text.pois].reverse().concat({name:'far',address:'',location:'120,30'})});
  }) as typeof fetch});
  const places = await navigation.search('虚构广场', destination);
  assert.equal(places.length, 5);
  assert.deepEqual(places.map(p=>p.name), ['虚构广场南区','虚构广场地下停车场','虚构广场','虚构广场南区地下停车场','虚构广场北区']);
});

test('the formal maneuver enum maps turn phrases before cardinal orientation', async t => {
  const patterns = [
    ['东','左转掉头','uturn'], ['南','向左后方骑行','sharp_left'], ['西','向右后方步行','sharp_right'],
    ['北','向左前方骑行','slight_left'], ['东','向右前方步行','slight_right'], ['西北','沿路左转','left'],
    ['东北','向东骑行20米右转','right'], ['西','向西步行100米','straight'], ['南','从起点出发','depart'],
    ['东','步行25米到达目的地','arrive'], ['靠左','沿路步行','slight_left'], ['靠右','沿路骑行','slight_right'],
    ['向左急转','骑行100米','sharp_left'], ['向右急转','步行100米','sharp_right']
  ];
  const body = structuredClone(recorded.walking);
  body.route.paths[0]!.steps = patterns.map(([orientation,instruction]) => ({...body.route.paths[0]!.steps[0]!, orientation:orientation!,instruction:instruction!}));
  const navigation = createAmapNavigation({keyFile: await keyFile(t), fetch: (async () => response(body)) as typeof fetch});
  assert.deepEqual((await navigation.plan(origin,destination,'walking')).steps.slice(0,-1).map(s=>s.maneuver), patterns.map(p=>p[2]));
});

test('provider codes survive, empty routes fail, and transport/JSON/provider errors cannot disclose the key', async t => {
  const file = await keyFile(t);
  for (const [body, code, infocode] of [
    [{status:'0',infocode:'10001',info:KEY},'NAVIGATION_PROVIDER_FAILED','10001'],
    [{status:'0',infocode:KEY,info:KEY},'NAVIGATION_PROVIDER_FAILED',undefined],
    [{status:'1',route:{paths:[]}},'NAVIGATION_NO_ROUTE',undefined],
    [{status:'1',route:{paths:[{steps:[]}]}},'NAVIGATION_NO_ROUTE',undefined]
  ] as const) {
    const navigation=createAmapNavigation({keyFile:file,fetch:(async()=>response(body)) as typeof fetch});
    await assert.rejects(navigation.plan(origin,destination,'walking'), (e: {code?:string;infocode?:string}) => {
      assert.equal(e.code,code); assert.equal(e.infocode,infocode); assert.ok(!inspect(e).includes(KEY)); return true;
    });
  }
  for (const fetcher of [async()=>{throw new Error('failed authenticated URL key='+KEY);},
    async()=>new Response(KEY,{status:503}), async()=>new Response(KEY)]) {
    await assert.rejects(createAmapNavigation({keyFile:file,fetch:fetcher as typeof fetch}).search('test'),
      (e:{code?:string})=>{assert.equal(e.code,'NAVIGATION_PROVIDER_FAILED');assert.ok(!inspect(e).includes(KEY));return true;});
  }
});

test('requests abort at eight seconds without retaining the authenticated transport error', async t => {
  let aborted = false;
  const navigation=createAmapNavigation({keyFile:await keyFile(t),fetch:(async (_input:URL, init:RequestInit)=>new Promise((_resolve,reject)=>{
    const guard=setTimeout(()=>reject(new Error('request did not abort')),10_000);
    init.signal!.addEventListener('abort',()=>{aborted=true;clearTimeout(guard);reject(new Error(KEY));},{once:true});
  })) as typeof fetch});
  await assert.rejects(navigation.search('timeout'),(e:{code?:string})=>{
    assert.equal(e.code,'NAVIGATION_PROVIDER_FAILED');assert.ok(!inspect(e).includes(KEY));return true;});
  assert.equal(aborted,true);
});

for (const mode of ['bicycling', 'walking'] as const) test(`v5 ${mode} parses both provider choices without deriving an alternative`, async t => {
  const body = structuredClone(recorded[mode]);
  const alternate = structuredClone(body.route.paths[0]!);
  alternate.distance = '3000';
  Object.assign(alternate, {cost: {duration: '1200'}});
  alternate.steps[0]!.polyline = '116.450182,39.931866;116.449000,39.932000;116.450200,39.933859';
  body.route.paths.push(alternate);
  const navigation = createAmapNavigation({keyFile: await keyFile(t), fetch: (async () => response(body)) as typeof fetch});
  const plan = await navigation.plan(origin, destination, mode);
  assert.equal(plan.total_m, Number(body.route.paths[0]!.distance));
  assert.equal(plan.alternative!.total_m, 3000); assert.equal(plan.alternative!.total_s, 1200);
  assert.notDeepEqual(plan.steps[0]!.polyline, plan.alternative!.steps[0]!.polyline);
  assert.equal(plan.alternative!.steps.at(-1)!.maneuver, 'arrive');
});

test('both route choices fit the formal envelope including overview geometry when switched', async t => {
  const body = structuredClone(recorded.walking);
  const alternate = structuredClone(body.route.paths[0]!);
  const line = Array.from({length: 1201}, (_, i) => `${-122.4+i*0.0005},${37.77+(i%2)*0.0001}`);
  alternate.steps = [{...alternate.steps[0]!, polyline: line.join(';')}];
  body.route.paths.push(alternate);
  const navigation = createAmapNavigation({keyFile: await keyFile(t), fetch: (async () => response(body)) as typeof fetch});
  const plan = await navigation.plan(origin, destination, 'walking');
  const choices = [plan, plan.alternative!];
  for (const [selected, active] of choices.entries()) {
    const other = choices[1-selected]!;
    const packet = {schema_version: 'paios.central.text-envelope.v1', operation: 'nav_route', session_id: 's'.repeat(200),
      coordinate_system: 'wgs84', nav_id: '00000000-0000-4000-8000-000000000000', revision: Number.MAX_SAFE_INTEGER,
      mode: plan.mode, destination: plan.destination, total_m: active.total_m, total_s: active.total_s, steps: active.steps,
      overview: {version: 1, selected, show: false, alternatives: [{total_m: other.total_m, total_s: other.total_s,
        polyline: other.steps.flatMap(step => step.polyline)}]}};
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 12288);
  }
});
