// Headless Swift DesktopSessionTransport/ToolHost against the production relay over a local SFU.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile,open} from 'node:fs/promises';
import {watch,type FSWatcher} from 'node:fs';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {Room,RoomEvent,dispose} from '@livekit/rtc-node';
import {AccessToken} from 'livekit-server-sdk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createDesktopRelay,desktopConfiguration} from '../src/desktop-relay.ts';
import {createDesktopFiles} from '../src/desktop-files.ts';
import {LIVEKIT_KEY_PROVIDER_DEFAULTS} from '../src/realtime-public-control-persistent-e2ee-owner.ts';
import {createPersonalAIOSServer} from '../../../services/personal-aios-integration/src/server.ts';
import {MAC_CAPABILITIES,type RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {createRealtimePublicControlSelfHostedCloudProjection} from '../src/realtime-public-control-self-hosted-cloud-projection.ts';
import {projectRealtimeExternalAliases} from '../src/realtime-public-control-external-alias.ts';

const [binary,bundle,directory]=process.argv.slice(2),root=resolve(directory!);
const early=process.argv.includes('--early');
await mkdir(root,{recursive:true});
const deviceID='00000000-0000-4000-8000-000000000019',key=randomBytes(32),internalToken=randomUUID();
const now=Date.now(),at=new Date(now).toISOString(),session={ref_type:'RealtimeSession',ref_id:randomUUID()},lease={ref_type:'DeviceLease',ref_id:randomUUID()};
const binding={realtimeSessionRef:session,deviceLeaseRef:lease,continuityId:'sfu-continuity',connectionEpoch:'1',
  transportSessionAlias:`transport-${randomUUID()}`,roomAlias:`room-${randomUUID()}`,deviceAlias:`device-${randomUUID()}`,provider:'livekit-cloud',connectionId:'sfu-connection'};
const governance={policy_decision_ref:{ref_type:'PolicyDecision',ref_id:'sfu-policy'}};
const owner={userId:'sfu-owner',deviceId:deviceID,purpose:'desktop-sfu',capabilities:['data'],occurredAt:at};
const cloud=createRealtimePublicControlSelfHostedCloudProjection({livekitUrl:'wss://sfu.invalid',now:()=>now});
const projected=await cloud.bootstrap({owner,governance,
  request:{...owner,requestId:'sfu-bootstrap',idempotencyKey:'sfu-bootstrap',mode:'initial',governance},
  projection:{operation:'bootstrap',binding,continuityExpiresAt:new Date(now+1800000).toISOString(),leaseExpiresAt:new Date(now+1200000).toISOString(),
    receipt:{kind:'realtime_terminal_receipt',operation:'bootstrap',status:'success',requestId:'sfu-bootstrap',idempotencyKey:'sfu-bootstrap',
      realtimeSessionRef:session,deviceLeaseRef:lease,continuityId:binding.continuityId,connectionEpoch:'1',leaseVersion:'1',outcome:'accepted',recordedAt:at,replayed:false}}} as never);
const roomName=projected.terminalRoomName,gatewayIdentity=projected.gateway.identity,macIdentity=projected.terminalIdentity,url='ws://127.0.0.1:17880';
// Bootstrap exposes opaque transport aliases; the signed token joins the separately projected SFU room.
const roomAlias=projectRealtimeExternalAliases(binding).find(alias=>alias.alias_type==='room')!.value;
assert.notEqual(roomName,roomAlias);
const token=async(identity:string)=>{
  const t=new AccessToken('devkey','secret',{identity,ttl:'5m'});
  t.addGrant({roomJoin:true,room:roomName,canPublish:true,canSubscribe:true,canPublishData:true});return t.toJwt();
};
const sfuLog=await open(join(root,'sfu.log'),'w');
const sfu=spawn(resolve(binary!),['--dev','--bind','127.0.0.1','--node-ip','127.0.0.1','--config-body','port: 17880\nrtc:\n  tcp_port: 17881\n  udp_port: 17882'],{stdio:['ignore','ignore','pipe']});
const stopSFU=()=>{sfu.kill('SIGTERM');};process.once('exit',stopSFU);
// Server readiness is a log event; no retry or polling loop participates in the handshake.
await new Promise<void>((done,reject)=>{
  sfu.stderr!.on('data',chunk=>{void sfuLog.write(chunk);if(String(chunk).includes('starting LiveKit server'))done();});
  sfu.on('error',reject);sfu.on('exit',code=>reject(new Error(`SFU exited ${code}`)));
});
const room=new Room(),config=desktopConfiguration({})!;
const source:RegisteredDevice={principal_id:'sfu-owner',device_id:deviceID,device_type:'mac',capabilities:MAC_CAPABILITIES,
  channel:'rtc_typed_text',route_version:'sfu-test',output_modes:['text'],consent_ref:'sfu-consent'};
const pool={query:async()=>({rows:[{device_id:deviceID,user_id:source.principal_id,device_class:'mac',status:'active',
  paired_at:'2026-10-19T00:00:00Z',label:'sfu',recipient_public_key:'fixture',device_credential_ref:{},media:['data'],governance:{terminal_capabilities:MAC_CAPABILITIES}}]})};
const ready=Promise.withResolvers<void>(),errors:unknown[]=[];
const runtime={terminals:()=>[source],desktopReady:async()=>{console.log('sfu relay initialized and manifest verified');ready.resolve();}};
const http={internal_token:internalToken,max_request_bytes:1048576,request_timeout_ms:10000};
const files=await createDesktopFiles({...config.files,inbox:join(root,'inbox'),workshop:join(root,'workshop'),onError:error=>errors.push(error)});
const relay=(await createDesktopRelay({config:{},runtime,http,pool:pool as never,sources:{revalidate:async()=>source},files,
  analyzeVision:async()=>assert.fail('unexpected vision call'),onError:error=>{errors.push(error);console.error('relay error',error);}}))!;
const server=createPersonalAIOSServer(runtime as never,http),client=new Client({name:'sfu-exam',version:'1'});
let swift:ReturnType<typeof spawn>|undefined;
let connected:FSWatcher|undefined;
try {
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  await room.connect(url,await token(gatewayIdentity),{autoSubscribe:false,encryption:{encryptionType:1,keyProviderOptions:{...LIVEKIT_KEY_PROVIDER_DEFAULTS,sharedKey:key}}});
  const configPath=join(root,'config.json');
  await writeFile(configPath,JSON.stringify({url,token:await token(macIdentity),key:key.toString('base64'),gatewayIdentity,root,roomName:roomAlias}),{mode:0o600});
  const attach=()=>{
    relay.extensions.forEach(extension=>extension.attach?.({device:source,room:room as never,identity:macIdentity,
      current:()=>room.isConnected,leave:()=>room.disconnect(),publish:async()=>{}}));
  };
  if(early)room.on(RoomEvent.ParticipantConnected,participant=>{if(participant.identity===macIdentity)attach();});
  else {
    connected=watch(root,(_event,file)=>{if(file==='connected'){connected!.close();attach();}});
  }
  swift=spawn('/usr/bin/xcrun',['xctest','-XCTest','DesktopReconnectTests/testRealSFUDesktopHandshake',resolve(bundle!)],{
    env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,PAIOS_DESKTOP_SFU_CONFIG:configPath},stdio:'inherit'});
  const swiftExit=once(swift,'exit');
  await Promise.race([ready.promise,swiftExit.then(([code])=>{throw new Error(`Swift exited before relay ready (${code})`);})]);
  const address=server.address();assert(address&&typeof address!=='string');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/internal/desktop/mcp`),{requestInit:{headers:{authorization:`Bearer ${internalToken}`}}}));
  const result=await client.callTool({name:'list_allowed_directories',arguments:{}});
  assert.notEqual(result.isError,true);assert.deepEqual(result.structuredContent,{directories:[]});
  console.log('sfu native list_allowed_directories round trip passed');
  await relay.pause(source.principal_id,deviceID,true);
  const [code]=await swiftExit;assert.equal(code,0);assert.deepEqual(errors,[]);
} finally {
  connected?.close();
  if(swift&&swift.exitCode===null)swift.kill('SIGTERM');
  await client.close();await relay.close();await room.disconnect();await server.closeAndDrain();
  stopSFU();await once(sfu,'close');process.off('exit',stopSFU);await sfuLog.close();await dispose();
}
