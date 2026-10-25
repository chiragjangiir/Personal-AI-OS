// Synthetic gateway trust root for the pairing fixture.
process.env.PAIOS_GATEWAY_ROOT_SPKI_SHA256 = 'a1'.repeat(32);
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { spawnSync } from 'node:child_process';
const test=(name:string,run:()=>void)=>nodeTest(name,{skip:process.platform==='win32'?'Posix registry acceptance requires a Posix host':false},run);
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as source from '../src/rayneo-pairing-registry.ts';
import type { PairingRegistryIo, RayneoPairingRecord } from '../src/rayneo-pairing-registry.ts';
const owned:string[]=[];
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'paios-pairing-case-')));const directory=root+'/private';const path=directory+'/paired-device.v1.json';owned.push(root);return {root,directory,path};}
afterEach(()=>{for(const root of owned.splice(0))rmSync(root,{recursive:true,force:true});});
const input={installId:'rayneo_install_aaaaaaaaaaaaaaaaaaaa',deviceId:'rayneo_device_bbbbbbbbbbbbbbbbbbbb',
  keyId:'c'.repeat(64),publicKeySpkiB64url:'A'.repeat(122),pairedAtUtc:'2026-10-04T00:00:00.000Z'};
function record():RayneoPairingRecord{return {schema:'paios.rayneo.pairing.registry.v1',generation:1,state:'paired',
  install_id:input.installId,device_id:input.deviceId,key_id:input.keyId,public_key_spki_b64url:input.publicKeySpkiB64url,
  gateway_hostname:'paios-gateway.local',root_spki_sha256:'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  paired_at_utc:input.pairedAtUtc,revoked_at_utc:null,revoke_reason:null};}
function seed(f:ReturnType<typeof fixture>){mkdirSync(f.directory,{mode:0o700});writeFileSync(f.path,source.canonicalRayneoPairingRecordBytes(record()),{mode:0o600});}
function nativeIo(path:string):PairingRegistryIo{const create=(source as unknown as {createPairingRegistryIo?:(path:string)=>PairingRegistryIo}).createPairingRegistryIo;
  assert.equal(typeof create,'function','native IO factory belongs to original registry owner');return create!(path);}
test('real Posix private cold read uses exactly the supplied absolute pairing_file',()=>{const f=fixture();seed(f);
  assert.deepEqual(new source.RayneoPairingRegistry({path:f.path}).read(),record());});
test('real Posix cold write flushes canonical bytes and persists into a fresh registry',()=>{const f=fixture();
  const registry=new source.RayneoPairingRegistry({path:f.path});assert.equal(registry.read(),undefined);
  const value=registry.writePaired(input);assert.deepEqual(value,record());
  assert.equal(lstatSync(f.directory).mode&0o777,0o700);assert.equal(lstatSync(f.path).mode&0o777,0o600);
  assert.equal(lstatSync(f.path).uid,process.getuid?.());assert.deepEqual(readdirSync(f.directory),['paired-device.v1.json']);
  assert.ok(readFileSync(f.path).equals(source.canonicalRayneoPairingRecordBytes(value)));
  assert.deepEqual(new source.RayneoPairingRegistry({path:f.path}).read(),value);
  assert.throws(()=>registry.writePaired(input),/DEVICE_ALREADY_PAIRED/);});
test('real Posix revoke atomically replaces one inode and survives a cold read',()=>{const f=fixture();seed(f);
  const before=lstatSync(f.path);const r=new source.RayneoPairingRegistry({path:f.path});
  const revoked=r.revoke({deviceId:input.deviceId,keyId:input.keyId,revokedAtUtc:'2026-10-04T00:01:00.000Z'});
  assert.equal(revoked.state,'revoked');assert.equal(revoked.generation,2);assert.notEqual(lstatSync(f.path).ino,before.ino);
  assert.deepEqual(new source.RayneoPairingRegistry({path:f.path}).read(),revoked);
  assert.equal(lstatSync(f.path).mode&0o777,0o600);assert.deepEqual(readdirSync(f.directory),['paired-device.v1.json']);
  assert.throws(()=>r.writePaired(input),/PAIRING_REVOKED/);assert.throws(()=>r.revoke({deviceId:input.deviceId,keyId:input.keyId,revokedAtUtc:'2026-10-04T00:02:00.000Z'}),/PAIRING_REVOKED/);});
for(const mode of ['partial','foreign','directory-public','file-public','symlink','hardlink'] as const){
 test(`real Posix ${mode} does not become a pairing authority`,()=>{const f=fixture();seed(f);
  if(mode==='partial')writeFileSync(f.path+'.new','partial',{mode:0o600});
  if(mode==='foreign')writeFileSync(f.directory+'/other.json','foreign',{mode:0o600});
  if(mode==='directory-public')chmodSync(f.directory,0o755);
  if(mode==='file-public')chmodSync(f.path,0o644);
  if(mode==='symlink'){const target=f.root+'/target';writeFileSync(target,readFileSync(f.path),{mode:0o600});rmSync(f.path);symlinkSync(target,f.path);}
  if(mode==='hardlink')linkSync(f.path,f.root+'/second-link');
  const before=mode==='file-public'?lstatSync(f.path).mode:mode==='directory-public'?lstatSync(f.directory).mode:undefined;
  assert.throws(()=>new source.RayneoPairingRegistry({path:f.path}).read(),/PAIRING_REGISTRY_|APPLE_ENROLLMENT_OWNER_/);
  if(before!==undefined)assert.equal(lstatSync(mode==='file-public'?f.path:f.directory).mode,before,'no permission repair on preexisting path');
 });
}
test('owned pre-rename failure leaves original bytes intact and removes only created temporary',()=>{const f=fixture();seed(f);const before=readFileSync(f.path);
 const io=nativeIo(f.path);const wrapped={...io,replaceWriteThrough(){throw new Error('injected before rename');}};
 assert.throws(()=>new source.RayneoPairingRegistry({path:f.path,io:wrapped}).revoke({deviceId:input.deviceId,keyId:input.keyId,revokedAtUtc:'2026-10-04T00:01:00.000Z'}),/injected before rename/);
 assert.ok(readFileSync(f.path).equals(before));assert.deepEqual(readdirSync(f.directory),['paired-device.v1.json']);
 assert.deepEqual(new source.RayneoPairingRegistry({path:f.path}).read(),record());});
test('a flushed create fault leaves visible partial state and cannot report success',()=>{const f=fixture();const io=nativeIo(f.path);
 const wrapped={...io,createNewFlushed(path:string,bytes:Buffer){io.createNewFlushed(path,bytes);throw new Error('injected after flush');}};
 assert.throws(()=>new source.RayneoPairingRegistry({path:f.path,io:wrapped}).writePaired(input),/injected after flush/);
 assert.equal(existsSync(f.path),false);assert.equal(existsSync(f.path+'.new'),true);
 assert.throws(()=>new source.RayneoPairingRegistry({path:f.path}).read(),/PARTIAL_WRITE/);});
test('post-rename fault is reported even when the new revoked record is durably readable',()=>{const f=fixture();seed(f);const io=nativeIo(f.path);
 const wrapped={...io,replaceWriteThrough(a:string,b:string){io.replaceWriteThrough(a,b);throw new Error('injected after rename and directory flush');}};
 assert.throws(()=>new source.RayneoPairingRegistry({path:f.path,io:wrapped}).revoke({deviceId:input.deviceId,keyId:input.keyId,revokedAtUtc:'2026-10-04T00:01:00.000Z'}),/injected after rename/);
 assert.equal(new source.RayneoPairingRegistry({path:f.path}).read()?.state,'revoked');assert.equal(existsSync(f.path+'.new'),false);});
test('explicit relative and noncanonical pairing paths are rejected by the registry owner',()=>{
 assert.throws(()=>new source.RayneoPairingRegistry({path:'private/paired-device.v1.json'}),/PATH_INVALID/);
 const f=fixture();assert.throws(()=>new source.RayneoPairingRegistry({path:f.root+'/private/../private/paired-device.v1.json'}),/PATH_INVALID/);
 assert.throws(()=>new source.RayneoPairingRegistry({path:f.directory+'/another.json'}),/PATH_INVALID/);
});

test('private registry persists through a fresh Node process using the same configured path',()=>{const f=fixture();seed(f);
 const module=new URL('../src/rayneo-pairing-registry.ts',import.meta.url).href;
 const script=`import {RayneoPairingRegistry} from ${JSON.stringify(module)};console.log(JSON.stringify(new RayneoPairingRegistry({path:${JSON.stringify(f.path)}}).read()));`;
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),record());});
test('private permission owner rejects a foreign uid without changing existing data',()=>{const f=fixture();seed(f);const getuid=process.getuid!;
 try{process.getuid=()=>getuid()+1;assert.throws(()=>new source.RayneoPairingRegistry({path:f.path}).read(),/APPLE_ENROLLMENT_OWNER_ACL_INVALID/);}
 finally{process.getuid=getuid;}assert.ok(readFileSync(f.path).equals(source.canonicalRayneoPairingRecordBytes(record())));});
test('an aliased directory cannot provide a second path identity',()=>{const f=fixture();seed(f);const alias=f.root+'/alias';symlinkSync(f.directory,alias,'dir');
 assert.throws(()=>new source.RayneoPairingRegistry({path:alias+'/paired-device.v1.json'}).read(),/PAIRING_REGISTRY_NODE_INVALID/);});
test('the default constructor uses the configured Linux data root with injected existing IO',()=>{
 const seen:string[]=[];const noop=()=>undefined;const io:PairingRegistryIo={exists:(path:string)=>{seen.push(path);return false;},
   ensureDirectory:noop,list:()=>[],read:()=>Buffer.alloc(0),assertSafeDirectory:noop,assertSafeFile:noop,
   createNewFlushed:noop,applyAndVerifyProtectedAcl:noop,verifyProtectedAcl:noop,replaceWriteThrough:noop,remove:noop};
 assert.equal(new source.RayneoPairingRegistry({io}).read(),undefined);
 assert.deepEqual(seen,[dirname(source.RAYNEO_PAIRING_REGISTRY_PATH)]);});
