import type {SpeakerIdentity,IdentifyInput} from '../../../services/personal-aios-integration/src/voiceprint/contracts.ts';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRealtimeSchemaRegistry } from '../src/realtime-public-control-controller.ts';
import assert from 'node:assert/strict';
import { createPersistentPublicExecutionOwner, identifyPairedCallSpeech } from '../src/persistent-public-execution-owner.ts';
import { createProductionBootstrapConnectedOwner } from '../src/realtime-public-control-pg-composition.ts';
import { createRayneoPersistentProductionHandoff, startRayneoPersistentProduction } from '../src/rayneo-persistent-production-entrypoint.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';

test('retired legacy execution owner rejects before source allocation',async()=>{
  await assert.rejects(createPersistentPublicExecutionOwner({executionOwner:'legacy'} as never),/PUBLIC_EXECUTION_OWNER_INVALID/);
  await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'hermes_text'} as never),/HERMES_INPUT_OWNER_NOT_READY/);
  await assert.rejects(startRayneoPersistentProduction({executionOwner:'hermes_text'} as never),/HERMES_EXECUTION_RESOURCES_CONFLICT/);
});
test('actual PG composition aggregate preserves T04 before central hook and forwards pre-mutation media check/metadata',async()=>{
  const events:string[]=[];const descriptor={inputTopic:'paios.central.text.v1',outputTopic:'paios.central.sealed-text.v1',maxPacketBytes:12288} as const;
  const aggregate=createProductionBootstrapConnectedOwner({onBootstrapConnected:async()=>{events.push('T04');}} as never,{
    centralTextTransport:descriptor,assertBootstrapRequest:()=>{events.push('media');throw new Error('TEXT_ONLY');},
    onBootstrapConnected:async()=>{events.push('central');},close:async()=>{events.push('close');}});
  assert.throws(()=>aggregate.assertBootstrapRequest!({}),/TEXT_ONLY/);assert.deepEqual(events,['media']);
  events.length=0;assert.equal(aggregate.centralTextTransport,descriptor);
  await aggregate.onBootstrapConnected!({} as RealtimeBootstrapConnectedInput);assert.deepEqual(events,['T04','central']);
  assert.equal(aggregate.ownsClose,false);await aggregate.close!();assert.equal(events.at(-1),'close');
});

test('bootstrap closed schema permits exact optional central descriptor and keeps legacy valid',async()=>{
  const legacy=JSON.parse(await readFile(new URL('../../../tests/contracts/fixtures/realtime-public-control/bootstrap-response.valid.json',import.meta.url),'utf8'));
  const registry=createRealtimeSchemaRegistry();assert.equal(registry.validateResponse('bootstrap',legacy),true);
  const metadata={schema:'paios.central.text-transport.v1',execution_owner:'hermes_text',expected_gateway_identity:'actual-source-gateway',input_topic:'paios.central.text.v1',output_topic:'paios.central.sealed-text.v1',max_packet_bytes:12288};
  assert.equal(registry.validateResponse('bootstrap',{...legacy,central_text_transport:metadata}),true);
  for(const bad of [{...metadata,secret:'forbidden'},{...metadata,execution_owner:'legacy'},{...metadata,expected_gateway_identity:''},{...metadata,input_topic:'arbitrary'},{...metadata,max_packet_bytes:12289}])
    assert.equal(registry.validateResponse('bootstrap',{...legacy,central_text_transport:bad}),false);
});


test('paired call identity keeps short evidence undecided and missing enrollment uncertain',async()=>{
  const samples=new Float32Array(3200),signal=new AbortController().signal;
  let enrolled=false,embeddings=0;
  let identity:SpeakerIdentity={kind:'unknown',reason:'no_enrollment'};
  const registry={owner:async()=>({enrolled}) as never,identify:async(embedding:Float32Array,input:{mode:string;speech_ms:number})=>{
    assert.equal(embedding.length,2);assert.equal(input.mode,'call');assert.ok(input.speech_ms>=200);return identity;
  }};
  const embed=async(pcm:Float32Array,abort:AbortSignal)=>{assert.equal(pcm,samples);assert.equal(abort,signal);embeddings++;return new Float32Array([1,0]);};
  assert.equal(await identifyPairedCallSpeech(registry,embed,samples,128,signal),undefined);assert.equal(embeddings,0);
  assert.equal(await identifyPairedCallSpeech(undefined,embed,samples,128,signal),undefined);
  assert.deepEqual(await identifyPairedCallSpeech(undefined,embed,samples,1000,signal),{verdict:'uncertain'});assert.equal(embeddings,0);
  assert.deepEqual(await identifyPairedCallSpeech(registry,embed,samples,1000,signal),{verdict:'uncertain',embedding:new Float32Array([1,0])});
  identity={kind:'speaker',cluster_id:'2',score:.82};
  assert.deepEqual(await identifyPairedCallSpeech(registry,embed,samples,1000,signal),{verdict:'uncertain',embedding:new Float32Array([1,0])},'no enrolled owner to tell a known voice apart');
  identity={kind:'assistant',score:.91};
  assert.deepEqual(await identifyPairedCallSpeech(registry,embed,samples,200,signal),{verdict:'assistant',score:.91,embedding:new Float32Array([1,0])});
  enrolled=true;
  const cases:readonly [SpeakerIdentity,{verdict:string;score?:number;call_only?:true;trust_window?:true}][]=[
    [{kind:'owner',band:'verified',score:.78},{verdict:'owner',score:.78}],
    [{kind:'owner',band:'verified',score:.91,call_only:true},{verdict:'owner',score:.91,call_only:true}],
    [{kind:'owner',band:'verified',score:.2,call_only:true,trust_window:true},{verdict:'owner',score:.2,call_only:true,trust_window:true}],
    [{kind:'owner',band:'uncertain',score:.54},{verdict:'uncertain',score:.54}],
    [{kind:'speaker',cluster_id:'2',score:.82},{verdict:'guest',score:.82}],
    [{kind:'assistant',score:.93},{verdict:'assistant',score:.93}],
    [{kind:'unknown',reason:'too_short'},{verdict:'unknown'}],
    [{kind:'unknown',reason:'low_quality'},{verdict:'unknown'}],
    [{kind:'unknown',reason:'unmatched'},{verdict:'unknown'}],
  ];
  for(const [result,expected] of cases){identity=result;assert.deepEqual(await identifyPairedCallSpeech(registry,embed,samples,200,signal),{...expected,embedding:new Float32Array([1,0])});}
  await assert.rejects(identifyPairedCallSpeech(registry,async()=>{throw new Error('embedding failed');},samples,200,signal),/embedding failed/);
  await assert.rejects(identifyPairedCallSpeech({...registry,owner:async()=>{throw new Error('registry failed');}},embed,samples,200,signal),/registry failed/);
  await assert.rejects(identifyPairedCallSpeech({...registry,identify:async()=>{throw new Error('identify failed');}},embed,samples,200,signal),/identify failed/);
});


test('paired call identity forwards the device and call to the registry and respects biometric owner without enrollment',async()=>{
  const source={principal_id:'owner',device_id:'phone',device_type:'phone'},samples=new Float32Array(3200).fill(.02),signal=new AbortController().signal;
  const observed_at='2026-10-18T10:00:00.000Z';
  const registry={owner:async()=>({enrolled:false}) as never,identify:async(_embedding:Float32Array,input:unknown)=>{
    assert.deepEqual(input,{speech_ms:200,signal,mode:'call',channel:'video',observed_at,principal_id:source.principal_id,device_id:source.device_id,call_id:'call-1',quality:1});
    return {kind:'owner',band:'verified',score:.2,call_only:true} as const;
  }};
  assert.deepEqual(await identifyPairedCallSpeech(registry,async()=>new Float32Array([1,0]),samples,200,signal,observed_at,'video',undefined,{source,call_id:'call-1',trust_call:true}),
    {verdict:'owner',score:.2,call_only:true,embedding:new Float32Array([1,0])});
});


test('paired speech uses the capture device chain and omits call holds for ambient streams',async()=>{
  const samples=new Float32Array(3200).fill(.02),signal=new AbortController().signal,seen:IdentifyInput[]=[];
  const registry={owner:async()=>({enrolled:false}) as never,identify:async(_embedding:Float32Array,input:IdentifyInput)=>{seen.push(input);return {kind:'unknown',reason:'no_enrollment'} as const;}};
  for(const [device_type,channel] of [['glasses','glasses'],['mac','mac'],['phone','video'],['watch','video']] as const){
    await identifyPairedCallSpeech(registry,async()=>new Float32Array([1,0]),samples,200,signal,'2026-10-18T10:00:00.000Z','video',undefined,
      {source:{principal_id:'owner',device_id:device_type,device_type},call_id:'ambient-stream',trust_call:false});
    assert.equal(seen.at(-1)!.channel,channel);assert.equal('call_id' in seen.at(-1)!,false);
  }
});


test('terminal paired speech preserves device scope and channel while forbidding learning and call holds',async()=>{
  const source={principal_id:'owner',device_id:'phone',device_type:'phone'},samples=new Float32Array(3200).fill(.02),signal=new AbortController().signal;
  const observed_at='2026-10-18T10:00:00.000Z';
  const registry={owner:async()=>({enrolled:false}) as never,identify:async(_embedding:Float32Array,input:IdentifyInput)=>{
    assert.deepEqual(input,{speech_ms:200,signal,mode:'call',channel:'video',observed_at,principal_id:'owner',device_id:'phone',learning:false,quality:1});
    return {kind:'owner',band:'verified',score:.2,call_only:true,trust_window:true} as const;
  }};
  assert.deepEqual(await identifyPairedCallSpeech(registry,async()=>new Float32Array([1,0]),samples,200,signal,observed_at,'video',undefined,{source,call_id:'closing-call',trust_call:true,learning:false}),
    {verdict:'owner',score:.2,call_only:true,trust_window:true,embedding:new Float32Array([1,0])});
});

test('owner override admits paired call speech before embedding and keeps guest authorization restricted',async()=>{
  let active=true,embeddings=0,identifications=0;
  const registry={owner:async()=>({enrolled:true}) as never,identify:async()=>{identifications++;return {kind:'unknown',reason:'unmatched'} as const;}};
  const embed=async()=>{embeddings++;return new Float32Array([1,0]);},samples=new Float32Array(1600),signal=new AbortController().signal;
  for(const ms of [100,600,1200])assert.deepEqual(await identifyPairedCallSpeech(registry,embed,samples,ms,signal,undefined,'call',undefined,undefined,{active:async()=>active}),{verdict:'owner',call_only:true});
  assert.equal(embeddings,0);assert.equal(identifications,0);active=false;
  assert.equal(await identifyPairedCallSpeech(registry,embed,samples,100,signal,undefined,'call',undefined,undefined,{active:async()=>active}),undefined);
  assert.deepEqual(await identifyPairedCallSpeech(registry,embed,samples,1200,signal,undefined,'call',undefined,undefined,{active:async()=>active}),{verdict:'unknown',embedding:new Float32Array([1,0])});
  assert.equal(embeddings,1);assert.equal(identifications,1);
});
