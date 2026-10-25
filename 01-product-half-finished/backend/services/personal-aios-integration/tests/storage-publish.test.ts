import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {digest} from '../src/contracts.ts';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {acquireProcessLock} from '../src/process-lock.ts';

async function fixture(t:TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'storage-publish-')),storage=new PosixStorage(root),key=digest('slot');
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  await storage.publish('admission-inputs',key,Buffer.from('old'));
  return {storage,key,target:join(await fs.realpath(root),'admission-inputs',key)};
}

for(const replacement of [false,true])
test(`unlinked publication takes the absent path once with ${replacement?'a competing winner':'no replacement'}`,async t=>{
  const {storage,key,target}=await fixture(t),open=fs.open;
  let held=false,links:number|undefined;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);
    if(args[0]===target&&!held){held=true;const stat=handle.stat.bind(handle);
      handle.stat=(async()=>{
        await storage.removePending(key);
        if(replacement)await storage.publish('admission-inputs',key,Buffer.from('winner'));
        const result=await stat();links=result.nlink;return result;
      }) as typeof handle.stat;
    }
    return handle;
  });
  const expected=Buffer.from(replacement?'winner':'new');
  assert.deepEqual(Buffer.from(await storage.publish('admission-inputs',key,Buffer.from('new'))),expected);
  assert.equal(links,0);
  assert.deepEqual(await fs.readFile(target),expected);
  assert.deepEqual(await storage.listHot('admission-inputs'),[key]);
});

for(const kind of ['symlink','directory','unlinked-directory'])
test(`publication still refuses a ${kind} target`,async t=>{
  const {storage,key,target}=await fixture(t);await storage.removePending(key);
  const outside=join(storage.root,'outside');await fs.writeFile(outside,'untouched');
  if(kind==='symlink')await fs.symlink(outside,target);else await fs.mkdir(target);
  if(kind==='unlinked-directory'){
    const open=fs.open;
    t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
      const handle=await open(...args);
      if(args[0]===target){const stat=handle.stat.bind(handle);
        handle.stat=(async()=>{await fs.rmdir(target);return stat();}) as typeof handle.stat;}
      return handle;
    });
  }
  await assert.rejects(storage.publish('admission-inputs',key,Buffer.from('new')),kind==='symlink'?/ELOOP/:/UNSAFE_STORAGE_OBJECT/);
  assert.equal(await fs.readFile(outside,'utf8'),'untouched');
});

test('a linked regular winner may have multiple names and remains immutable',async t=>{
  const {storage,key,target}=await fixture(t),alias=join(storage.root,'alias');await fs.link(target,alias);
  assert.equal((await fs.stat(target)).nlink,2);
  assert.deepEqual(Buffer.from(await storage.publish('admission-inputs',key,Buffer.from('new'))),Buffer.from('old'));
  assert.equal(await fs.readFile(alias,'utf8'),'old');
});


test('startup recovery after SIGKILL removes only unpublished names and preserves snapshot pins',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'storage-recovery-')),lock=join(root,'owner.lock');
  const storageRoot=join(root,'archive'),storage=new PosixStorage(storageRoot),key=digest('durable');
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  await storage.publish('objects',key,Buffer.from('durable'));
  const snapshot='a'.repeat(64),pin='b'.repeat(64),pendingSnapshot=join(storageRoot,'.snapshots',`.pending-${pin}`);
  const completed=join(storageRoot,'.snapshots',snapshot);
  await fs.mkdir(join(completed,'objects'),{recursive:true});
  await fs.mkdir(join(pendingSnapshot,'objects'),{recursive:true});
  await fs.link(join(storageRoot,'objects',key),join(completed,'objects',key));
  await fs.link(join(storageRoot,'objects',key),join(pendingSnapshot,'objects',key));
  await fs.writeFile(join(completed,'snapshot.json'),JSON.stringify({dependency_packs:[{key:pin}]}));
  await storage.publish('backup-dependencies',pin,Buffer.from(JSON.stringify({dependency_packs:[{key:pin}]})));
  const linkedPending=join(storageRoot,'objects',`.pending-${randomUUID()}`);
  await fs.link(join(storageRoot,'objects',key),linkedPending);
  const unknown=join(storageRoot,'objects','.pending-torn');await fs.writeFile(unknown,'preserve unknown');
  const outside=join(root,'outside');await fs.writeFile(outside,'preserve outside');
  await fs.symlink(outside,join(pendingSnapshot,'outside-link'));
  const symlink=join(storageRoot,'objects',`.pending-${randomUUID()}`);await fs.symlink(outside,symlink);
  const code=`import {promises as fs} from 'node:fs';
    import {acquireProcessLock} from ${JSON.stringify(new URL('../src/process-lock.ts',import.meta.url).href)};
    import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts',import.meta.url).href)};
    await acquireProcessLock(process.argv[1]);
    fs.link=async()=>{console.log('writing');await new Promise(()=>{setInterval(()=>{},1000);});};
    await new PosixStorage(process.argv[2]).publish('objects', 'c'.repeat(64),Buffer.from('unfinished'));
    `;
  const child=spawn(process.execPath,['--input-type=module','-e',code,lock,storageRoot],{stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',block=>{errors+=block;});
  const ended=new Promise(resolve=>child.once('exit',resolve));
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(new Error(errors||'writer exited before publication')));});
  await assert.rejects(acquireProcessLock(lock),/PERSONAL_AIOS_ALREADY_RUNNING/);
  child.kill('SIGKILL');await ended;
  const release=await acquireProcessLock(lock);
  try{
    await storage.recoverPending();
    const restarted=new PosixStorage(storageRoot);
    try{await restarted.recoverPending();}finally{await restarted.close();}
    assert.deepEqual((await fs.readdir(join(storageRoot,'objects'))).sort(),[unknown.split('/').at(-1)!,symlink.split('/').at(-1)!,key].sort());
    assert.equal(await fs.readFile(join(completed,'objects',key),'utf8'),'durable');
    assert.equal(await fs.readFile(join(storageRoot,'objects',key),'utf8'),'durable');
    assert.equal((await fs.stat(join(storageRoot,'objects',key))).nlink,2);
    assert.equal(await fs.readFile(outside,'utf8'),'preserve outside');
    assert.ok(await fs.lstat(symlink));
    assert.ok(await storage.read('backup-dependencies',pin));
    assert.deepEqual(await fs.readdir(join(storageRoot,'.snapshots')),[snapshot]);
  }finally{await release();}
});
