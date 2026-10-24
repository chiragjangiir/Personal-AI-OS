import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
test('per-run bounded discovery counts pending entries and closes the original directory handle',async()=>{
  const home=await mkdtemp(join(tmpdir(),'proposal-storage-'));
  try {
    const storage=new PosixStorage(home);await mkdir(join(home,'mp-test'));
    for(let n=0;n<257;n++)await writeFile(join(home,'mp-test',`.pending-${n}`),'owned');
    await assert.rejects(storage.list('mp-test',256),/STORAGE_READ_BUDGET_EXCEEDED/);
    // Legacy callers still see their original unbounded sorted key view.
    assert.deepEqual(await storage.list('mp-test'),[]);
    await rm(join(home,'mp-test'),{recursive:true});
    const key='a'.repeat(64);await storage.publish('mp-other',key,Buffer.from('owned'));
    assert.deepEqual(await storage.list('mp-other',256),[key]);
  } finally {await rm(home,{recursive:true});}
});
