import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/src/runtime.ts';
import {readActivePairedDevices} from './paired-device-authority.ts';
import {revokePairedDevice} from './paired-device-registration.ts';
import type {JsonRecord,RealtimeBearerContext} from './realtime-public-control-runtime.ts';

export interface MacRelayConfiguration {
  server_addr:string;server_port:number;token:string;admin_port:number;admin_password:string;
  visitor_port_start:number;visitor_port_end:number;
}
interface Binding {device_id:string;user_id:string;ssh_user:string;home:string;host_public_key:string;visitor_port:number;proxy_name:string;secret_key:string}
const read=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8')) as T;
const text=(value:unknown):value is string=>typeof value==='string'&&!/[\x00-\x1f\x7f]/u.test(value);
const key=(value:unknown):value is string=>text(value)&&/^ssh-ed25519 [A-Za-z0-9+/]{68}$/u.test(value)&&
  Buffer.from(value.slice(12),'base64').subarray(0,19).equals(Buffer.from('0000000b7373682d6564323535313900000020','hex'));
const q=JSON.stringify;
/** Pairing owns identity; this directory contains only that pairing's SSH and relay material. */
export function createOwnerMacSsh(options:{pool:Parameters<typeof revokePairedDevice>[0]['pool'];root:string;relay:MacRelayConfiguration;
  paused:(deviceId:string)=>boolean|undefined;reload?:()=>Promise<void>}) {
  const {root,relay}=options;
  const path=(device:string)=>join(root,device);
  const put=(file:string,value:string)=>{writeFileSync(file+'.next',value,{mode:0o600});renameSync(file+'.next',file);};
  const reload=options.reload??(async()=>{
    const response=await fetch(`http://127.0.0.1:${relay.admin_port}/api/reload`,{method:'GET',
      headers:{authorization:'Basic '+Buffer.from('paios:'+relay.admin_password).toString('base64')},signal:AbortSignal.timeout(10000)});
    check(response.ok,'OWNER_MAC_RELAY_RELOAD_FAILED',503);
  });
  const locked=async<T>(run:(client:Parameters<typeof readActivePairedDevices>[0])=>Promise<T>):Promise<T>=>{
    const client=await options.pool.connect();
    try {await client.query("SELECT pg_advisory_lock(hashtext('paios.owner-mac-ssh'))");return await run(client);}
    finally {try{await client.query("SELECT pg_advisory_unlock(hashtext('paios.owner-mac-ssh'))");}finally{client.release();}}
  };
  const provision=async(bearer:RealtimeBearerContext,input:JsonRecord)=>locked(async(client)=>{
    check(Object.keys(input).sort().join(',')==='device_id,home,host_public_key,ssh_user'&&
      input.device_id===bearer.deviceId&&text(input.ssh_user)&&/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(input.ssh_user)&&
      text(input.home)&&input.home.startsWith('/')&&key(input.host_public_key),'OWNER_MAC_PROVISION_INVALID',422);
    const device=(await readActivePairedDevices(client)).find(row=>row.deviceId===bearer.deviceId&&row.userId===bearer.principal&&row.deviceType==='mac');
    check(device,'OWNER_MAC_PAIRING_REQUIRED',403);
    const directory=path(device.deviceId),bindingFile=join(directory,'binding.json');
    mkdirSync(directory,{mode:0o700,recursive:true});
    let binding:Binding;
    if(existsSync(bindingFile)){
      binding=read<Binding>(bindingFile);
      check(binding.host_public_key===input.host_public_key&&binding.ssh_user===input.ssh_user&&binding.home===input.home,
        'OWNER_MAC_BINDING_CHANGED_REPAIR_REQUIRED',409);
    }else{
      const used=new Set(readdirSync(root).filter(name=>existsSync(join(root,name,'binding.json')))
        .map(name=>read<Binding>(join(root,name,'binding.json')).visitor_port));
      let port=relay.visitor_port_start;while(used.has(port)&&port<=relay.visitor_port_end)port++;
      check(port<=relay.visitor_port_end,'OWNER_MAC_PORTS_EXHAUSTED',503);
      execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C',`owner-mac-${device.deviceId}`,'-f',join(directory,'client_key')]);
      binding={device_id:device.deviceId,user_id:device.userId,ssh_user:input.ssh_user as string,home:input.home as string,
        host_public_key:input.host_public_key as string,visitor_port:port,proxy_name:`owner-mac-${device.deviceId}`,secret_key:randomBytes(32).toString('base64url')};
      put(join(directory,'known_hosts'),`owner-mac-${device.deviceId} ${binding.host_public_key}\n`);
      put(bindingFile,JSON.stringify(binding)+'\n');
    }
    const paused=options.paused(device.deviceId)===true;
    const visitor=join(root,'visitors',device.deviceId+'.toml');
    const config=`[[visitors]]\nname = ${q(binding.proxy_name+'-visitor')}\ntype = "stcp"\nserverName = ${q(binding.proxy_name)}\nsecretKey = ${q(binding.secret_key)}\nbindAddr = "127.0.0.1"\nbindPort = ${binding.visitor_port}\n`;
    if(paused){if(existsSync(visitor))rmSync(visitor);}
    else if(!existsSync(visitor)||readFileSync(visitor,'utf8')!==config)put(visitor,config);
    await reload();
    return {schema:'paios.owner-mac-ssh.v1',device_id:device.deviceId,paused,
      authorized_key:readFileSync(join(directory,'client_key.pub'),'utf8').trim(),
      relay:{server_addr:relay.server_addr,server_port:relay.server_port,token:relay.token,proxy_name:binding.proxy_name,secret_key:binding.secret_key}};
  });
  const remove=async(deviceId:string,revoke:boolean)=>locked(async()=>{
    const directory=path(deviceId),visitor=join(root,'visitors',deviceId+'.toml');
    if(existsSync(visitor))rmSync(visitor);
    if(revoke)rmSync(directory,{recursive:true,force:true});
    await reload();
  });
  return {
    provision,
    control:async(bearer:RealtimeBearerContext,input:JsonRecord,revoke:boolean)=>{
      check(Object.keys(input).join(',')==='device_id'&&input.device_id===bearer.deviceId,'OWNER_MAC_PROVISION_INVALID',422);
      const device=(await readActivePairedDevices(options.pool)).find(row=>row.deviceId===bearer.deviceId&&row.userId===bearer.principal&&row.deviceType==='mac');
      check(device,'OWNER_MAC_PAIRING_REQUIRED',403);
      if(revoke)await revokePairedDevice({pool:options.pool,deviceId:device.deviceId,ownerUserId:device.userId});
      await remove(device.deviceId,revoke);return {device_id:device.deviceId};
    },
    revoked:(deviceId:string)=>remove(deviceId,true),
    resolve:async(runtime:Pick<PersonalAIOSRuntime,'scheduleContext'>,input:JsonRecord)=>{
      check(Object.keys(input).every(k=>k==='_context'||k==='device_id')&&input._context&&typeof input._context==='object'&&
        (input.device_id===undefined||typeof input.device_id==='string'),'OWNER_MAC_CONTEXT_REQUIRED',403);
      const owner=await runtime.scheduleContext(input._context as Parameters<PersonalAIOSRuntime['scheduleContext']>[0]);
      check(owner.allow_owner_mutation===true,'OWNER_MAC_OWNER_REQUIRED',403);
      const devices=(await readActivePairedDevices(options.pool)).filter(row=>row.userId===owner.principal_id&&row.deviceType==='mac'&&
        (input.device_id===undefined||row.deviceId===input.device_id));
      check(devices.length===1,'OWNER_MAC_SELECTION_REQUIRED',409);
      const device=devices[0]!;
      check(options.paused(device.deviceId)!==true&&existsSync(join(root,'visitors',device.deviceId+'.toml')),'OWNER_MAC_UNAVAILABLE',409);
      const binding=read<Binding>(join(path(device.deviceId),'binding.json'));
      return {device_id:binding.device_id,ssh_user:binding.ssh_user,home:binding.home,visitor_port:binding.visitor_port};
    },
  };
}
