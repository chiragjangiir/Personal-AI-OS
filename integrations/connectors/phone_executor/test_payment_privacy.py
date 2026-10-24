"""Real pre-checkpoint producer failure -> privacy consumer; no services or devices."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server

ROOT = Path(__file__).resolve().parents[3]
LANE1 = 'dcd86521'
BACKEND = '01-product-half-finished/backend/'


def frozen(path):
    return subprocess.check_output(['git', 'show', f'{LANE1}:{BACKEND}{path}'], cwd=ROOT, text=True)


def section(source, start, end):
    return source[source.index(start):source.index(end, source.index(start))]


class PaymentPrivacy(unittest.IsolatedAsyncioTestCase):
    async def test_real_precheckpoint_failure_remains_private_after_conversation_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            job = 'job-0123456789ab'
            task = dict(goal='synthetic merchant/item/address/amount', app='千问', tier='fast', max_steps=1,
                        latitude=None, longitude=None, ride_ok=False, payment_intent='pi-owner')
            # Actual early staging failure in _errand_task, before any checkpoint or driver.
            with mock.patch.object(server, 'SPOOL', tmp), mock.patch.dict(os.environ, PAIOS_STAGE='staging'), \
                 mock.patch.object(server, '_driver', side_effect=AssertionError('phone driver used')):
                server._start(job, task, "付款测试", "owner")
                await server._jobs[job]["task"]
            record = json.loads((Path(tmp) / f'{job}.done.json').read_text())
            self.assertEqual(record['terminal_reason'], 'failed')
            self.assertIn('测试付款只允许假收银台', record['answer'])
            self.assertEqual(record['payment_intent'], task['payment_intent'])
            spool = frozen('phase0/gateway/src/errand-spool.ts')
            authority = frozen('services/personal-aios-integration/src/payment/authority.ts')
            runtime = frozen('services/personal-aios-integration/src/runtime.ts')
            # Exact frozen method bodies. Fixture seams implement storage, validation and auditing only.
            script = """
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE intents(intent_id TEXT,principal_id TEXT,session_id TEXT,run_id TEXT); CREATE TABLE payments(principal_id TEXT,job_id TEXT); CREATE TABLE events(principal_id TEXT,kind TEXT,data TEXT)');
const check=(v:unknown,code:string)=>{if(!v)throw new Error(code)};
const id=(v:string)=>assert.ok(v.length>0), canonical=JSON.stringify;
const utc=(v:string)=>assert.ok(Number.isFinite(Date.parse(v)));
const TERMINAL_REASONS=['completed','cancelled_by_user','failed','timed_out','interrupted'];
const JOB=/^[a-z0-9][a-z0-9-]{7,63}$/;
""" + section(spool, 'export function parseErrandResult(', '/** The phone notice') + """
class Authority {
  store={db,getIntent:(id:string)=>db.prepare('SELECT * FROM intents WHERE intent_id=?').get(id)};
  audit(principal:string,kind:string,data:unknown){db.prepare('INSERT INTO events VALUES(?,?,?)').run(principal,kind,JSON.stringify(data));}
""" + section(authority, '  paymentErrand(', '  source(') + """
}
class Runtime {
  payment=new Authority();
""" + section(runtime, '  private paymentResultPrivacy(', '  async result(') + """
}
const record=JSON.parse(readFileSync(process.argv[2],'utf8'));
db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run('pi-owner','owner','origin-conversation','origin-run');
const runtime=new Runtime();
const event=(value:any,principal='owner')=>({principal_id:principal,content:{app_event:{kind:'errand_result',...parseErrandResult(value)}}});
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n,0);
assert.deepEqual(runtime.paymentResultPrivacy(event(record),'moved-conversation','new-run'),{private:'payment'});
const {payment_intent,...legacy}=record;
assert.deepEqual(runtime.paymentResultPrivacy(event(legacy),'legacy-conversation','legacy-run'),{});
assert.throws(()=>runtime.paymentResultPrivacy(event(record,'foreign'),'foreign-conversation'),/PAYMENT_INTENT_SCOPE_DENIED/);
assert.throws(()=>parseErrandResult({...record,payment_intent:''}),/ERRAND_RESULT_INVALID/);
db.close();
"""
            fixture = Path(tmp) / 'privacy.mts'
            fixture.write_text(script)
            result = subprocess.run([shutil.which('node'), '--disable-warning=ExperimentalWarning', str(fixture),
                                     str(Path(tmp) / f'{job}.done.json')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
