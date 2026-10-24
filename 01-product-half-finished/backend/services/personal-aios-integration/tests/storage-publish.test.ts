import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {digest} from '../src/contracts.ts';

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
