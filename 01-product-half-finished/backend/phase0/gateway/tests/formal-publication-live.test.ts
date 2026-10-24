import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {Room,RoomEvent,dispose} from '@livekit/rtc-node';
import {createGatewayRoom} from '../src/sdk-room.ts';
import {AccessToken} from 'livekit-server-sdk';
import {createFormalTextIngress,FORMAL_TEXT_OUTPUT_TOPIC,FORMAL_TEXT_INPUT_TOPIC,type CallSink} from '../src/personal-aios-formal-text.ts';
import {createVoiceCallSession} from '../src/voice-call-session.ts';
import {createTerminalWire} from '../src/personal-aios-terminal-wire.ts';
import {MAC_CAPABILITIES} from '../../../services/personal-aios-integration/src/source-authority.ts';

// Opt-in loopback integration. RTC, ingress, call owner and terminal extension are real.
// Runtime/auth/database/model ports are synthetic; this does not certify real devices or HTTP control.
const enabled=process.env.PUB504_LIVE==='1',endpoint='ws://127.0.0.1:19780';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>Promise.withResolvers<void>();
async function until(predicate:()=>boolean,ms=5000){const start=Date.now();while(!predicate()){assert.ok(Date.now()-start<ms,`live condition timeout after ${ms}ms`);await pause(5);}}
async function bounded<T>(promise:Promise<T>,ms:number,label:string){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer!);}}
async function connect(room:Room,name:string,identity:string){const token=new AccessToken('devkey','secret',{identity,ttl:600});token.addGrant({roomJoin:true,room:name,canPublish:true,canSubscribe:true,canPublishData:true});await room.connect(endpoint,await token.toJwt(),{autoSubscribe:true,dynacast:false});}
after(()=>{if(enabled)dispose();});

test('live local publication departure releases refresh and preserves snapshots', {skip:!enabled,timeout:1200000},async()=>{
  const samples:Record<string,unknown>[]=[];
  for(const scenario of ['close-refresh','desktop-reply-refresh','rollback-restart-refresh']){
    for(let iteration=0;iteration<Number(process.env.PUB504_ITERATIONS??30);iteration++){
      const request_id=`pub504-${scenario}-${iteration}`,name=`${request_id}-${Date.now()}`,gateway=createGatewayRoom(),old=createGatewayRoom(),next=createGatewayRoom(),unknown=createGatewayRoom();
      const errors:unknown[]=[],received:{operation:string;processed_event_id?:string}[]=[],sdk:string[]=[],barrier=deferred(),entered=deferred();
      let armed=false,auths=0,sink:CallSink|undefined,callbacks=0,watchers_completed=0,setupSettled=false;
      const device={principal_id:'local-owner',device_id:'mac',device_type:'mac',capabilities:MAC_CAPABILITIES};
      const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{auths++;if(armed){armed=false;entered.resolve();await barrier.promise;}return device;},
        watchCare:async(_device:unknown,deliver:(id:string,text:string)=>Promise<unknown>)=>{callbacks++;void Promise.all([deliver('snapshot-one','local snapshot one'),deliver('snapshot-two','local snapshot two')]).catch(error=>errors.push(error));watchers_completed++;return()=>{};},
        watchAmbientTurns:async()=>()=>{},terminalChanged:()=>{},replyPrivacy:async()=>({}),callTranscript:async()=>{},
        formalVoice:async(_source:unknown,_kind:unknown,work:()=>Promise<unknown>)=>work()};
      const wire=createTerminalWire({pool:{query:async()=>({rows:[{device_id:'mac',device_class:'mac',user_id:'local-owner',status:'active',paired_at:'2026-10-15T00:00:00.000Z',recipient_public_key:'local',device_credential_ref:{},media:['data'],governance:{terminal_capabilities:MAC_CAPABILITIES}}]})} as never,
        relay:{paused:()=>false,pause:async()=>{},revoked:()=>{},watch:()=>()=>{}},onError:error=>errors.push(error)});
      const call=createVoiceCallSession({room:()=>gateway as never,greeting:{enabled:false},vision:false,expressive:false,
        createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{}}),
        onState:(...args)=>{void sink?.state(...args);},onTranscript:(...args)=>sink?.transcript(...args),onTurn:turn=>sink?.turn(turn),onError:error=>errors.push(error)});
      const participant={roomPort:gateway,disconnect:async()=>{await gateway.disconnect();}};
      const voice={...call,attach:(value:CallSink)=>{sink=value;return()=>{sink=undefined;};}};
      let bridge:ReturnType<typeof createFormalTextIngress>|undefined;
      const make=()=>createFormalTextIngress({participant:participant as never,runtime:runtime as never,authority:{credentialForBootstrap:()=>({request_id})} as never,
        extensions:[wire.extension],voice_call:voice,max_packet_bytes:12288,onError:error=>errors.push(error)});
      const input={request:{request_id},enabledMedia:{data:true,audio:true,video:false},currentBinding:{credentialIdentity:'terminal',continuityId:request_id}} as never;
      try{
        await connect(gateway,name,'gateway');await connect(old,name,'terminal');await until(()=>gateway.remoteParticipants.size===1);
        // Every actual SDK callback is observed, rather than replacing its promise.
        for(const method of ['publishData','sendText'] as const){const original=gateway.localParticipant![method].bind(gateway.localParticipant);(gateway.localParticipant as any)[method]=async(...args:unknown[])=>{sdk.push(`${method}:start`);try{const value=await (original as any)(...args);sdk.push(`${method}:settled`);return value;}catch(error){sdk.push(`${method}:rejected`);throw error;}};}
        let oldReplies=0;old.on(RoomEvent.DataReceived,(bytes,_sender,_kind,topic)=>{if(topic===FORMAL_TEXT_OUTPUT_TOPIC&&JSON.parse(Buffer.from(bytes).toString()).operation==='ambient_reply')oldReplies++;});
        bridge=make();await bridge.onBootstrapConnected(input);await until(()=>oldReplies===2);
        if(scenario==='close-refresh'){await call.open('local-call');await old.localParticipant!.publishData(Buffer.from(JSON.stringify({operation:'call_close',call_id:'local-call'})),{reliable:true,topic:FORMAL_TEXT_INPUT_TOPIC});await until(()=>!call.pending());}
        if(scenario==='rollback-restart-refresh'){await bridge.close();bridge=make();}
        // Setup authenticate is first. The next auth belongs to a real queued publication.
        const original=runtime.authenticate;let first=true;runtime.authenticate=async()=>{if(first){first=false;const value=await original();armed=true;return value;}return original();};
        const start=Date.now(),setup=bridge.onBootstrapConnected(input).then(()=>{setupSettled=true;});
        await entered.promise;
        const departure=deferred();gateway.once(RoomEvent.ParticipantDisconnected,()=>departure.resolve());await old.disconnect();await departure.promise;
        const releasedAt=Date.now();console.info('PUB504_LIVE_STAGE',JSON.stringify({request_id,stage:'old-peer-departed-during-queued-auth',watchers_completed,auths,sdk:[...sdk]}));barrier.resolve();
        // The new terminal cannot join until refresh returns its credential (Swift ordering).
        await bounded(setup,Number(process.env.PUB504_REFRESH_MS??4500),`REFRESH_BLOCKED:${request_id}:auth=${auths}:sdk=${sdk.join(',')}`);
        assert.ok(setupSettled);const refresh_ms=Date.now()-start,refresh_after_departure_ms=Date.now()-releasedAt;assert.ok(refresh_ms<5000);console.info('PUB504_LIVE_REFRESH',JSON.stringify({request_id,scenario,iteration,refresh_ms,refresh_after_departure_ms,watchers_completed,stage:'refresh-complete-before-replacement-join'}));
        next.on(RoomEvent.DataReceived,(bytes,_sender,_kind,topic)=>{if(topic===FORMAL_TEXT_OUTPUT_TOPIC)received.push(JSON.parse(Buffer.from(bytes).toString()));});
        next.registerTextStreamHandler(FORMAL_TEXT_OUTPUT_TOPIC,async reader=>{received.push(JSON.parse(await reader.readAll()));});
        await connect(next,name,'terminal');await until(()=>received.some(row=>row.operation==='ready'));
        await until(()=>received.filter(row=>row.operation==='ambient_reply').length===2);
        const ready=received.findIndex(row=>row.operation==='ready');assert.equal(ready,2,'setup snapshots precede ready');
        assert.deepEqual(received.slice(0,ready).map(row=>row.processed_event_id).sort(),['snapshot-one','snapshot-two']);
        await until(()=>received.some(row=>row.operation==='terminals'));
        await connect(unknown,name,'unknown');const before=received.length;
        await unknown.localParticipant!.publishData(Buffer.from(JSON.stringify({operation:'call_close',call_id:'unknown-call'})),{reliable:true,topic:FORMAL_TEXT_INPUT_TOPIC});await pause(25);assert.equal(received.length,before,'unknown sender is ignored');
        assert.equal(callbacks,2,'snapshot watcher is registered once per setup');
        assert.ok(sdk.includes('sendText:settled'));assert.equal(sdk.filter(value=>value.endsWith(':rejected')).length,0);
        const sample={request_id,scenario,iteration,refresh_ms,refresh_after_departure_ms,watchers_completed,auths,sdk,received:received.map(row=>row.operation),errors:errors.map(String)};samples.push(sample);console.info('PUB504_LIVE_SAMPLE',JSON.stringify(sample));
      }finally{
        barrier.resolve();await next.disconnect();await old.disconnect();await unknown.disconnect();
        await bridge?.close();await call.closeAll();wire.close();await gateway.disconnect();
      }
    }
  }
  console.info('PUB504_LIVE_RESULT',JSON.stringify({scope:'real-loopback-rtc-real-ingress-call-terminal-synthetic-business-ports',samples}));
});
