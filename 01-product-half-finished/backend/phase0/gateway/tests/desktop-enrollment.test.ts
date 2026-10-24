import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isRealtimePublicControlRoute } from '../src/realtime-public-control-controller.ts';

test('public edge admits enrollment, Mac pairing, capability declarations and SSH lifecycle but never internal desktop MCP',()=>{
  // The direct origin is production ingress; the legacy edge remains a compatibility endpoint.
  for(const config of ['deploy/cloud/front.conf.in','deploy/tencent/nginx/paios-ai-roaming.conf']){
    const edge=readFileSync(new URL('../../../../../'+config,import.meta.url),'utf8');
    assert.match(edge,/location ~ \^\/v1\/devices\/\(glasses\|mac\)\/enrollment\(\?:\/exchange\)\?\$/);
    assert.match(edge,/location ~ \^\/v1\/\(devices\/mac\/pairing\/\(request\|preview\|approve\|exchange\)\|mac\/ssh\/\(provision\|pause\|revoke\)\)\$/);
    assert.match(edge,/route_class terminal_enrollment;/);
    assert.match(edge,/location = \/v1\/terminals\/capabilities \{/);
    const routes=['glasses','mac'].flatMap(deviceClass=>['','/exchange'].map(suffix=>`/v1/devices/${deviceClass}/enrollment${suffix}`))
      .concat(['request','preview','approve','exchange'].map(action=>`/v1/devices/mac/pairing/${action}`),'/v1/terminals/capabilities')
      .concat(['provision','pause','revoke'].map(action=>`/v1/mac/ssh/${action}`));
    for(const route of routes){
      assert.equal(isRealtimePublicControlRoute('POST',route),true);
      assert.ok(edge.includes(`"HTTP/2.0:POST:${route}" 1;`),`${config} ${route}`);
      for(const method of ['GET','DELETE'])assert.equal(isRealtimePublicControlRoute(method,route),false);
      for(const tail of ['?x=1','/','/extra'])assert.equal(isRealtimePublicControlRoute('POST',route+tail),false);
    }
    assert.doesNotMatch(edge,/location[^\n]*\/internal\//);
  }
  assert.equal(isRealtimePublicControlRoute('POST','/internal/desktop/mcp'),false);
});

const pgUrl=process.env.PAIOS_FORMAL_SOURCE_TEST_DATABASE_URL;
test('I14 ledgered migration supports fresh, 0016 upgrade, adoption and rollback without losing revoked Mac history',{skip:pgUrl===undefined},async()=>{
  const {randomUUID}=await import('node:crypto'),{readFile,readdir,mkdtemp,copyFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url');
  const {createPostgresPool}=await import('../../../services/platform-data/src/postgres-pool.ts');
  const {loadMigrations,migrateDatabase}=await import('../../../services/platform-data/src/schema-migrator.ts');
  const parsed=new URL(pgUrl!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const connect=()=>createPostgresPool({host:parsed.hostname,port:Number(parsed.port),user:parsed.username,database:parsed.pathname.slice(1),max:1});
  const admin=connect(),name='terminal_migration_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);parsed.pathname='/'+name;
  const pool=connect(),migrations=new URL('../../../migrations/',import.meta.url);
  const sql=(name:string)=>readFile(new URL(name,migrations),'utf8');
  const before17=await mkdtemp(join(tmpdir(),'terminal-migrations-'));
  try{
    const files=(await readdir(migrations)).sort(),full=fileURLToPath(migrations);
    // The migrations directory is the head; the canonical migrator test pins its number once.
    const all=loadMigrations(full),head=all.length,after16=all.filter(m=>m.version>=17).map(m=>String(m.version).padStart(4,'0')+'_'+m.name);
    for(const file of files.filter(file=>file<'0017'&&/\.(up|verify)\.sql$/.test(file)))await copyFile(new URL(file,migrations),join(before17,file));
    const fresh=await migrateDatabase(pool,full);
    assert.equal(fresh.applied.length,head);assert.equal(fresh.verified,head);
    assert.deepEqual(await migrateDatabase(pool,full),{status:'migrated',adopted:[],applied:[],verified:head});
    // Final verification must reject weaker or ambiguous post-0017 persisted shapes.
    for(const mutation of [
      'ALTER TABLE terminal_enrollments DROP CONSTRAINT glasses_enrollments_token_sha256_key',
      'ALTER TABLE terminal_enrollments DROP CONSTRAINT terminal_enrollments_device_class_check',
      'ALTER TABLE terminal_enrollments DROP CONSTRAINT terminal_enrollments_pkey; ALTER TABLE terminal_enrollments ADD PRIMARY KEY (phone_device_id)',
      'CREATE TABLE glasses_enrollments (LIKE terminal_enrollments INCLUDING ALL)',
    ]){
      await pool.query('BEGIN');
      try{await pool.query(mutation);await assert.rejects(migrateDatabase(pool,full),/MIGRATION_FINAL_VERIFY_FAILED:0015_glasses_enrollments/);}
      finally{await pool.query('ROLLBACK');}
    }
    // The down SQL has no ledger runner: update its disposable ledger to the restored prefix.
    for(const down of [...after16].reverse())
      await pool.query(await sql(down+'.down.sql'));
    await pool.query('DELETE FROM paios_migrations.schema_migrations WHERE version>=17');
    assert.deepEqual(await migrateDatabase(pool,before17),{status:'migrated',adopted:[],applied:[],verified:16});
    // This ledgered 0016 state matches the production upgrade path.
    assert.deepEqual(await migrateDatabase(pool,full),{status:'migrated',adopted:[],applied:after16,verified:head});
    const {pairDevice,revokePairedDevice}=await import('../src/paired-device-registration.ts');
    const {createProductionRealtimeIdentityPort}=await import('../../../services/platform-data/src/realtime-identity-issuer.ts');
    const {createHash}=await import('node:crypto'),raw=Buffer.alloc(32,1);
    const identity=createProductionRealtimeIdentityPort({clock:{now:()=>new Date().toISOString() as never}});
    const mac=await pairDevice({origin:'https://api.example:9443',pool,identity,registration:Buffer.from(JSON.stringify({device_type:'mac',capabilities:['display','chat_ui','desktop_tools'],public_raw32_base64url:raw.toString('base64url'),public_sha256:createHash('sha256').update(raw).digest('hex')}))});
    await revokePairedDevice({pool,deviceId:mac.device_id,ownerUserId:mac.user_id});
    await assert.rejects(pool.query(await sql('0017_terminal_enrollments.down.sql')),/MAC_TERMINAL_HISTORY_PRESENT/);
    await pool.query('ROLLBACK');
    assert.deepEqual(await migrateDatabase(pool,full),{status:'migrated',adopted:[],applied:[],verified:head});
    // An already-migrated pre-ledger database must adopt all of them, without replaying the rename.
    await pool.query('DROP SCHEMA paios_migrations CASCADE');
    const adopted=await migrateDatabase(pool,full);
    assert.equal(adopted.adopted.length,head);assert.deepEqual(adopted.applied,[]);assert.equal(adopted.verified,head);
    assert.deepEqual(await migrateDatabase(pool,full),{status:'migrated',adopted:[],applied:[],verified:head});
  }finally{await pool.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();await rm(before17,{recursive:true,force:true});}
});
