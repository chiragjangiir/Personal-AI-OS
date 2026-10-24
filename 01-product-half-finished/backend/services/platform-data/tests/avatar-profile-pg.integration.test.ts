import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createPostgresPool} from '../src/postgres-pool.ts';
import {AvatarProfileService,type AvatarLook} from '../../../phase0/gateway/src/avatar-profile.ts';

const target=process.env.PAIOS_AVATAR_TEST_DATABASE_URL;
const connect=(url:URL)=>createPostgresPool({host:url.hostname,port:Number(url.port||5432),database:url.pathname.slice(1),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),max:5});
test('avatar PostgreSQL migration, CAS, deferred first insert, and concurrent readiness commit',{skip:target===undefined},async()=>{
  const url=new URL(target!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  const admin=connect(url);const name='avatar_test_'+randomUUID().replaceAll('-','');
  let pool:ReturnType<typeof connect>|undefined;
  await admin.query('CREATE DATABASE '+name);
  try{
    const isolated=new URL(url);isolated.pathname='/'+name;pool=connect(isolated);
    await pool.query(await readFile(new URL('../../../migrations/0019_avatar_profiles.up.sql',import.meta.url),'utf8'));
    const verified=await pool.query(await readFile(new URL('../../../migrations/0019_avatar_profiles.verify.sql',import.meta.url),'utf8'));
    assert.equal(verified.rows[0].complete,true);
    const approved:AvatarLook={look_id:'approved',style:'illustration',image_url:'https://assets.example/immutable/approved.jpg',focus:{x:0.5,y:0.4},vidu_avatar_id:'ready-id'};
    const fresh:AvatarLook={look_id:'new',style:'illustration',image_url:'https://assets.example/immutable/new.jpg',focus:{x:0.5,y:0.4}};
    const calls:{release:(asset:{id:string;state:'ready'})=>void}[]=[];
    let both!:()=>void;const twoGets=new Promise<void>(resolve=>{both=resolve;});
    const assets={create:async()=>({id:'generated-id',state:'pending' as const}),get:async()=>new Promise<{id:string;state:'ready'}>(release=>{calls.push({release});if(calls.length===2)both();})};
    const service=()=>new AvatarProfileService({pool:pool!,looks:[approved,fresh],assets});
    const first=service(),second=service();
    const input={principal_id:'owner',device_id:'phone',command_id:'first',expected_version:0,look_id:'approved',owner_request:'change look'};
    const winners=await Promise.allSettled([first.change(input),second.change({...input,device_id:'mac',command_id:'other'})]);
    assert.equal(winners.filter(result=>result.status==='fulfilled').length,1);
    assert.equal((await first.read('owner'))?.version,1);
    await first.change({...input,command_id:'generate',expected_version:1,look_id:'new'});
    const polling=[first.reconcile('owner','generate'),second.reconcile('owner','generate')];
    await twoGets;for(const call of calls)call.release({id:'generated-id',state:'ready'});await Promise.all(polling);
    assert.equal((await first.read('owner'))?.version,2);
    assert.equal(await first.activeAvatarId('owner'),'generated-id');
    await first.loaded('owner','mac','mac',2);
    const restored=await second.reuse({principal_id:'owner',device_id:'mac',command_id:'restore-default',expected_version:2,version:0,owner_request:'恢复默认'});
    assert.equal(restored.profile_version,3);assert.equal(restored.profile,null);
    const restarted=service();
    assert.deepEqual((await restarted.history('owner')).recent_versions.map(item=>item.version),[1,2,3]);
    assert.equal((await restarted.snapshot('owner')).loaded_receipts[0]?.profile_version,2);
    await restarted.loaded('owner','mac','mac',3);
    assert.equal((await first.snapshot('owner')).loaded_receipts[0]?.profile_version,3);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM avatar_profiles')).rows[0].n,1);
    await pool.query(await readFile(new URL('../../../migrations/0019_avatar_profiles.down.sql',import.meta.url),'utf8'));
    assert.equal((await pool.query("SELECT to_regclass('public.avatar_profiles') AS p")).rows[0].p,null);
  }finally{
    await pool?.end();await admin.query('DROP DATABASE '+name);await admin.end();
  }
});
