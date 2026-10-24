import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerMacSsh} from '../src/owner-mac-ssh.ts';
import {RealtimePublicControlController} from '../src/realtime-public-control-controller.ts';
import {createPersonalAIOSServer} from '../../../services/personal-aios-integration/src/server.ts';

test('paired Mac HTTP provisioning pins identity; owner tools, pause and revoke use the same authority',async t=>{
  const root=mkdtempSync(join(tmpdir(),'owner-mac-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'visitors'));
  const device='a9f5b6f2-85ee-4bd0-ad38-2a7b843e0d91',other='9f6d83f9-231e-44a1-9f77-0251f99cb365';
  let active=true,paused=false,reloads=0,reloadFails=false;
  const query=async(sql:string)=>{if(sql.startsWith('WITH revoked AS')){active=false;return {rows:[{device_id:device}]};}return {rows:sql.includes("FROM paired_devices WHERE status = 'active'")&&active?[{
    device_id:device,user_id:'owner',device_class:'mac',recipient_public_key:'key',device_credential_ref:{},media:['data'],
    governance:{terminal_capabilities:['desktop_tools']},paired_at:'2026-10-19T00:00:00Z'}]:[]};};
  let borrowed=false;
  const ownerMac=createOwnerMacSsh({pool:{query:(sql:string)=>{assert.equal(borrowed,false,'provisioning must not borrow a second pooled connection');return query(sql);},
    connect:async()=>{borrowed=true;return {query,release(){borrowed=false;}};}} as never,root,
    relay:{server_addr:'relay.example.test',server_port:443,token:'test-relay-token',admin_port:18665,admin_password:'test-admin',visitor_port_start:22000,visitor_port_end:22010},
    paused:()=>paused,reload:async()=>{reloads++;if(reloadFails)throw new Error('reload failed');}});
  execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(root,'host')]);
  const host=readFileSync(join(root,'host.pub'),'utf8').split(/\s+/).slice(0,2).join(' ');
  const controller=new RealtimePublicControlController({enabled:true,controlHost:'example.test',ownerMac,
    runtime:Object.fromEntries(['bootstrap','resolveE2eeKey','refresh','stop','endContinuity','close'].map(k=>[k,async()=>{}])) as never,
    schemaRegistry:{} as never,edge:{authorize:async()=>{}},
    bearer:{authorize:async({token})=>{assert.equal(token,'paired-bearer-token-123456');return {deviceId:device,principal:'owner'};}}});
  const server=createServer((req,res)=>{void controller.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post=async(action:string,body:unknown)=>{
    const response=await fetch(url+'/v1/mac/ssh/'+action,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer paired-bearer-token-123456'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  };
  const input={device_id:device,home:'/Users/owner',ssh_user:'owner',host_public_key:host};
  assert.equal((await post('provision',{...input,device_id:other})).status,422);
  assert.equal((await post('provision',{...input,host_public_key:'not a host key'})).status,422);
  const first=await post('provision',input);assert.equal(first.status,200);assert.equal(first.body.paused,false);
  assert.match(String(first.body.authorized_key),/^ssh-ed25519 /);
  assert.equal(statSync(join(root,device,'client_key')).mode&0o777,0o600);
  assert.equal(readFileSync(join(root,device,'known_hosts'),'utf8'),`owner-mac-${device} ${host}\n`);
  assert.deepEqual(await post('provision',input),first,'renewal never rotates a paired client key');
  assert.equal((await post('provision',{...input,home:'/Users/somebody-else'})).status,409);
  const context={run_id:'run',session_id:'session',tool_call_id:'tool'};
  let owner=true;
  const runtime={scheduleContext:async(value:unknown)=>{assert.deepEqual(value,context);return {principal_id:'owner',allow_owner_mutation:owner};}};
  assert.equal((await ownerMac.resolve(runtime as never,{_context:context})).device_id,device);
  owner=false;await assert.rejects(ownerMac.resolve(runtime as never,{_context:context}),/OWNER_MAC_OWNER_REQUIRED/);owner=true;
  await assert.rejects(ownerMac.resolve(runtime as never,{_context:context,device_id:other}),/OWNER_MAC_SELECTION_REQUIRED/);
  const internal=createPersonalAIOSServer(runtime as never,{internal_token:'a'.repeat(32),max_request_bytes:8192,request_timeout_ms:10000,ownerMac:ownerMac.resolve});
  await new Promise<void>(resolve=>internal.listen(0,'127.0.0.1',resolve));t.after(()=>internal.closeAndDrain());
  const internalUrl=`http://127.0.0.1:${(internal.address() as {port:number}).port}/internal/owner-mac/resolve`;
  const resolveHttp=(token:string)=>fetch(internalUrl,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({_context:context})});
  assert.equal((await resolveHttp('bad')).status,401);assert.equal((await resolveHttp('a'.repeat(32))).status,200);
  paused=true;assert.equal((await post('provision',input)).body.paused,true);
  await assert.rejects(ownerMac.resolve(runtime as never,{_context:context}),/OWNER_MAC_UNAVAILABLE/);
  assert.ok(!existsSync(join(root,'visitors',device+'.toml')));
  paused=false;reloadFails=true;assert.equal((await post('provision',input)).status,503);
  reloadFails=false;assert.equal((await post('provision',input)).status,200,'a failed reload remains visible and the next renewal reloads again');
  assert.equal((await post('pause',{device_id:device})).status,200);
  await assert.rejects(ownerMac.resolve(runtime as never,{_context:context}),/OWNER_MAC_UNAVAILABLE/);
  await post('provision',input);assert.equal((await post('revoke',{device_id:device})).status,200);
  assert.ok(!existsSync(join(root,device)),'REST unpair removes credentials without desktop MCP');
  await assert.rejects(ownerMac.resolve(runtime as never,{_context:context}),/OWNER_MAC_SELECTION_REQUIRED/);
  assert.equal((await post('provision',input)).status,403);
  active=true;await post('provision',input);reloadFails=true;
  assert.equal((await post('revoke',{device_id:device})).status,503,'relay failure is still reported');
  assert.equal(active,false,'relay failure cannot prevent the authoritative pairing revocation');
  assert.ok(!existsSync(join(root,device)));reloadFails=false;
  await ownerMac.revoked(device);assert.ok(!existsSync(join(root,device)));assert.ok(reloads>=7);
});
