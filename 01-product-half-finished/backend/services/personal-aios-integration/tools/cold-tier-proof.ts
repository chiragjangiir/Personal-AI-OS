import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import type {ColdConfig} from '../src/cold-storage.ts';

// Run against the isolated local OpenList staging mount, never a real cloud account.
// node tools/cold-tier-proof.ts /path/to/staging-config.json
const path=process.argv[2]??process.env.PAIOS_COLD_STAGING_CONFIG;
assert.ok(path,'STAGING_CONFIG_REQUIRED: supply a JSON config path');
const config=JSON.parse(await fs.readFile(path,'utf8')) as ColdConfig;
assert.equal(typeof config.username,'string');assert.ok(config.username);
assert.equal(typeof config.password_file,'string');assert.ok(config.password_file);
const url=new URL(config.url);
assert.ok(['http:','https:'].includes(url.protocol),'STAGING_PROTOCOL_REQUIRED');
assert.ok(['127.0.0.1','localhost','cold-webdav-staging'].includes(url.hostname),'LOCAL_STAGING_HOST_REQUIRED');
assert.ok(!url.username&&!url.password&&!url.search&&!url.hash,'STAGING_URL_INVALID');
assert.ok(url.pathname.split('/').includes('cold-webdav-staging'),'ISOLATED_COLD_WEBDAV_STAGING_PATH_REQUIRED');
config.password_file=resolve(dirname(resolve(path)),config.password_file);
const root=await fs.mkdtemp(join(tmpdir(),'paios-cold-staging-proof-'));
const stores:PosixStorage[]=[],archives:RawArchive[]=[];
let owner:PosixStorage|undefined,proof:Record<string,unknown>|undefined;
try{
  owner=new PosixStorage(join(root,'hot'),{cold:config});stores.push(owner);
  const archive=new RawArchive(owner,2*1024*1024);archives.push(archive);
  const original=randomBytes(256*1024),now=Date.now();
  const event=await archive.archive({schema_version:'paios.event.v1',event_id:`staging-${randomUUID()}`,device_id:'staging-phone',device_type:'phone',
    captured_at:new Date(now).toISOString(),source:{channel:'upload'},media_type:'file',mime:'application/octet-stream',representation:'uploaded_original',payload:original},
    {principal_id:'staging-owner',device_id:'staging-phone',device_type:'phone',channel:'upload',consent_ref:'isolated-local-proof',submission:'observation'});
  const started=performance.now();await archive.moveCold(2,now);
  const elapsed=performance.now()-started;assert.ok(elapsed<60000,'COPY_EXCEEDED_60_SECONDS');
  const locations=await owner.cold!.locations();assert.ok(locations.length>=2,'VERIFIED_LOCATIONS_MISSING');
  assert.deepEqual(Buffer.from(await owner.cold!.read('objects',event.payload_sha256)),original);
  await archive.moveCold(2,now+47*3600000);
  assert.deepEqual(Buffer.from(await owner.readHot('objects',event.payload_sha256)),original);
  for(let tick=0;tick<3&&(await owner.listHot('objects')).length;tick++)await archive.moveCold(2,now+49*3600000);
  assert.deepEqual(await owner.listHot('objects'),[],'OLD_VERIFIED_ORIGINAL_STILL_HOT');
  await archive.close();await owner.close();
  const reopened=new PosixStorage(join(root,'hot'),{cold:config}),reader=new RawArchive(reopened,2*1024*1024);
  stores.push(reopened);archives.push(reader);owner=reopened;
  assert.deepEqual(Buffer.from(await reader.read(event.raw_ref,'staging-owner',event.archive_revision)),original);
  proof={transport:'configured-local-staging-webdav',copy_ms:Math.round(elapsed),under_60_seconds:true,retained_at_47_hours:true,
    evicted_at_49_hours:true,cold_read_byte_equal:true,reopened_read_byte_equal:true,
    scope:'Local staging transport only. Process interruption and reserve pressure are covered by isolated integration tests.'};
}finally{
  for(const archive of archives)await archive.close();
  // This database belongs only to this invocation; never enumerate or delete unrelated remote files.
  if(owner){for(const pack of await owner.cold!.packs()){
    await owner.cold!.forget(await owner.cold!.locations(undefined,pack.key),pack.key);
    await owner.cold!.removePack(pack.key);
  }}
  for(const store of stores)await store.close();
  await fs.rm(root,{recursive:true,force:true});
}
process.stdout.write(JSON.stringify({...proof,cleanup:'own staging packs and temporary hot root removed'})+'\n');
