import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv} from 'ajv';
import {createAvatarWire} from '../src/personal-aios-avatar-wire.ts';
import {createWireExtensions,type WireAttachment,type WireBody} from '../src/personal-aios-terminal-wire.ts';
import type {AvatarProfile} from '../src/avatar-profile.ts';

const profile:AvatarProfile={version:1,look_id:'approved',style:'cartoon',image_url:'https://assets.example/approved.jpg',focus:{x:.5,y:.4},updated_at:'2026-10-17T00:00:00.000Z'};
const source={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'owner-consent',channel:'formal',capabilities:['display'],route_version:'v1',output_modes:['text']} as WireAttachment['device'];

test('avatar sync uses display capability, isolates owners, and publishes current state after reconnect',async()=>{
  let selected:AvatarProfile|null=null;
  const listeners=new Set<(principal:string,profile:AvatarProfile|null)=>void>();
  const wire=createAvatarWire({snapshot:async principal=>({profile:principal==='owner'?selected:null,profile_version:selected?.version??0,loaded_receipts:[]}),loaded:async()=>{},
    watch:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};}},error=>{throw error;});
  const frames:WireBody[]=[];
  let received=Promise.withResolvers<void>();
  const ctx={room:{} as WireAttachment['room'],identity:'glasses',leave:async()=>{},device:source,current:()=>true,ready:async()=>{},publish:async(body:WireBody)=>{frames.push(body);received.resolve();}} as WireAttachment;
  const stop=wire.prepare!(ctx);await received.promise;
  assert.equal(frames.at(-1)?.profile,null);
  received=Promise.withResolvers<void>();selected=profile;
  for(const listener of listeners)listener('other-owner',profile);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(frames.length,1);
  for(const listener of listeners)listener('owner',profile);
  await received.promise;assert.deepEqual(frames.at(-1)?.profile,profile);
  selected={...profile,version:2};received=Promise.withResolvers<void>();wire.attach!(ctx);
  await received.promise;assert.equal((frames.at(-1)?.profile as AvatarProfile).version,2);
  await wire.handle('avatar_sync',{request_id:'sync'},source,async body=>{frames.push(body);});
  assert.equal(frames.at(-1)?.request_id,'sync');
  await assert.rejects(wire.handle('avatar_sync',{}, {...source,capabilities:['microphone']},async()=>{}),/AVATAR_DISPLAY_REQUIRED/);
  stop();assert.equal(listeners.size,0);
});

test('registered avatar contract validates bounded profile projection and rejects bad inputs',()=>{
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',()=>true);
  const wire=createAvatarWire({snapshot:async()=>({profile,profile_version:profile.version,loaded_receipts:[]}),loaded:async()=>{},watch:()=>()=>{}},()=>{});
  const extensions=createWireExtensions([wire],{schema:'paios.central.text-envelope.v1',inputs:{},outputs:{}},s=>ajv.compile(s));
  assert.equal(extensions.has('avatar_sync'),true);
  assert.deepEqual(extensions.output({operation:'avatar_state',session_id:'session',profile},()=>{throw Error('fallback');}),
    {operation:'avatar_state',session_id:'session',profile,schema_version:'paios.central.text-envelope.v1'});
  assert.throws(()=>extensions.output({operation:'avatar_state',session_id:'session',profile:{...profile,version:0}},()=>({})),/FORMAL_TEXT_OUTPUT_INVALID/);
  return assert.rejects(extensions.handle({operation:'avatar_sync',principal_id:'other'},source,async()=>{}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
});

// Read the actual reconnect request, rather than a second hand-written client fixture.
test('glasses reconnect avatar request passes the registered ingress and returns the profile',async()=>{
  const client=readFileSync(new URL('../../../../glasses-android/app/src/main/java/com/personalaios/glasses/CompanionService.kt',import.meta.url),'utf8');
  const request=client.split('\n').find(line=>line.includes('live.send(JSONObject()')&&line.includes('"avatar_sync"'));
  assert.ok(request,'glasses reconnect sends an avatar sync');
  const fields=[...request.matchAll(/\.put\("([^"\n]+)", "([^"\n]+)"\)/g)];
  const body=Object.fromEntries(fields.map(([,key,value])=>[key,value])) as WireBody;
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',()=>true);
  const wire=createAvatarWire({snapshot:async()=>({profile,profile_version:profile.version,loaded_receipts:[]}),loaded:async()=>{},watch:()=>()=>{}},error=>{throw error;});
  const ingress=createWireExtensions([wire],{schema:'paios.central.text-envelope.v1',inputs:{},outputs:{}},s=>ajv.compile(s));
  const frames:WireBody[]=[];
  await ingress.handle(body,source,async frame=>{frames.push(frame);});
  assert.deepEqual(frames,[{operation:'avatar_state',profile,profile_version:1,loaded_receipts:[]}]);
});

test('loaded receipts derive device identity from the authenticated source and validate the input version',async()=>{
  const loaded:unknown[]=[];
  const wire=createAvatarWire({snapshot:async()=>({profile,profile_version:1,loaded_receipts:[]}),
    loaded:async(...args)=>{loaded.push(args);},watch:()=>()=>{}},error=>{throw error;});
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',()=>true);
  const ingress=createWireExtensions([wire],{schema:'paios.central.text-envelope.v1',inputs:{},outputs:{}},s=>ajv.compile(s));
  const frames:WireBody[]=[];
  await ingress.handle({operation:'avatar_loaded',profile_version:1},source,async frame=>{frames.push(frame);});
  assert.deepEqual(loaded,[['owner','glasses','glasses',1]]);
  assert.equal(frames[0]?.profile_version,1);
  await assert.rejects(ingress.handle({operation:'avatar_loaded',profile_version:1,device_id:'mac'},source,async()=>{}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
  await assert.rejects(ingress.handle({operation:'avatar_loaded',profile_version:-1},source,async()=>{}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
});
