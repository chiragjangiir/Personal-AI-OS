import test from 'node:test';
import assert from 'node:assert/strict';import {createRequire}from'node:module';import {randomUUID}from'node:crypto';import{readFile,writeFile,mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{openFixtureDatabase}from'../src/memory/fixture-database.ts';
import{L3Service}from'../src/memory/l3.ts';
const require=createRequire(new URL('../../platform-data/package.json',import.meta.url));const{Pool}=require('pg') as {Pool:new(config:Record<string,unknown>)=>ConstructorParameters<typeof L3Service>[0]};
test('original owned fixture current migration chain, concurrency, pin and transaction boundary', {skip:!process.env.PAIOS_L3_TEST_DATABASE_URL}, async t=>{
const Q=new URL('./',import.meta.url),schema='paios_fixture_'+randomUUID().replaceAll('-',''),url=process.env.PAIOS_L3_TEST_DATABASE_URL!;
const migration_file=new URL('../../../migrations/0009_hermes_l3.up.sql',Q).pathname;const config={url,schema,migration_file};
const parsed=new URL(url);assert.equal(parsed.protocol,'postgresql:');assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');assert.equal(parsed.username,'l3test');assert.equal(parsed.pathname,'/postgres');
const admin=new Pool({connectionString:url,max:1});const results:{name:string;status:string;[key:string]:unknown}[]=[];let one:Awaited<ReturnType<typeof openFixtureDatabase>>|undefined,two:typeof one;const pass=(name:string,details={})=>{results.push({name,status:'pass',...details});console.log('PASS '+name)};
const failure=async(name:string,fn:()=>Promise<unknown>)=>{let e:unknown;try{await fn()}catch(x){e=x}assert(e);pass(name,{code:e instanceof Error?e.message:String(e)})};
try {
 [one,two]=await Promise.all([openFixtureDatabase(config),openFixtureDatabase(config)]);
 await L3Service.openExisting(one.pool,schema);await L3Service.openExisting(two.pool,schema);
 const ledger=(await one.pool.query('SELECT version,sha256 FROM fixture_migrations ORDER BY version')).rows;
 assert.equal(ledger.length,3);assert.deepEqual(ledger.map(x=>x.version),['0009_hermes_l3','0012_l3_payload_audit_split','0018_l3_forget_dependency_closure']);
 pass('two-concurrent-original-fixture-owner-startups-valid-readiness',{ledger,schema});
 await one.pool.query("UPDATE fixture_migrations SET sha256='drift' WHERE version='0012_l3_payload_audit_split'");
 await failure('ledger-drift-rejects-startup',()=>openFixtureDatabase(config));
 await one.pool.query('UPDATE fixture_migrations SET sha256=$1 WHERE version=$2',[ledger[1].sha256,ledger[1].version]);
 const third=await openFixtureDatabase(config);await third.close();pass('exact-source-ledger-restart');
 let created=0;const queries:string[]=[];class ControlledPool {constructor(){created++;}async connect(){return{query:async(sql:string)=>{queries.push(sql);return{rows:[]}},release(){}}}async end(){}}
 const fake=await openFixtureDatabase(config,ControlledPool as never);await fake.close();assert.equal(created,2);
 assert.equal(queries.filter(s=>s==='BEGIN').length,1);assert.equal(queries.filter(s=>s==='COMMIT').length,1);
 const split=await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',Q),'utf8');
 const wrapped=queries.find(s=>s.includes('CREATE TABLE paios_l3_payloads'));assert(wrapped);assert(!wrapped.includes('\nBEGIN;\n'));assert(!wrapped.endsWith('COMMIT;\n'));
 const prefix='-- Owned, offline source migration. Apply only after draining old writers in this namespace.\n';
 assert.equal(prefix+'BEGIN;\n'+wrapped.slice(prefix.length)+'COMMIT;\n',split);
 pass('fixed-sha-exact-boundary-reconstruction-one-original-transaction');
 const folder=await mkdtemp(join(tmpdir(),'owned-migration-pin-'));t.after(()=>rm(folder,{recursive:true,force:true}));const damaged=new URL('file://'+join(folder,'damaged0009.sql'));await writeFile(damaged,(await readFile(migration_file,'utf8'))+'\n-- changed\n');
 const before=created;await failure('source-migration-drift-before-db-allocation',()=>openFixtureDatabase({...config,migration_file:damaged.pathname},ControlledPool as never));assert.equal(created,before);
 for(const patch of [{url:'postgresql://l3test@127.0.0.1:55432/postgres'},{url:'postgresql://l3test@outside.invalid:55439/postgres'},{schema:'public'},{schema:'paios_fixture_bad;DROP'}]){
  await failure('nonfixture-scope-rejected',()=>openFixtureDatabase({...config,...patch},ControlledPool as never));assert.equal(created,before);
 }
}finally{await one?.close();await two?.close();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');const remaining=(await admin.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1',[schema])).rows[0].n;await admin.end();assert.equal(remaining,0);}

});
