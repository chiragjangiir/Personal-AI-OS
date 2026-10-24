import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import assert from 'node:assert/strict';
import {canonical} from '../../../services/personal-aios-integration/src/contracts.ts';
import test from 'node:test';
import {createServer} from 'node:http';
import {assertAppleEnrollmentOwnerProtectedPath} from '../src/apple-production-enrollment-owner.ts';
import {existsSync} from 'node:fs';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readdirSync} from 'node:fs';
import {createPostgresPool} from '../../../services/platform-data/src/postgres-pool.ts';
import {createProductionRealtimeIdentityPort} from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import {assertCanonicalTimestamp} from '../../../services/realtime-core/src/types.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {createHash} from 'node:crypto';
import * as candidate from '../src/rayneo-persistent-production-entrypoint.ts';
import {PERSISTENT_PUBLIC_SECRET_REFERENCES} from '../src/realtime-public-control-persistent-public-ports.ts';
import {pairDevice} from '../src/paired-device-registration.ts';
const entry:typeof candidate=candidate;
import {makeMacProductResourceFixture as fixture,now} from './mac-product-resource-fixture.ts';
const at=(n:number)=>new Date(n).toISOString();

test('real selected product handoff consumes same qualified POSIX config without legacy reads; allocation failure closes pool',async()=>{
 const f=fixture();let closed=0,ownerReached=0;
 try{
  await assert.rejects(entry.createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',central:{} as never,inputReadiness:{owner:'controlled-native-no-model',isReady:()=>true},product_resources:f.config}, {
   createPool:options=>{assert.ok(options);assert.equal(options.port,55439);assert.equal(options.user,'l3test');return {end:async()=>{closed++;}} as never;},inspectPostgres:async()=>true,
   createPublicOwner:async input=>{ownerReached++;const r=input.productResources!;assert.equal('t03Record' in r,false);
    const lease=await r.resolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey);assert.ok(lease.read);assert.equal(lease.read().length,43);assert.ok(lease.release);lease.release();
    throw new Error('CONTROLLED_OWNER_ALLOCATION_FAILURE');},
  }),/CONTROLLED_OWNER_ALLOCATION_FAILURE/);
  assert.equal(ownerReached,1);assert.equal(closed,1);
 }finally{f.cleanup();}
});

test('original file permission owner rejects public mode/symlink/missing file and original resolver rejects malformed key',async()=>{
 const f=fixture();try{
  assertAppleEnrollmentOwnerProtectedPath(f.root,'directory');assert.throws(()=>assertAppleEnrollmentOwnerProtectedPath(f.root));
  chmodSync(f.root,0o600);assert.throws(()=>assertAppleEnrollmentOwnerProtectedPath(f.root,'directory'));chmodSync(f.root,0o700);
  assert.throws(()=>assertAppleEnrollmentOwnerProtectedPath(f.config.e2ee_file,'directory'));
  chmodSync(f.config.proxy_file,0o644);assert.throws(()=>candidate.createConfiguredProductResources(f.config));chmodSync(f.config.proxy_file,0o600);
  const original=readFileSync(f.config.proxy_file);rmSync(f.config.proxy_file);symlinkSync(f.config.e2ee_file,f.config.proxy_file);assert.throws(()=>candidate.createConfiguredProductResources(f.config));rmSync(f.config.proxy_file);writeFileSync(f.config.proxy_file,original,{mode:0o600});
  writeFileSync(f.config.livekit_key_file,'bad');assert.throws(()=>candidate.createConfiguredProductResources(f.config),/PERSISTENT_LIVEKIT_CREDENTIAL_INVALID/);
  writeFileSync(f.config.livekit_key_file,'A'.repeat(24));const r=candidate.createConfiguredProductResources(f.config);
  chmodSync(f.config.owner_policy_file,0o644);assert.equal(r.ownerProtection.isOwnerProtected(f.config.owner_policy_file),false);
  assert.throws(()=>r.ownerProtection.assertOwnerProtected('/unknown/private-file'));
  const uid=process.getuid!;try{process.getuid=()=>uid()+1;assert.equal(r.ownerProtection.isOwnerProtected(f.config.e2ee_file),false);}finally{process.getuid=uid;}
  rmSync(f.config.e2ee_file);assert.equal(r.ownerProtection.isOwnerProtected(f.config.e2ee_file),false);
 }finally{f.cleanup();}
});

// Only the approved local isolated test instance; never production business PG.
test('real POSIX resources and unique isolated PG product construction/start/close; native is controlled no-model', {skip:process.env.MAC_PRODUCT_ISOLATED_PG!=='1'},async()=>{
 const f=fixture(),name='mac_product_'+randomUUID().replaceAll('-','');
 const admin=createPostgresPool({host:'127.0.0.1',port:55439,database:'postgres',user:'l3test',max:1});
 let pool:ReturnType<typeof createPostgresPool>|undefined,handoff:Awaited<ReturnType<typeof candidate.createRayneoPersistentProductionHandoff>>|undefined;
 let handle:Awaited<ReturnType<typeof candidate.startRayneoPersistentProduction>>|undefined;
 let configured:Awaited<ReturnType<typeof candidate.startConfiguredHermesProduct>>|undefined;
 const nativeServer=createServer((req,res)=>{assert.equal(req.url,'/health/detailed');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({platform:'hermes-agent',readiness:{checks:{gateway:{state:'running'},session_store:{status:'ok'},model:{status:'ok'}}}}));});
 await new Promise<void>(resolve=>nativeServer.listen(0,'127.0.0.1',resolve));const nativeAddress=nativeServer.address();assert.ok(nativeAddress&&typeof nativeAddress!=='string');
 try {
  await admin.query('CREATE DATABASE '+name);
  pool=createPostgresPool({host:'127.0.0.1',port:55439,database:name,user:'l3test',max:2});
  const migrations=new URL('../../../migrations/',import.meta.url);
  for(const file of readdirSync(migrations).filter(file=>file.endsWith('.up.sql')).sort())await pool.query(readFileSync(new URL(file,migrations),'utf8'));
  const r=candidate.createConfiguredProductResources({...f.config,postgres:{...f.config.postgres,database:name}});
  const identity=createProductionRealtimeIdentityPort({clock:{now:()=>assertCanonicalTimestamp(at(now))}});
  const recipient=generateKeyPairSync('x25519').publicKey.export({format:'jwk'}).x!;
  const pairing=await pairDevice({pool,identity,origin:'https://api.example:9443',registration:Buffer.from(JSON.stringify({public_raw32_base64url:recipient,
    public_sha256:createHash('sha256').update(Buffer.from(recipient,'base64url')).digest('hex')}))});
  assert.equal(pairing.origin,'https://api.example:9443');assert.equal(pairing.token.length,43);assert.equal((await pool.query("SELECT count(*)::int AS n FROM realtime_sessions")).rows[0].n,0);
  handoff=await candidate.createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources:{...f.config,postgres:{...f.config.postgres,database:name}},inputReadiness:{owner:'controlled-native-not-model',isReady:()=>true},central:{
   storage:new PosixStorage(join(f.root,'storage')),native:sourceClient({create:async()=>{throw new Error('MODEL_NOT_ALLOWED');},status:async()=>{throw new Error('MODEL_NOT_ALLOWED');},cancel:async()=>{throw new Error('MODEL_NOT_ALLOWED');}}),
   admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'mac-product-controlled'},skill:'controlled-fixed-skill',max_event_bytes:8192,max_read_bytes:8192,http:{internal_token:'isolated-synthetic-internal-key-20261004',max_request_bytes:8192,request_timeout_ms:10000}}});
  handle=await candidate.startRayneoPersistentProduction(handoff.launcherInput,{executionOwner:'hermes_text',publicControl:handoff.publicControl,centralListenPort:18761});
  assert.equal(handle.port,8787);await handle.close();await handle.close();handle=undefined;handoff=undefined;
  writeFileSync(join(f.root,'native.key'),'synthetic-controlled-native-api-key-20261004',{mode:0o600});
  writeFileSync(join(f.root,'skill'),'source-owned controlled fixture: no model requests',{mode:0o600});
  const configuration:candidate.HermesProductConfiguration={executionOwner:'hermes_text',product_resources:{...f.config,postgres:{...f.config.postgres,database:name}},storage_root:join(f.root,'configured-storage'),lock_file:join(f.root,'lock'),port:18762,hermes_base_url:`http://127.0.0.1:${nativeAddress.port}`,hermes_key_file:join(f.root,'native.key'),internal_key_file:join(f.root,'native.key'),skill_file:join(f.root,'skill'),native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:16384,max_event_bytes:8192,max_read_bytes:8192,admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'mac-product-config'}};
  const configPath=join(f.root,'product.json');writeFileSync(configPath,JSON.stringify(configuration),{mode:0o600});
  chmodSync(f.config.proxy_file,0o644);await assert.rejects(candidate.startConfiguredHermesProduct(JSON.parse(readFileSync(configPath,'utf8'))),/OWNER_ACL_INVALID/);assert.equal(existsSync(configuration.lock_file),false);chmodSync(f.config.proxy_file,0o600);
  configured=await candidate.startConfiguredHermesProduct(JSON.parse(readFileSync(configPath,'utf8')));assert.equal(configured.centralPort,18762);assert.equal(existsSync(configuration.lock_file),true);await configured.close();await configured.close();configured=undefined;assert.equal(existsSync(configuration.lock_file),false);
  console.log(JSON.stringify({scope:'actual-product-constructor-listeners-private-files-isolated-PG',unique_database:name,native:'controlled-no-model',LiveKit_network:false,physical_device:false,closed:true}));
 }catch(error){console.log(JSON.stringify({product_failure:error instanceof Error?error.message:'unknown'}));throw error;}finally {
  const cleanupErrors:unknown[]=[];
  const clean=async(action:()=>unknown)=>{try{await action();}catch(error){cleanupErrors.push(error);}};
  await clean(()=>configured?.close());await clean(()=>handle?.close());
  if(handoff){await clean(()=>handoff!.publicControl.centralTextAssembly?.close());await clean(()=>handoff!.publicControl.t03?.close());await clean(()=>handoff!.publicControl.persistentPublicPorts?.close());await clean(()=>handoff!.launcherInput.pool.end());}
  await clean(()=>pool?.end());
  await clean(()=>admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)'));
  await clean(()=>admin.end());
  await clean(()=>new Promise<void>(resolve=>nativeServer.close(()=>resolve())));
  f.cleanup();
  if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'ISOLATED_PRODUCT_TEST_CLEANUP_FAILED');
 }
});

test('configured product uses portable TLS origins and owner listener binding', () => {
 const f=fixture();try {
  const r=candidate.createConfiguredProductResources({...f.config, livekit_url:'wss://rtc.example:9443', livekit_api_url:'http://127.0.0.1:7880', public_api_url:'https://api.example:9443', gateway_host:'127.0.0.1', gateway_port:18877});
  assert.equal(r.configuration.livekit_api_url,'http://127.0.0.1:7880');assert.equal(r.configuration.livekit_url,'wss://rtc.example:9443');assert.equal(r.configuration.public_api_url,'https://api.example:9443');
  assert.equal(candidate.createConfiguredProductResources({...f.config,livekit_url:'wss://rtc.example:9443'}).configuration.public_api_url,'https://rtc.example:9443');
  for(const livekit_url of ['ws://rtc.example:9443','wss://user:secret@rtc.example:9443','wss://rtc.example:9443/rtc']) assert.throws(()=>candidate.createConfiguredProductResources({...f.config,livekit_url}),/PRODUCT_LIVEKIT_URL_INVALID/);
 }finally{f.cleanup();}
});

 test('pairing rejects a non-HTTPS origin before allocating a database connection', async () => {
  let allocated=false;
  await assert.rejects(pairDevice({origin:'http://api.example:9443', registration:new Uint8Array(),
   pool:{connect:async()=>{allocated=true;throw new Error('DATABASE_MUST_NOT_BE_ALLOCATED');}} as never,
   identity:{} as never}), /DEVICE_PAIRING_ORIGIN_INVALID/);
  assert.equal(allocated,false);
 });
