"""Run the canonical paired client and verify its persisted conversation authorities."""
import json
import subprocess
from pathlib import PurePosixPath

G = '/opt/paios/01-product-half-finished/backend/phase0/gateway'
I = '/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/src'
GUARD = "import os,sys; assert os.environ.get('PAIOS_STAGE')=='staging'; os.execvp(sys.argv[1],sys.argv[1:])"
VERIFY = r"""
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {loadHostConfiguration} from '%s/host-configuration.ts';
import {PosixStorage} from '%s/storage.ts';
import {digest,runScope} from '%s/contracts.ts';
const [kind,input]=process.argv.slice(1),r=JSON.parse(input),config=await loadHostConfiguration('/etc/paios/cloud.json');
if(process.env.PAIOS_STAGE!=='staging')throw Error('STAGING_REQUIRED');
const db=new DatabaseSync(join(config.storage_root,'timeline','timeline.sqlite'),{readOnly:true});
const disk=new PosixStorage(config.storage_root),decode=b=>JSON.parse(Buffer.from(b).toString());
const read=(ns,key)=>disk.read(ns,key).then(decode);
const assert=(v)=>{if(!v)throw Error('CANONICAL_TURN_NOT_SETTLED');};
try{
 let rows=[];const deadline=Date.now()+30000;do{
 rows=kind==='chat'?db.prepare('SELECT * FROM items WHERE processed_event_id=?').all(r.processed_event_id):
   db.prepare('SELECT * FROM items WHERE principal_id=? AND source_device_id=? AND session_id=?').all(r.principal_id,r.device_id,r.session_id);
 if(rows.some(x=>x.kind===(r.errand?'owner':'yimi')&&x.text.trim()))break;await sleep(500);
 }while(Date.now()<deadline);
 const ids=[...new Set(rows.map(x=>x.processed_event_id).filter(Boolean))],verified=[],documents=[];
 for(const id of ids){
  const principal=rows.find(x=>x.processed_event_id===id).principal_id;
  const d=await read('processed-events',digest({principal_id:principal,processed_event_id:id}));
  const turn=d.content.app_event;
  if(kind==='call'&&!(turn?.kind==='voice_turn'&&turn.call_id===r.call_id&&r.turns.includes(turn.turn)))continue;
  // Speech the call did not attribute to the owner is kept as an observation and is never answered.
  if(kind==='call'&&runScope(d)!=='owner')continue;
  assert(d.principal_id===principal&&d.processed_event_id===id&&(kind!=='chat'||d.event_id===r.event_id));
  if(kind==='call')assert(d.device_id===r.device_id);
  documents.push(d);
 }
 const lineage=new Map(),covered=new Set();
 for(const d of documents){
  const turn=d.content.app_event,principal=d.principal_id;
  if(kind!=='call'||turn.phase!=='complete')continue;
  assert(turn.route==='handoff'&&typeof turn.handoff_event_id==='string');
  const matches=documents.filter(early=>early.event_id===turn.handoff_event_id);
  assert(matches.length===1);
  const early=matches[0],initial=early.content.app_event;
  assert(initial.phase==='handoff'&&initial.route==='handoff'&&early.principal_id===principal&&
    early.device_id===d.device_id&&initial.call_id===turn.call_id&&initial.turn===turn.turn&&
    (initial.speaker??'unknown')===(turn.speaker??'unknown'));
  const completionKey=digest({principal_id:principal,event_id:early.event_id});
  const completion=await read('call-handoff-completions',completionKey);
  assert(completion.processed_event_id===d.processed_event_id&&!covered.has(early.processed_event_id));
  const binding=await read('d-session-bindings',digest({principal_id:principal,processed_event_id:early.processed_event_id}));
  const end=await read('run-terminals',digest({principal_id:principal,session_id:binding.session_id,processed_event_id:early.processed_event_id}));
  assert(end.status==='completed'&&end.run_id);
  lineage.set(d.processed_event_id,{initial_processed_event_id:early.processed_event_id,
    final_processed_event_id:d.processed_event_id,handoff_event_id:early.event_id,completion_key:completionKey,
    completion,binding,terminal:{status:end.status,run_id:end.run_id}});
  covered.add(early.processed_event_id);
 }
 for(const d of documents){
  const id=d.processed_event_id,principal=d.principal_id,turn=d.content.app_event,proof=lineage.get(id);
  // Initial handoffs may retain only a notice; their final timeline and completed initial run are both required.
  if(kind==='call'&&turn.phase==='handoff'){assert(covered.has(id));continue;}
  const own=rows.filter(x=>x.processed_event_id===id&&x.kind==='owner'),reply=rows.filter(x=>x.processed_event_id===id&&x.kind==='yimi');
  assert(own.some(x=>x.text.trim()&&(kind!=='chat'||x.text===d.content.text))&&(r.errand||reply.some(x=>x.text.trim())));
  if(kind==='call')assert(d.device_id===r.device_id&&turn.user.trim()&&turn.assistant.trim()&&own.some(x=>x.text===turn.user)&&reply.some(x=>x.text===turn.assistant));
  const binding=proof?proof.binding:kind==='call'&&turn.route==='front_only'?{session_id:r.session_id}:
    await read('d-session-bindings',digest({principal_id:principal,processed_event_id:id}));
  if(kind==='chat'||turn.route!=='front_only'){
   const end=proof?proof.terminal:await read('run-terminals',digest({principal_id:principal,session_id:binding.session_id,processed_event_id:id}));
   assert(end.status==='completed'&&end.run_id&&(kind!=='chat'||end.run_id===r.run_id));
  }
  verified.push({processed_event_id:id,principal_id:principal,session_id:binding.session_id,route:turn?.route??'chat',
    ...(proof?{handoff_lineage:proof}:{}),timeline_seqs:[...own,...reply].map(x=>x.seq)});
 }
 if(r.errand){
  const e=r.errand,principal=verified[0].principal_id;
  const original=documents.find(d=>d.processed_event_id===r.processed_event_id);
  assert(original.origin==='explicit_user_prompt'&&original.content.text.includes(e.token));
  const d=await read('processed-events',digest({principal_id:principal,processed_event_id:e.processed_event_id})),job=d.content.app_event;
  assert(d.principal_id===principal&&d.device_id===original.device_id&&d.event_id===e.event_id&&e.event_id==='errand:'+e.job_id&&
    job.kind==='errand_result'&&job.job_id===e.job_id&&job.task.includes(e.token)&&job.success===true&&job.terminal_reason==='completed');
  const binding=await read('d-session-bindings',digest({principal_id:principal,processed_event_id:e.processed_event_id}));
  assert(binding.session_id===verified[0].session_id);
  const end=await read('run-terminals',digest({principal_id:principal,session_id:binding.session_id,processed_event_id:e.processed_event_id}));
  assert(end.status==='completed'&&end.run_id===e.run_id&&e.target_device_id===original.device_id&&e.status==='rendered');
  const journal=async(run)=>{const entries=[],scope=digest({principal_id:principal,run_id:run});
   for(let seq=0;;seq++){try{entries.push(await read('output-journal',digest({scope,seq})));}catch(error){if(error.code==='ENOENT')break;throw error;}}return entries;};
  const source=await journal(r.run_id),report=await journal(e.run_id),seal=report.find(x=>x.operation==='seal');
  assert(source.some(x=>x.operation==='seal'&&x.result.run_status==='completed'&&(x.result.reply_mode==='none'||x.result.reply_mode==='text'&&x.result.reply_text.trim())));
  assert(seal?.result.processed_event_id===e.processed_event_id&&seal.result.reply_text.trim()&&seal.result.reply_phase==='sealed'&&
    seal.result.reply_id===e.reply_id&&seal.result.reply_epoch===e.reply_epoch);
  assert(seal.chunks.length===e.highest_contiguous_seq&&seal.chunks.every(c=>['output_id','reply_id','reply_epoch','route_version','target_device_id','run_id','event_id'].every(k=>c[k]===e[k])));
  assert(report.some(x=>x.ack&&['output_id','reply_id','reply_epoch','route_version','target_device_id','highest_contiguous_seq'].every(k=>x.ack[k]===e[k])&&x.ack.status==='rendered'));
  assert(db.prepare('SELECT * FROM items WHERE principal_id=? AND processed_event_id=? AND kind=?').all(principal,e.processed_event_id,'yimi').some(x=>x.text===seal.result.reply_text));
 }
 const approvals=[];
 for(const step of r.approvals){
  const approval=await read('voice-confirmations',step.confirmation_id),decision=await read('voice-confirmation-decisions',step.confirmation_id);
  assert(approval.kind==='native_approval'&&approval.native_run_id===r.run_id&&approval.processed_event_id===r.processed_event_id&&
    approval.principal_id===verified[0].principal_id&&decision.choice==='once'&&decision.reason==='resolved'&&step.choice==='approve');
  approvals.push({confirmation_id:step.confirmation_id,request_id:approval.approval_request_id,run_id:approval.native_run_id,choice:decision.choice});
 }
 assert(verified.length>0);console.log(JSON.stringify({verified,approvals}));
}finally{db.close();await disk.close();}
""" % (I, I, I)
NATIVE = r"""
import json,os,pathlib,sqlite3,sys,time
assert os.environ.get('PAIOS_STAGE')=='staging'
rows=json.loads(sys.argv[1]);db=sqlite3.connect((pathlib.Path(os.environ['HERMES_HOME'])/'state.db').as_uri()+'?mode=ro',uri=True)
for row in rows:
 if row['route']!='front_only':continue
 end=time.monotonic()+30
 while True:
  saved=db.execute('SELECT content FROM messages WHERE platform_message_id=?',('paios-front:'+row['processed_event_id'],)).fetchall()
  if saved or time.monotonic()>=end:break
  time.sleep(.5)
 assert saved
 for (content,) in saved:
  d=json.loads(content);t=d['content']['app_event']
  assert d['processed_event_id']==row['processed_event_id'] and d['principal_id']==row['principal_id'] and t['user'].strip() and t['assistant'].strip()
print(json.dumps({'native_front_turns':sum(r['route']=='front_only' for r in rows)}))
"""


def staged(stack):
    if not stack.stage:
        raise ValueError('A staging Stack is required')
    for service in ('gateway-staging', 'hermes-staging'):
        if stack.definition['services'][service]['environment'].get('PAIOS_STAGE') != 'staging':
            raise ValueError('Staging service guard is required')


def captured(stack, command, evidence_file=None, **options):
    try:
        result = stack.run(command, **options)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        if evidence_file is not None:
            save_capture(evidence_file, error.stdout, error.stderr,
                         {'error_type': type(error).__name__, 'exit_code': getattr(error, 'returncode', None)})
        raise
    if evidence_file is not None:
        save_capture(evidence_file, result.stdout, result.stderr, {'exit_code': result.returncode})
    return result


def save_capture(prefix, stdout, stderr, status):
    for suffix, value in (('.stdout', stdout), ('.stderr', stderr),
                          ('.status.json', json.dumps(status))):
        path = prefix.with_name(prefix.name + suffix)
        path.write_bytes(value if isinstance(value, bytes) else (value or '').encode())
        path.chmod(0o600)


def execute(stack, command, service='gateway-staging', timeout=360, evidence_file=None):
    staged(stack)
    result = captured(stack, ['exec', '-T', service, 'python3' if service == 'gateway-staging' else
                        '/opt/hermes/.venv/bin/python', '-c', GUARD, *command],
                       capture_output=True, text=True, timeout=timeout, evidence_file=evidence_file)
    return json.loads(result.stdout)


def path(value):
    p = PurePosixPath(value)
    if not p.is_absolute() or '..' in p.parts:
        raise ValueError('Container fixture path must be absolute')
    return str(p)


def bootstrap(stack, config):
    """Explicit prepare step; caller restarts only gateway-staging afterwards."""
    fixture = config['turns']['bootstrap']
    args = ['--root', path(fixture['root']), '--config', '/etc/paios/cloud.json']
    execute(stack, ['node', G + '/tools/mac-product-provision.ts', 'migrate', *args])
    result = execute(stack, ['node', G + '/tools/mac-product-provision.ts', 'pair', *args,
                            '--registration', path(fixture['registration'])])
    if result['status'] != 'paired':
        raise ValueError('Staging fixture pairing failed')
    return {key: result[key] for key in ('status', 'device_id', 'pairing_file')}


def client(stack, config, kind, evidence_dir, *, prompt=None, confirmation=None, errand_token=None):
    mode = 'call' if kind == 'call' else 'chat'
    fixture = config['turns'][mode]
    args = ['node', G + '/tools/mac-product-sim-client.ts', '--regression-evidence',
            '--pairing', path(fixture['pairing']), '--recipient-key', path(fixture['recipient_key'])]
    # The fixture speech is not the owner's voiceprint: the dial call asks the phone to confirm it (Face ID).
    args += ['--prompt', prompt if prompt is not None else '请用文字简短确认：暂存环境对话回归。'] if mode == 'chat' else [
        '--call', '--speech', path(config['turns']['speech']), '--confirmation', 'approve']
    if errand_token is not None:
        args += ['--regression-errand-token', errand_token]
    if confirmation is not None:
        args += ['--confirmation', confirmation]
    target = evidence_dir / (kind + '.client.json')
    try:
        body = execute(stack, args, evidence_file=evidence_dir / (kind + ".client"))
    except subprocess.CalledProcessError as error:
        try:
            body = json.loads(error.stdout)
        except (TypeError, json.JSONDecodeError):
            body = {'error_type': 'ClientExitedWithoutJSON'}
        target.write_text(json.dumps(body, indent=2) + '\n')
        target.chmod(0o600)
        raise
    target.write_text(json.dumps(body, indent=2) + '\n')
    target.chmod(0o600)
    if not isinstance(body, dict) or not isinstance(body.get('steps'), list) or any(not isinstance(s, dict) for s in body['steps']):
        raise ValueError('Client did not return structured steps')
    steps = body['steps']
    for name, expected in [('bootstrap', 'bootstrap_accepted'), ('e2ee_key_resolve', 'key_resolved'),
                           ('credential_refresh', 'credential_refreshed'), ('end_continuity', 'success')]:
        if not any(s.get('step') == name and s.get('http') == 200 and s.get('status') == expected for s in steps):
            raise ValueError('Client lifecycle failed: ' + name)
    if kind == 'call' and not any(s.get('step') == 'speech_playback' and s.get('status') == 'played'
                                 and s.get('sent_samples', 0) > 0 and s.get('audible_samples', 0) > 0 for s in steps):
        raise ValueError('Recorded speech reply was not played')
    name = 'prompt_playback' if mode == 'chat' else 'call'
    receipt = next((s for s in steps if s.get('step') == name), None)
    if receipt is None:
        raise ValueError('Client completion receipt is missing')
    if receipt['status'] not in (('rendered', 'played') if mode == 'chat' else ('closed',)):
        raise ValueError('Client delivery did not complete')
    return {**receipt, 'approvals': [s for s in steps if s.get('step') == 'native_approval']}


def persisted(stack, kind, receipt, evidence_file=None):
    result = execute(stack, ['node', '--input-type=module', '-e', VERIFY, kind, json.dumps(receipt)], evidence_file=evidence_file)
    if kind == 'call':
        result.update(execute(stack, ['/opt/hermes/.venv/bin/python', '-c', NATIVE,
                                     json.dumps(result['verified'])], service='hermes-staging',
                              evidence_file=None if evidence_file is None else evidence_file.with_name(evidence_file.name + '.native')))
    return result


def run(stack, config, evidence_dir, record):
    results = {}
    for kind, check in [('chat', 'chat.accepted'), ('call', 'call.playback')]:
        receipt = record(check, lambda k=kind: client(stack, config, k, evidence_dir))
        if receipt is None:
            continue
        results[check] = receipt
        if kind == 'call':
            record('call.closed', lambda: {'call_id': receipt['call_id'], 'status': receipt['status']})
        name = 'chat.timeline' if kind == 'chat' else 'call.settlement'
        results[name] = record(name, lambda k=kind, r=receipt, n=name: persisted(stack, k, r, evidence_file=evidence_dir / n))
    return results
