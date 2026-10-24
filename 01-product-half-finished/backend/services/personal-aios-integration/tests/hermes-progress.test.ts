import assert from 'node:assert/strict';
import test from 'node:test';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';

function client(frames:string[],maximum=4096){
  let cancelled=false;
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(String(url),'http://127.0.0.1:8642/v1/runs/run-1/events?after_seq=0');
    assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer synthetic-token-at-least-24-chars');
    return new Response(new ReadableStream({start(controller){
      for(const frame of frames)controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  };
  return {native:new HermesClient('http://127.0.0.1:8642','synthetic-token-at-least-24-chars',1000,maximum,undefined,fetcher),
    cancelled:()=>cancelled};
}
let seq=0;
const event=(event:string,extra:Record<string,unknown>={})=>`data: ${JSON.stringify({run_id:'run-1',event,seq:++seq,timestamp:Date.now()/1000,...extra})}\n\n`;
const run=(status:string)=>({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',
  run_id:'run-1',session_id:'session-1',conversation_session_id:'session-1',status});
test('native progress delivers actual commentary and stops at terminal without exposing reasoning',async()=>{
  seq=0;const snapshot=event('run.snapshot',{seq:0,run:run('running'),activity_events:[]});
  const frame=event('message.interim',{seq:2,text:'已查到资料，正在核对。'}),out:string[]=[];
  const f=client([snapshot,': keepalive\n\n'+event('reasoning.available',{seq:1,text:'private reasoning'}),frame.slice(0,13),frame.slice(13),
    event('run.updated',{seq:3,run:run('completed')}),event('message.interim',{seq:4,text:'late'})]);
  await f.native.progress('run-1',text=>out.push(text));
  assert.deepEqual(out,['已查到资料，正在核对。']);
});
test('native progress surfaces wrong bindings, oversized records and truncated frames',async()=>{
  for(const [frames,maximum,error] of [
    [['data: {"run_id":"other","event":"message.interim","text":"wrong"}\n\n'],4096,/BINDING_INVALID/],
    [[event('message.interim',{text:'x'.repeat(512)})],128,/TOO_LARGE/],
    [['data: {"run_id":"run-1"}'],4096,/TRUNCATED/],
  ] as const)await assert.rejects(client([...frames],maximum).native.progress('run-1',()=>assert.fail('must not speak')),error);
});

test('front mirror forwards trusted speech and returns the server native transcript for owner binding',async()=>{
  const calls:unknown[]=[];
  const native=new HermesClient('http://127.0.0.1:8642','synthetic-token-at-least-24-chars',1000,4096,undefined,
    (async(url,options)=>{
      assert.equal(String(url),'http://127.0.0.1:8642/v1/paios/front-turn');
      calls.push(JSON.parse(String(options?.body)));
      return Response.json({session_id:'native-front-transcript',processed_event_id:'d-front',replayed:false});
    }) as typeof fetch);
  const d={processed_event_id:'d-front',captured_at:'2026-10-17T12:00:00Z',principal_id:'owner',user_identity:'owner',
    origin:'device_observation',media_type:'app_event',content:{app_event:{kind:'voice_turn',user:'你好',assistant:'你好呀',speaker:'owner'}}} as unknown as
    import('../src/contracts.ts').ProcessedEvent;
  assert.equal(await native.mirrorCallTurn(d,'conversation'),'native-front-transcript');
  assert.deepEqual(calls,[{session_id:'conversation',processed_event_id:'d-front',input:JSON.stringify(d),captured_at:d.captured_at}]);
  await assert.rejects(native.mirrorCallTurn({...d,user_identity:'unknown'},'conversation'),/INVALID_FRONT_TURN/);
  assert.equal(calls.length,1);
});
