import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseError } from 'pg';
import { withTransaction, PostgresTxError, isManagedTransactionClient } from '../src/transaction.ts';

const sqlFailure = Object.assign(new DatabaseError('business rejection', 0, 'error'), { code: '40001', severity: 'ERROR' });
const networkFailure = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
const pipeFailure = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
for (const failedPhase of [undefined, 'BEGIN', 'SET TRANSACTION', 'work', 'COMMIT'] as const) {
  for (const rollbackFails of [false, true]) {
    for (const original of [sqlFailure, networkFailure, pipeFailure]) {
      test(`lifecycle ${failedPhase ?? 'success'} rollbackFails=${rollbackFails} code=${original.code}`, async () => {
        const statements: string[] = [];
        const releases: unknown[] = [];
        let workCalls = 0;
        const client = {
          async query(sql: string) {
            assert.equal(isManagedTransactionClient(client), true);
            statements.push(sql);
            if (failedPhase && sql.startsWith(failedPhase)) throw original;
            if (sql === 'ROLLBACK' && rollbackFails) throw new Error('cleanup failure');
            return { rows: [], rowCount: 0 };
          },
          release(destroy?: boolean) {
            assert.equal(isManagedTransactionClient(client), false);
            releases.push(destroy);
          },
        };
        const pool = { connect: async () => client } as any;
        const run = () => withTransaction(pool, async value => {
          assert.equal(isManagedTransactionClient(value), true);
          workCalls += 1;
          if (failedPhase === 'work') throw original;
          return 'result';
        });
        if (failedPhase) {
          await assert.rejects(run, error => failedPhase === 'COMMIT' && original !== sqlFailure
            ? error instanceof PostgresTxError && error.phase === 'commit' && error.outcomeUncertain && error.cause === original
            : error === original);
        } else assert.equal(await run(), 'result');
        assert.deepEqual(releases, [failedPhase && rollbackFails ? true : undefined]);
        assert.equal(isManagedTransactionClient(client), false);
        assert.equal(workCalls, failedPhase === 'BEGIN' || failedPhase === 'SET TRANSACTION' ? 0 : 1);
        assert.equal(statements.filter(sql => sql === 'ROLLBACK').length, failedPhase ? 1 : 0);
        assert.equal(statements.filter(sql => sql === 'COMMIT').length, !failedPhase || failedPhase === 'COMMIT' ? 1 : 0);
      });
    }
  }
}

for (const original of [
  Object.assign(new Error('not a server ErrorResponse'), { code: '40001' }),
  Object.assign(new DatabaseError('connection failure', 0, 'error'), { code: '08006', severity: 'ERROR' }),
  Object.assign(new DatabaseError('completion unknown', 0, 'error'), { code: '40003', severity: 'ERROR' }),
  Object.assign(new DatabaseError('shutdown', 0, 'error'), { code: '57P01', severity: 'FATAL' }),
]) {
  test(`COMMIT ${original.constructor.name} ${original.code} cannot prove rejection`, async () => {
    const client = { query: async (sql: string) => { if (sql === 'COMMIT') throw original; }, release() {} };
    await assert.rejects(() => withTransaction({ connect: async () => client } as any, async () => 'result'),
      error => error instanceof PostgresTxError && error.outcomeUncertain && error.cause === original);
  });
}

test('connect failure does not release a client or run work', async () => {
  let calls = 0;
  await assert.rejects(() => withTransaction({ connect: async () => { throw networkFailure; } } as any, async () => { calls += 1; }), error => error === networkFailure);
  assert.equal(calls, 0);
});

test('idle error is observable without process crash or private error details', () => {
  const source = new URL('../src/postgres-pool.ts', import.meta.url).href;
  const script = `import {createPostgresPool,closePostgresPool} from ${JSON.stringify(source)};
const pool=createPostgresPool({password:'credential-do-not-log'});
if(pool.listenerCount('error')!==1)throw new Error('expected one owner listener');
pool.emit('error',new Error('private-query-do-not-log'),{password:'credential-do-not-log'});
await closePostgresPool(pool);
console.log('POOL_CLOSED');`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /POSTGRES_POOL_IDLE_ERROR/u);
  assert.doesNotMatch(result.stderr, /credential-do-not-log|private-query-do-not-log/u);
  assert.match(result.stdout, /POOL_CLOSED/u);
});
