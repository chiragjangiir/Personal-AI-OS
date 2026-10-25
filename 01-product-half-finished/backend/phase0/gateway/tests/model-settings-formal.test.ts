import test from 'node:test';
import assert from 'node:assert/strict';
import {DataPacketKind,RoomEvent} from '@livekit/rtc-node';
import {createFormalTextIngress,FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';
import {modelSettingsPage,modelSettingsState,type ModelSettingsPageRequest} from '../../../services/personal-aios-integration/src/model-settings-view.ts';
import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
test('model settings uses paired formal ingress, typed receipt and a connection-owned watch',async t=>{
  const handlers=new Map<string,(...args:unknown[])=>void>(),published:Record<string,unknown>[]=[],errors:unknown[]=[];
  const source={principal_id:'owner',device_id:'mac',device_type:'mac',capabilities:[],output_modes:['text']};
  const received:Record<string,unknown>[]=[],waiters=new Map<string,()=>void>();let stops=0,notify:((state:Record<string,unknown>)=>Promise<void>)|undefined;
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal'}]]),
    on:(event:string,fn:(...args:unknown[])=>void)=>handlers.set(event,fn),off:(event:string)=>handlers.delete(event),
    localParticipant:{publishData:async(bytes:Uint8Array)=>{const body=JSON.parse(Buffer.from(bytes).toString());published.push(body);waiters.get(String(body.control_id??body.operation))?.();},sendText:async()=>{}}};
  const snapshot={providers:[],roles:Array.from({length:52},(_,index)=>({id:`role-${index}`,profile:'owner',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'}))};
  const authority={read:()=>({environment_id:'fixture',desired:1,groups:{},credentials:{},...snapshot}),readRevision:(revision:number)=>({revision,snapshot,versions:{}})};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>source,ownerControl:async()=>{},
    modelSettingsControl:async(s:unknown,body:Record<string,unknown>)=>{assert.equal(s,source);received.push(body);
      if(body.operation==='model_settings_commit')throw new ContractError('MODEL_SETTINGS_CAS',409);
      return body.operation==='model_settings_read'?modelSettingsPage(authority as never,source as never,body.request as ModelSettingsPageRequest):modelSettingsState(authority as never);},
    modelSettingsWatch:async(_source:unknown,callback:typeof notify)=>{notify=callback;return ()=>{stops++;};}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime:runtime as never,
    authority:{credentialForBootstrap:()=>({})} as never,max_packet_bytes:12288,onError:error=>errors.push(error)});
  t.after(()=>bridge.close());
  await bridge.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'session'}} as never);
  const send=async(body:Record<string,unknown>)=>{
    const receipt=Promise.withResolvers<void>();waiters.set(String(body.control_id),receipt.resolve);
    handlers.get(RoomEvent.DataReceived)?.(Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await receipt.promise;return published.find(p=>p.control_id===body.control_id)!;
  };
  const read=await send({operation:'model_settings_read',control_id:'read:1'});assert.equal(read.ok,true);
  assert.equal((read.result as {items:unknown[]}).items.length,8);assert.ok(Buffer.byteLength(JSON.stringify(read))<=12288);
  assert.equal((await send({operation:'model_settings_watch',control_id:'watch:1'})).ok,true);
  await notify!({environment_id:'fixture',desired:2,groups:{}});assert.equal(published.at(-1)?.operation,'model_settings_state');
  await send({operation:'model_settings_watch',control_id:'watch:2'});assert.equal(stops,1);
  for(const [operation,request] of [['model_settings_key_challenge',undefined],['model_settings_publish_key',{public_x963_b64:'e30='}],['model_settings_pending_macs',{offset:0}],['model_settings_catalog',{draft_id:'draft:1',provider_ref:'provider:1'}]] as const){
    assert.equal((await send({operation,control_id:operation,...(request?{request}:{}),...(operation==='model_settings_publish_key'?{statement_b64:'e30=',signature_b64:'e30='}:{})})).ok,true);
  }
  const failed=await send({operation:'model_settings_commit',control_id:'commit:1',request:{draft_id:'draft:1'},statement_b64:'e30=',signature_b64:'e30='});
  assert.equal(failed.ok,false);assert.equal(failed.error_code,'MODEL_SETTINGS_CAS');assert.equal(received.length,8);
  await new Promise<void>(done=>setImmediate(done));await bridge.close();assert.equal(stops,2);assert.deepEqual(errors.map(error=>String(error)),['Error: MODEL_SETTINGS_CAS']);
});
