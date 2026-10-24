import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerActionGrant,runScope,type ProcessedEvent} from '../src/contracts.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
const grants=['desktop','terminal','file'];
const event=(values:Partial<ProcessedEvent>={})=>({origin:'explicit_user_prompt',media_type:'text',user_identity:'owner',principal_id:'owner',
  content:{},source:{channel:'rtc_typed_text'},...values}) as ProcessedEvent;
test('I17 action grants distinguish explicit owner requests, trusted continuations and observation/care/build',async()=>{
  assert.deepEqual(await ownerActionGrant(event()),grants);
  assert.deepEqual(await ownerActionGrant(event({origin:'device_observation',user_identity:'unknown'})),[]);
  for(const app_event of [{kind:'voice_confirmation'},{kind:'voice_turn',speaker:'owner'}])
    assert.deepEqual(await ownerActionGrant(event({origin:'device_observation',media_type:'app_event',content:{app_event}})),grants);
  for(const app_event of [{kind:'call_turn'},{kind:'voice_turn'},{kind:'voice_turn',speaker:'speaker:3'}])
    assert.deepEqual(await ownerActionGrant(event({origin:'device_observation',media_type:'app_event',content:{app_event}})),[]);
  for(const kind of ['glasses_gesture','proactive_care','place_transition','call_turn','health_update','payment_update'])assert.deepEqual(await ownerActionGrant(event({origin:'device_observation',user_identity:kind==='place_transition'?'unknown':'owner',media_type:'app_event',content:{app_event:{kind}}})),[]);
  for(const kind of ['scheduled_task','desktop_queue_task','errand_result','errand_delivery_failed','task_failure','release_approval_required']){
    const continuation=event({processed_event_id:'continuation',origin:'device_observation',user_identity:'unknown',media_type:'app_event',content:{app_event:{kind}}});
    assert.deepEqual(await ownerActionGrant(continuation,async()=>event({processed_event_id:'explicit'})),grants);
    assert.deepEqual(await ownerActionGrant(continuation,async()=>event({processed_event_id:'observation',origin:'device_observation',user_identity:'unknown'})),[]);
    assert.deepEqual(await ownerActionGrant(continuation,async()=>continuation),[]);
    for(const app_event of [{kind:'proactive_care'},{kind:'voice_turn',speaker:'speaker:guest'}])
      assert.deepEqual(await ownerActionGrant(continuation,async()=>event({processed_event_id:'non-owner',origin:'device_observation',user_identity:'unknown',media_type:'app_event',content:{app_event}})),[]);
    assert.deepEqual(await ownerActionGrant(continuation,async()=>event({processed_event_id:'foreign',principal_id:'other'})),[]);
  }
  for(const kind of ['scheduled_task','build_task'])assert.deepEqual(await ownerActionGrant(event({origin:'device_observation',user_identity:'unknown',media_type:'app_event',source:{channel:'background_scheduled'},content:{app_event:{kind}}})),[]);
});
test('I17 native acceptance must echo the exact grant set; dropped/different acknowledgement stops the accepted run',async()=>{
  for(const ack of [undefined,[],['desktop'],grants]){
    let stops=0;
    const client=new HermesClient('http://127.0.0.1:1','synthetic-grant-key-abcdefghijkl',10000,1048576,undefined,async(input)=>{
      if(String(input).endsWith('/stop'))stops++;
      return Response.json({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',run_id:'grant-run',session_id:'s',conversation_session_id:'s',status:'running',...(ack===undefined?{}:{granted_toolsets:ack})});
    });
    const result=client.create({input:'owner request',instructions:'test',session_id:'s',memory_write:false,grant_toolsets:grants},'key');
    if(ack===grants){await result;assert.equal(stops,0);}else{await assert.rejects(result,/HERMES_RUN_SCOPE_NOT_ENFORCED/u);assert.equal(stops,1);}
  }
});

test('payment eligibility helper cannot attest paired PTT identity or grant native action toolsets',async()=>{
  const d=event({origin:'device_observation',media_type:'audio',user_identity:'unknown',principal_id:'owner',device_id:'phone',device_type:'phone',segment_basis:'speech_candidate',
    processing:{path_id:'voice_frontend'} as ProcessedEvent['processing']});
  const source={principal_id:'owner',device_id:'phone',device_type:'phone' as const,chat_ui:true};
  assert.equal(runScope(d),'owner_uncertain');
  assert.deepEqual(await ownerActionGrant(d),[]);
  assert.deepEqual(await ownerActionGrant(d,undefined,{payment_source:source}),grants);
  for(const invalid of [{...source,chat_ui:false},{...source,device_id:'other'},{...source,principal_id:'other'},{...source,device_type:'glasses' as const}])
    assert.deepEqual(await ownerActionGrant(d,undefined,{payment_source:invalid}),[]);
  assert.deepEqual(await ownerActionGrant({...d,processing:{...d.processing,path_id:'local_split_media'}},undefined,{payment_source:source}),[]);
});
