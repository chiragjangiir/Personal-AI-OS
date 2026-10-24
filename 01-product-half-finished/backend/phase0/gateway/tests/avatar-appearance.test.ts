import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {createAppearanceImages} from '../src/avatar-appearance-images.ts';
import {createAppearanceWire,readAppearancePricing} from '../src/avatar-appearance-wire.ts';
import {AvatarProfileService,type AvatarProfileStore} from '../src/avatar-profile.ts';
import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {AvatarProfileRecord,AvatarCommandRecord,AvatarProfileTransaction} from '../../../services/platform-data/src/avatar-profile-repository.ts';
import type {WireAttachment,WireBody} from '../src/personal-aios-terminal-wire.ts';
class Store implements AvatarProfileStore {
  profile:AvatarProfileRecord={principal_id:'owner',version:0,active:null,active_avatar_id:null,requested_command:null};
  commands=new Map<string,AvatarCommandRecord>();
  async read(id:string){return id==='owner'?structuredClone(this.profile):null;}
  async outstanding(){return [];}
  async transact<T>(_id:string,work:(tx:AvatarProfileTransaction)=>Promise<T>){return work({profile:this.profile,
    command:async id=>this.commands.get(id)??null,saveCommand:async c=>{this.commands.set(c.command_id,c);},creationBusy:async()=>false});}
}
const phone={principal_id:'owner',device_id:'phone',device_type:'phone',consent_ref:'owner-consent',channel:'formal',capabilities:['owner_unlock'],route_version:'v1',output_modes:['text']} as WireAttachment['device'];
const quote={quote_id:'actual-price-v1',price_text:'供应商实际报价',scope_text:'一次准备；所有已配对终端和后续通话使用'};

test('real HTTP upload is paired-authenticated, owner-scoped, immutable and drives existing prepare authority',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'appearance-'));
  const images=createAppearanceImages({directory,publicOrigin:'https://assets.example',authenticate:async req=>{
    if(req.headers.authorization!=='Bearer paired'||req.headers['x-device-id']!=='phone')throw new ContractError('PAIRED_DEVICE_REQUIRED',403);
    return {principal_id:'owner',device_id:'phone'};
  }});
  const server=createServer((req,res)=>{void images.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}},()=>{res.writeHead(500);res.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    const jpeg=await sharp({create:{width:80,height:100,channels:3,background:'#abcdef'}}).jpeg().toBuffer();
    assert.equal((await fetch(origin+'/v1/appearance/images',{method:'POST',headers:{'content-type':'image/jpeg'},body:jpeg})).status,403);
    assert.equal((await fetch(origin+'/v1/appearance/images',{method:'POST',headers:{'content-type':'image/jpeg',authorization:'Bearer paired','x-device-id':'phone'},body:'not a JPEG'})).status,422);
    const response=await fetch(origin+'/v1/appearance/images',{method:'POST',headers:{'content-type':'image/jpeg',authorization:'Bearer paired','x-device-id':'phone'},body:jpeg});
    assert.equal(response.status,201);
    const look=await response.json() as {look_id:string;image_url:string;focus:{x:number;y:number}};
    assert.equal(await images.resolveLook('other-owner',look.look_id),undefined);
    assert.equal((await images.resolveLook('owner',look.look_id))?.image_url,look.image_url);
    const downloaded=await fetch(origin+new URL(look.image_url).pathname);
    assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('content-type'),'image/jpeg');
    assert.equal((await sharp(Buffer.from(await downloaded.arrayBuffer())).metadata()).width,80);
    const store=new Store();let providerURL='';
    const service=new AvatarProfileService({store,looks:[],resolveLook:images.resolveLook,assets:{create:async url=>{providerURL=url;return {id:'provider',state:'pending'};},get:async()=>({id:'provider',state:'ready'})}});
    const wire=createAppearanceWire(service,{preparationQuote:quote,photoUploadAvailable:true});
    const frames:WireBody[]=[];const publish=async(body:WireBody)=>{frames.push(body);};
    const body={request_id:'prepare',command_id:'command',look_id:look.look_id,expected_version:0,quote_id:quote.quote_id,confirmed_quote:quote,owner_request:'确认实际费用与范围',focus:{x:.2,y:.7}};
    await wire.handle('avatar_prepare',body,phone,publish);
    assert.equal(frames.at(-1)?.status,'pending');assert.equal(await service.read('owner'),null);assert.equal(providerURL,look.image_url);
    const withoutProvider=new AvatarProfileService({store,looks:[],resolveLook:images.resolveLook});
    const resumeWire=createAppearanceWire(withoutProvider,{preparationQuote:quote});
    await resumeWire.handle('avatar_options',{request_id:'restored-options'},phone,publish);
    assert.equal((frames.at(-1)?.current_preparation as {command_id:string}).command_id,'command');
    await resumeWire.handle('avatar_reconcile',{request_id:'offline-check',command_id:'command'},phone,publish);
    assert.equal(frames.at(-1)?.status,'pending');
    await withoutProvider.close();
    await resumeWire.handle('avatar_reconcile',{request_id:'closed-check',command_id:'command'},phone,publish);
    assert.equal(frames.at(-1)?.status,'pending','a service outage cannot turn a durable pending command into failed');
    await wire.handle('avatar_reconcile',{request_id:'check',command_id:'command'},phone,publish);
    assert.equal(frames.at(-1)?.status,'ready');assert.deepEqual((await service.read('owner'))?.focus,{x:.2,y:.7});
    await assert.rejects(service.change({principal_id:'owner',device_id:'phone',command_id:'invalid-focus',look_id:look.look_id,expected_version:1,owner_request:'confirmation',focus:{x:2,y:.4}}),/AVATAR_LOOK_INVALID/);
    await assert.rejects(service.change({principal_id:'other-owner',device_id:'other',command_id:'forged',look_id:look.look_id,expected_version:0,owner_request:'forged'}),/AVATAR_LOOK_UNKNOWN/);
    await assert.rejects(service.change({principal_id:'owner',device_id:'phone',command_id:'command',look_id:look.look_id,expected_version:0,owner_request:'确认实际费用与范围',focus:{x:.9,y:.7}}),/AVATAR_COMMAND_REUSED/);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});

test('prices default unavailable and stale consent cannot reach preparation on phone or Mac',async()=>{
  assert.deepEqual(readAppearancePricing(),{});
  assert.throws(()=>readAppearancePricing('{"preparationQuote":{"quote_id":"x","price_text":"","scope_text":"all"}}'),/AVATAR_QUOTE_CONFIG_INVALID/);
  const service=new AvatarProfileService({store:new Store(),looks:[]});
  const frames:WireBody[]=[];const publish=async(body:WireBody)=>{frames.push(body);};
  const disabled=createAppearanceWire(service);
  await disabled.handle('avatar_options',{request_id:'options'},phone,publish);
  assert.equal(frames.at(-1)?.preparation_quote,undefined);
  const body={request_id:'prepare',command_id:'command',look_id:'none',expected_version:0,quote_id:'stale',confirmed_quote:{...quote,price_text:'旧价格'},owner_request:'confirmation',focus:{x:.5,y:.4}};
  await disabled.handle('avatar_prepare',body,phone,publish);assert.equal(frames.at(-1)?.error,'AVATAR_PREPARATION_UNAVAILABLE');
  const wire=createAppearanceWire(service,{preparationQuote:quote});
  await wire.handle('avatar_prepare',body,phone,publish);assert.equal(frames.at(-1)?.error,'AVATAR_QUOTE_CHANGED');
  await wire.handle('avatar_prepare',{...body,quote_id:quote.quote_id},{...phone,device_type:'mac'},publish);
  assert.equal(frames.at(-1)?.error,'AVATAR_QUOTE_CHANGED');
  await wire.handle('avatar_prepare',{...body,quote_id:quote.quote_id},phone,publish);assert.equal(frames.at(-1)?.error,'AVATAR_QUOTE_CHANGED');
  const ajv=new Ajv({strict:true});addFormats.default(ajv);ajv.addFormat('paios-utc',()=>true);
  for(const schema of Object.values(wire.outputs))assert.doesNotThrow(()=>ajv.compile(schema));
});

test('Mac preparation uses the same confirmed quote authority; cancellation and ready reuse need no new generation',async()=>{
  const store=new Store();let creates=0;
  const ready={look_id:'approved',style:'原照片',image_url:'https://assets.example/approved.jpg',focus:{x:.5,y:.4},vidu_avatar_id:'approved-id'};
  const {vidu_avatar_id:_,...fresh}=ready;
  const service=new AvatarProfileService({store,looks:[ready,{...fresh,look_id:'new'}],
    assets:{create:async()=>{creates++;return{id:'preparing',state:'pending'};},get:async id=>({id,state:'ready'})}});
  const wire=createAppearanceWire(service,{preparationQuote:quote});
  const mac={...phone,device_type:'mac',device_id:'mac'} as typeof phone;
  const frames:WireBody[]=[];const publish=async(body:WireBody)=>{frames.push(body);};
  const body={request_id:'prepare',command_id:'mac-command',look_id:'approved',expected_version:0,quote_id:quote.quote_id,confirmed_quote:quote,owner_request:'确认实际费用与范围',focus:{x:.2,y:.7}};
  await wire.handle('avatar_prepare',body,mac,publish);
  assert.equal(frames.at(-1)?.status,'ready');assert.equal(frames.at(-1)?.profile_version,1);
  await wire.handle('avatar_prepare',{...body,command_id:'pending',look_id:'new',expected_version:1},mac,publish);
  assert.equal(frames.at(-1)?.status,'pending');assert.equal(creates,1);
  await wire.handle('avatar_cancel',{request_id:'cancel',command_id:'pending'},mac,publish);
  assert.equal(frames.at(-1)?.status,'cancelled');
  await wire.handle('avatar_reuse',{request_id:'reuse',command_id:'default',expected_version:1,version:0,owner_request:'恢复默认'},mac,publish);
  assert.equal(frames.at(-1)?.profile_version,2);assert.equal(frames.at(-1)?.profile,null);assert.equal(creates,1);
  await wire.handle('avatar_options',{request_id:'options'},mac,publish);
  assert.equal(frames.at(-1)?.current_version,2);
  assert.equal((frames.at(-1)?.recent_versions as unknown[]).length,2);
  await assert.rejects(wire.handle('avatar_prepare',body,{...phone,device_type:'glasses'},publish),/AVATAR_APPEARANCE_OWNER_REQUIRED/);
});
