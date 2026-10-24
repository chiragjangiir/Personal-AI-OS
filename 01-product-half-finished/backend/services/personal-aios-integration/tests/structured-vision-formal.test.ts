import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DataPacketKind,Room,RoomEvent} from '../../../phase0/gateway/node_modules/@livekit/rtc-node/dist/index.js';
import {createFormalTextIngress,FORMAL_CAMERA_TOPIC,FORMAL_TEXT_INPUT_TOPIC} from '../../../phase0/gateway/src/personal-aios-formal-text.ts';
import {FormalSourceAuthority,FormalTerminalSources} from '../../../phase0/gateway/src/personal-aios-formal-source.ts';
import type {LiveKitCloudParticipantPort} from '../../../phase0/gateway/src/livekit-cloud-participant.ts';
import type {RealtimeBootstrapConnectedInput} from '../../../phase0/gateway/src/realtime-public-control-runtime.ts';
import type {RealtimeCurrentBindingProjection} from '../../realtime-core/src/types.ts';
import {canonical,ContractError,sha256} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {GLASSES_CAPABILITIES} from '../src/source-authority.ts';
import {HermesClient,PersonalAIOSRuntime,RunAdmission,sourceClient} from './native-source-fixture.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {VisualMemory} from '../src/visual/store.ts';
import {prepareVisualImage} from '../src/visual/image.ts';
import {describeVision,VISION_CAPTION_SCHEMA} from '../src/visual/models.ts';

// Same host-issued binding contract as the gateway formal-text fixture.
function sourceFixture(registry:FormalTerminalSources){
  const now='2026-10-01T00:00:00.000Z',future='2026-10-01T01:00:00.000Z';
  const sessionRef={ref_type:'realtime_session',ref_id:'camera-session'},leaseRef={ref_type:'device_lease',ref_id:'camera-lease'};
  const input={request:{request_id:'bootstrap'},bearer:{principal:{opaque_ref:'host-owner'},deviceId:'glasses'},governance:{accepted:true},
    authority:{gateway:{identity:'camera-gateway',roomName:'room'}},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',credentialRoom:'room',credentialIdentity:'terminal'},
    enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const current={session:{realtimeSessionRef:sessionRef,userId:'owner',continuityId:'continuity',state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:future,activeDeviceId:'glasses',activeDeviceLeaseRef:leaseRef,
    binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',deviceId:'glasses',connectionEpoch:'1'}},
    lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'continuity',userId:'owner',deviceId:'glasses',state:'active',
      expiresAt:future,leaseVersion:'1',fencingToken:'1',purpose:'typed-submit',capabilities:['data']}} as unknown as RealtimeCurrentBindingProjection;
  const authority=new FormalSourceAuthority({credentialRegistry:registry,
    ownerContext:{resolve:async()=>({userId:'owner',deviceId:'glasses',purpose:'typed-submit',capabilities:['data'],occurredAt:now as never})},
    readCurrentBinding:async()=>current,sameRef:(a,b)=>canonical(a)===canonical(b),now:()=>Date.parse(now),
    resolveSource:async()=>({device_type:'glasses',channel:'rtc_typed_text',capabilities:GLASSES_CAPABILITIES,
      consent_ref:'camera-consent',route_version:'camera-route',output_modes:['text']})});
  return {input,authority};
}
async function eventually(predicate:()=>boolean|Promise<boolean>){
  const deadline=Date.now()+5000;
  while(!await predicate()){if(Date.now()>deadline)throw new Error('FORMAL_CAMERA_TEST_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,5));}
}

test('formal camera stream persists structured caption and person links; caption 502 rejects without acknowledging or publishing evidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'structured-camera-')),directory=join(root,'visual');
  const storage=new PosixStorage(root),sources=new FormalTerminalSources();
  let archive=new RawArchive(storage,4*1024*1024);
  const model={id:'synthetic-voice',sha256:'a'.repeat(64),dim:16};
  let people=new VoiceprintRegistry(storage,model),visual:VisualMemory|undefined,runtime:PersonalAIOSRuntime|undefined;
  let bridge:ReturnType<typeof createFormalTextIngress>|undefined;
  t.after(async()=>{await bridge?.close();await runtime?.close();await visual?.close();await people.close();await rm(root,{recursive:true,force:true});});
  const prepared=await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)));
  const image=prepared.thumbnail,face=Float32Array.from({length:128},(_,i)=>i===0?1:0);
  let failCaption=false,requests=0,faceCalls=0;
  const httpEndpoint=process.env.PAIOS_STRUCTURED_VISION_TEST_URL;
  const native=new HermesClient(httpEndpoint??'http://127.0.0.1:1',process.env.PAIOS_STRUCTURED_VISION_TEST_TOKEN??'synthetic-token-abcdefghijklmnop',5000,65536,undefined,async(input,init)=>{
    assert.equal(new URL(String(input)).pathname,'/v1/paios/vision','camera observations never create native runs');
    const body=JSON.parse(String(init?.body));requests++;
    assert.deepEqual(Buffer.from(body.image_url.split(',')[1],'base64'),image);
    if('response_schema' in body){assert.deepEqual(body.response_schema,VISION_CAPTION_SCHEMA);assert.match(body.prompt,/first-person scene/u);}
    else assert.ok(['Where is the key?','Echo failure?'].includes(body.prompt),'free questions retain their original prompt');
    // The native API test can supply its isolated real HTTP server and provider.
    if(httpEndpoint)return fetch(input,init);
    if(!('response_schema' in body))return body.prompt==='Echo failure?'?Response.json({error:'vision failed'},{status:502}):new Response('The key is on the white desk.');
    return failCaption?Response.json({error:'caption provider failed'},{status:502}):
      Response.json({caption:'白色桌面上放着钥匙，一位来访者站在旁边',ocr:'会议室 301'});
  });
  const models={embedImage:async()=>Array.from({length:1024},(_,i)=>i===0?1:0),embedQuery:async()=>Array(1024).fill(1),
    describe:(bytes:Buffer,signal?:AbortSignal)=>describeVision(native.analyzeVision.bind(native),bytes,signal)};
  const faces={prepare:async(bytes:Buffer)=>{faceCalls++;assert.deepEqual(bytes,image);return {...prepared,faces:[{embedding:face,bbox:[0,0,1,1],confidence:1}]};}};
  await people.faceRecognition(true);
  visual=await VisualMemory.open(directory,models,{},people,faces,undefined,archive);
  runtime=new PersonalAIOSRuntime({storage,archive,native,visual_memory:visual,voiceprint:people,sourceAuthority:sources,
    output:new OutputAuthority(storage),skill:'fixed',max_read_bytes:65536,
    admission:new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
      poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'structured-camera'})});
  const f=sourceFixture(sources),room=new Room() as any,packets:any[]=[],errors:unknown[]=[];
  Object.defineProperty(room,'isConnected',{value:true});
  room.remoteParticipants.set('terminal',{identity:'terminal',trackPublications:new Map()});
  room.localParticipant={trackPublications:new Map(),sendText:async()=>{},
    publishData:async(bytes:Uint8Array)=>{packets.push(JSON.parse(Buffer.from(bytes).toString('utf8')));}};
  bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{room.cleanupOnDisconnect();}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:12288,onError:error=>errors.push(error)});
  await bridge.onBootstrapConnected(f.input);
  room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'wear_state',control_id:'wear',worn:true})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>packets.some(p=>p.operation==='wear_state_ack'));
  const sendFrame=(frame_id:string,captured_at:string)=>{
    const frame={frame_id,captured_at,trigger:'user_request',worn:true,private_paused:false};
    room.handleStreamHeader({streamId:frame_id,topic:FORMAL_CAMERA_TOPIC,mimeType:'image/jpeg',totalLength:BigInt(image.length),timestamp:0n,
      attributes:{frame:JSON.stringify(frame)},contentHeader:{case:'byteHeader',value:{name:'frame.jpg'}}},'terminal');
    room.handleStreamChunk({streamId:frame_id,content:image,chunkIndex:0n});room.handleStreamTrailer({streamId:frame_id});
  };
  const at=Date.now();sendFrame('face-positive',new Date(at).toISOString());
  await eventually(()=>packets.some(p=>p.operation==='camera_ack'));
  assert.deepEqual(packets.filter(p=>p.operation==='camera_ack').map(p=>[p.frame_id,p.status]),[['face-positive','kept']]);
  const recalled=(await visual.recall('owner',{})).frames;
  assert.equal(recalled.length,1);assert.equal(recalled[0]!.ocr,'会议室 301');
  assert.equal(recalled[0]!.caption,'白色桌面上放着钥匙，一位来访者站在旁边');
  const person=(await people.clusters())[0]!;
  assert.deepEqual(visual.personIdsInFrames([recalled[0]!.frame_id]),[person.cluster_id]);
  await people.renameCluster(person.cluster_id,{display_name:'测试来访者'});
  failCaption=true;sendFrame('caption-failed',new Date(at+120000).toISOString());
  await eventually(()=>packets.some(p=>p.operation==='rejected'));
  assert.equal(packets.find(p=>p.operation==='rejected').error_code,'HERMES_HTTP_502');
  assert.deepEqual(errors.map(e=>(e as ContractError).code),['HERMES_HTTP_502']);
  assert.equal(requests,2);assert.equal(faceCalls,2);
  assert.equal(packets.filter(p=>p.operation==='camera_ack').length,1,'failed caption has no success ACK');
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});
  try{
    assert.equal(db.prepare("SELECT count(*) AS n FROM frames WHERE frame_id='caption-failed'").get()!.n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM frame_people').get()!.n,1);
    const failed=db.prepare('SELECT raw_ref,archive_revision FROM capture_refs WHERE captured_ms=?').get(at+120000)!;
    const original=await archive.readRecord(String(failed.raw_ref),'owner',String(failed.archive_revision),{maxReadBytes:4*1024*1024});
    assert.equal(original.kind,'original');assert.deepEqual(Buffer.from((original as {bytes:Uint8Array}).bytes),image);
  }finally{db.close();}
  await bridge.close();await runtime.close();await visual.close();await people.close();
  people=new VoiceprintRegistry(storage,model);
  archive=new RawArchive(storage,4*1024*1024);
  visual=await VisualMemory.open(directory,models,{},people,faces,undefined,archive);
  const reopened=(await visual.recall('owner',{query:'测试来访者'})).frames;
  assert.equal(reopened.length,1);assert.equal(reopened[0]!.frame_id,recalled[0]!.frame_id);
  assert.deepEqual(reopened[0]!.people,[{speaker_ref:`speaker:${person.cluster_id}`,name:'测试来访者'}]);
  assert.deepEqual(visual.personIdsInFrames(),[person.cluster_id]);
  assert.equal(requests,2,'reopening uses durable evidence without a fresh caption request');
  assert.deepEqual((await visual.recall('other-owner',{})).frames,[]);
  // Qualify a real owner run through admission; only the native run transport is synthetic.
  const run={run_id:'vision-question-run',session_id:'question-session',conversation_session_id:'question-session',status:'running'};
  let creates=0;
  const questionNative=sourceClient({create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})});
  questionNative.analyzeVision=native.analyzeVision.bind(native);
  runtime=new PersonalAIOSRuntime({storage,archive,native:questionNative,visual_memory:visual,
    devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'http',consent_ref:'question-consent',
      route_version:'phone-route',output_modes:['text'],token_sha256:sha256('question-token')}],
    output:new OutputAuthority(storage),skill:'fixed',max_read_bytes:65536,
    admission:new RunAdmission(storage,questionNative,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
      poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'visual-question'})});
  const phone=await runtime.authenticate('question-token');
  const submitted=await runtime.submit({schema_version:'paios.event.v1',event_id:'visual-question',captured_at:new Date().toISOString(),
    device_id:'phone',device_type:'phone',source:{channel:'http'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',
    payload:Buffer.from('Where is the key?')},phone,'question-session',true);
  await eventually(async()=>Boolean((await runtime!.event(phone,'question-session',submitted.processed_event.processed_event_id)).admission.run_id));
  assert.equal(creates,1);
  const ask=(question:string,tool_call_id:string)=>runtime!.tool('paios_visual_analyze',{
    context:{run_id:run.run_id,session_id:'question-session',tool_call_id},args:{frame_id:reopened[0]!.frame_id,question,full:true}});
  assert.equal(await ask('Where is the key?','question-ok'),'The key is on the white desk.');
  assert.deepEqual(await ask('Echo failure?','question-error'),{status:'failed',error_code:'HERMES_HTTP_502',http_status:502,camera_statuses:[]});
  assert.equal(requests,4,'both tools reached HermesClient after actual owner/frame lookup');
});
