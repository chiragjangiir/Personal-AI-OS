import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {ContractError} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {L3Service} from '../src/memory/l3.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {sourceClient,PersonalAIOSRuntime,type NativeRun} from './native-source-fixture.ts';
import {canonical,sha256,type ProcessedEvent} from '../src/contracts.ts';
import {FormalSourceAuthority} from '../../../phase0/gateway/src/personal-aios-formal-source.ts';
import {createFormalTextIngress,FORMAL_TEXT_INPUT_TOPIC} from '../../../phase0/gateway/src/personal-aios-formal-text.ts';
import type {RealtimeBootstrapConnectedInput} from '../../../phase0/gateway/src/realtime-public-control-runtime.ts';
import type {RealtimeCurrentBindingProjection} from '../../realtime-core/src/types.ts';
import type {LiveKitCloudParticipantPort} from '../../../phase0/gateway/src/livekit-cloud-participant.ts';
import {commandDigest,type AssertionInput,type EvidenceRef,type L3Receipt} from '../src/memory/contracts.ts';
const require=createRequire(new URL('../../platform-data/package.json',import.meta.url));
const {Pool}=require('pg') as {Pool:new(c:Record<string,unknown>)=>ConstructorParameters<typeof L3Service>[0]};
const database=process.env.PAIOS_L3_TEST_DATABASE_URL;
async function until<T>(read:()=>Promise<T|undefined>){for(let n=0;n<200;n++){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error('OWNED_BINDING_TIMEOUT');}
test('trusted source decision → app D → original serial admission → referenced native tool → real L3 receipt', {skip:!database,timeout:20000},async t=>{
 const url=new URL(database!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55439');assert.equal(url.username,'l3test');
 const admin=new Pool({connectionString:database,max:1,connectionTimeoutMillis:1000});
 const identity=await admin.query("SELECT current_user,current_database(),inet_server_port() AS port,version() AS version");
 assert.equal(identity.rows[0].current_user,'l3test');assert.equal(identity.rows[0].port,55439);assert.match(identity.rows[0].version,/PostgreSQL 18/);
 console.info('owned_pg_identity',JSON.stringify(identity.rows[0]));
 const schema=`l3_decision_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:2});
 const root=await mkdtemp(join(tmpdir(),'l3-decision-'));const storage=new PosixStorage(root),archive=new RawArchive(storage,16384);const l3=new L3Service(pool);
 let runtime:PersonalAIOSRuntime|undefined;
 let assembly:ReturnType<typeof createPersonalAIOSAssembly>|undefined;
 try {
  await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf8'));
  const runs:NativeRun[]=[],inputs:{d:ProcessedEvent;grant:boolean}[]=[];
  const native={create:async(body:{input:string;session_id:string})=>{const run={run_id:`native-${runs.length}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.push(run);inputs.push({d:JSON.parse(body.input),grant:Object.hasOwn(body,'memory_write')});return {...run};},status:async(id:string)=>({...runs.find(r=>r.run_id===id)!}),cancel:async(id:string)=>{const run=runs.find(r=>r.run_id===id)!;run.status='cancelled';return {...run};}};
  const admission={max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'owned-memory'};
  const sessionRef={ref_type:'realtime_session',ref_id:'session-ref'},leaseRef={ref_type:'device_lease',ref_id:'lease-ref'};
  const bootstrap={request:{request_id:'bootstrap'},bearer:{principal:{opaque_ref:'fixture'},deviceId:'mac'},governance:{accepted:true},authority:{gateway:{identity:'fixture',roomName:'room'}},currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'session',connectionEpoch:'1',credentialRoom:'room',credentialIdentity:'terminal'},enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const current={session:{realtimeSessionRef:sessionRef,userId:'owner',continuityId:'session',state:'active',continuityState:'active',connectionEpoch:'1',continuityExpiresAt:'2099-01-01T00:00:00.000Z',activeDeviceId:'mac',activeDeviceLeaseRef:leaseRef,binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'session',deviceId:'mac',connectionEpoch:'1'}},lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'session',userId:'owner',deviceId:'mac',state:'active',expiresAt:'2099-01-01T00:00:00.000Z',leaseVersion:'1',fencingToken:'1'}} as unknown as RealtimeCurrentBindingProjection;
  let authorized=true;
  const authority=new FormalSourceAuthority({ownerContext:{resolve:async()=>({userId:'owner',deviceId:'mac',purpose:'typed-submit',capabilities:['data'],occurredAt:new Date().toISOString() as never})},readCurrentBinding:async()=>{if(!authorized)throw Error('CURRENT_AUTH_UNAVAILABLE');return current;},sameRef:(a,b)=>canonical(a)===canonical(b),resolveSource:async()=>({device_type:'phone',channel:'text',consent_ref:'source',route_version:'route',output_modes:['text']})});
  assembly=createPersonalAIOSAssembly({storage,archive,admission,native:sourceClient(native),l3,max_event_bytes:16384,http:{internal_token:'controlled-internal-token-abcdefghijklmnop',max_request_bytes:16384,request_timeout_ms:1000},sourceAuthority:authority,skill:'fixed memory source skill',max_read_bytes:16384});runtime=assembly.runtime;
  await new Promise<void>(resolve=>assembly!.server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${(assembly.server.address() as AddressInfo).port}`;
  async function tool(name:string,call:Parameters<PersonalAIOSRuntime['tool']>[1]){
    const response=await fetch(`${endpoint}/internal/hermes/tools/${name}`,{method:'POST',headers:{authorization:'Bearer controlled-internal-token-abcdefghijklmnop','content-type':'application/json'},body:JSON.stringify(call),signal:AbortSignal.timeout(3000)});
    const value=await response.json() as any;if(!response.ok)throw new ContractError(value.error_code,response.status);return value;
  }
  const schemaResponse=await fetch(`${endpoint}/internal/hermes/tool-contracts`,{headers:{authorization:'Bearer controlled-internal-token-abcdefghijklmnop'}});
  assert.equal(schemaResponse.status,200);const schemas=await schemaResponse.json() as any[];
  await writeFile(join(root,'native-tool-schemas.json'),JSON.stringify(schemas));
  const commitSchema=schemas.find(t=>t.name==='paios_l3_commit');assert.equal(commitSchema.parameters.oneOf.length,2);
  const owner=runtime,source=await owner.authenticate(authority.credentialForBootstrap(bootstrap));
  const initial=await owner.submit({schema_version:'paios.event.v1',event_id:'origin',device_id:'mac',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('explicit original')},source,'session',false);
  const d=initial.processed_event;await until(async()=>(await owner.event(source,'session',d.processed_event_id)).admission.run_id);
  const evidence:EvidenceRef={event_id:d.event_id,processed_event_id:d.processed_event_id,raw_ref:d.raw_ref,archive_revision:d.archive_revision,time_range:d.time_range,native_session_id:'session'};
  const a:AssertionInput={assertion_id:'assertion',kind:'inference',subject_ref:{type:'unknown_subject',id:'observed-person'},predicate:'role',value:'designer',scope:{principal_id:'owner',purpose:'advice',situation:'work',role:'design',evaluation_frame:'business'},evidence_refs:[evidence],evidence_status:'available',unknown_conditions:[],conflicts:[],status:'active',applicability_status:'applicable',relation_to_peers:'independent',typed_scores:{},depends_on:[]};
  const command={command_id:'command',operation:'create' as const,expected_version:0,assertion:a,evidence_refs:[evidence]};
  const call={context:{run_id:'native-0',session_id:'session',tool_call_id:'proposal'},args:command};
  const pending=await tool('paios_l3_commit',call) as {status:string;proposal_ref:string;payload_sha256:string};assert.equal(pending.status,'pending_approval');assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'0');
  const {DataPacketKind,RoomEvent}=createRequire(new URL('../../../phase0/gateway/package.json',import.meta.url))('@livekit/rtc-node');
  const callbacks=new Map<string,(...args:readonly unknown[])=>void>(),published:Record<string,any>[]=[];
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:readonly unknown[])=>void)=>callbacks.set(event,fn),off:(event:string)=>callbacks.delete(event),localParticipant:{sendText:async()=>{},publishData:async(bytes:Uint8Array)=>{published.push(JSON.parse(Buffer.from(bytes).toString()));}}};
  const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime:owner,authority,max_packet_bytes:32768,onError:()=>{}});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(bootstrap);
  async function send(body:Record<string,unknown>, operation:string){
    const before=published.length;
    callbacks.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    return (await until(async()=>published.slice(before).find(packet=>packet.operation===operation &&
      packet.session_id==='session' && (body.control_id ? packet.control_id===body.control_id :
        packet.processed_event_id===body.processed_event_id))))!;
  }
  const view=await send({operation:'memory_proposals',control_id:'view',processed_event_id:d.processed_event_id},'memory_proposals');assert.equal(view.operation,'memory_proposals');assert.equal(view.session_id,'session');assert.equal(view.proposals[0].command.command_id,'command');
  const badWire=await send({operation:'memory_decide',processed_event_id:d.processed_event_id,control_id:'bad-wire',command_id:'command',payload_sha256:pending.payload_sha256,decision:'approve',principal_id:'forged'},'rejected');assert.equal(badWire.operation,'rejected');assert.equal(badWire.error_code,'FORMAL_MEMORY_ARGUMENT_INVALID');
  const request={command_id:'command',payload_sha256:pending.payload_sha256,decision:'approve' as const,control_id:'click'};
  await assert.rejects(owner.decideMemory({...source},'session',d.processed_event_id,request),/PROVENANCE_REQUIRED/);
  await assert.rejects(owner.decideMemory(source,'other',d.processed_event_id,request),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT');
  await assert.rejects(owner.decideMemory(source,'session',d.processed_event_id,{...request,payload_sha256:'0'.repeat(64)}),/DIGEST_MISMATCH/);
  const response=await send({operation:'memory_decide',processed_event_id:d.processed_event_id,...request},'memory_decision');assert.equal(response.operation,'memory_decision');assert.equal(response.control_id,'click');
  const decision=response.outcome as Awaited<ReturnType<PersonalAIOSRuntime['decideMemory']>>;assert.equal(decision.status,'decision_recorded');assert.equal(runs.length,1);
  assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'0');
  assert.ok('accepted' in decision);if(!('accepted' in decision))throw Error('unexpected already committed');
  const newD=decision.accepted.processed_event;assert.equal(newD.origin,'device_observation');assert.equal(newD.user_identity,'unknown');assert.equal(newD.media_type,'app_event');assert.equal(newD.intent_class,'observation');
  const acceptedFrame=await until(async()=>published.find(packet=>packet.operation==='accepted' &&
    packet.session_id==='session' && packet.event_id===newD.event_id && packet.processed_event_id===newD.processed_event_id));
  assert.ok(acceptedFrame);assert.ok(published.indexOf(acceptedFrame)>published.indexOf(response));
  assert.equal(acceptedFrame.admission.idempotency_key,decision.accepted.admission.idempotency_key);
  assert.equal(acceptedFrame.admission.state,decision.accepted.admission.state);
  const retry=await owner.decideMemory(source,'session',d.processed_event_id,request);assert.ok('accepted' in retry);if('accepted' in retry)assert.deepEqual(retry.accepted.processed_event,newD);assert.equal(runs.length,1);assert.equal((await storage.list(pending.proposal_ref.split(':')[1]!.replace('mp-','md-'))).length,1);
  await assert.rejects(owner.decideMemory(source,'session',d.processed_event_id,{...request,decision:'reject'}),/DECISION_CONFLICT/);
  Object.assign(runs[0]!,{status:'completed',output:'original reply'});await until(async()=>(await owner.event(source,'session',newD.processed_event_id)).admission.run_id);assert.equal(runs.length,2);assert.equal(inputs[1]!.grant,false);assert.equal(inputs[1]!.d.processed_event_id,newD.processed_event_id);
  const references={proposal_ref:decision.proposal_ref,decision_ref:decision.decision.decision_ref};
  assert.deepEqual(await tool('paios_l3_commit',{context:{run_id:'native-0',session_id:'session',tool_call_id:'wrong-D'},args:references}),{status:'pending',error_code:'RUN_BINDING_PENDING'});
  assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'0');
  const nullSubject=await tool('paios_l3_commit',{context:{run_id:'native-1',session_id:'session',tool_call_id:'invalid-subject'},args:{...command,command_id:'invalid-subject',assertion:{...a,subject_ref:{type:'unknown_subject',id:null},status:'candidate'}}}) as any;
  console.info('original_no_ref_shape_response',JSON.stringify(nullSubject));
  assert.equal(nullSubject.status,'rejected');assert.equal(nullSubject.error_code,'MEM_INVALID_ASSERTION');assert.equal(nullSubject.http_status,400);
  assert.ok(nullSubject.field_errors.some((field:any)=>field.path==='assertion.subject_ref.id' && field.reason==='type'));
  assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'0');
  await assert.rejects(tool('paios_l3_commit',{context:{run_id:'native-1',session_id:'session',tool_call_id:'no-ref'},args:{...command,command_id:'forged',assertion:{...a,subject_ref:{type:'unknown_subject',id:'unknown'},status:'candidate'}}}),/MEM_DECISION_REFERENCE_REQUIRED/);
  assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'0');
  const commitCall={context:{run_id:'native-1',session_id:'session',tool_call_id:'actual-native-tool'},args:references};
  const receipt=await tool('paios_l3_commit',commitCall) as L3Receipt;assert.equal(receipt.status,'committed');assert.equal(receipt.version,1);
  assert.deepEqual(await tool('paios_l3_commit',commitCall),receipt);
  assert.deepEqual(await tool('paios_l3_commit',{context:commitCall.context,args:command}),receipt);
  const sql=await pool.query(`SELECT r.run_id,p.command_payload FROM paios_l3_receipts r JOIN paios_l3_payloads p ON r.principal_id=p.principal_id AND r.command_id=p.command_payload->>'command_id'`);assert.equal(sql.rows.length,1);assert.equal(sql.rows[0].run_id,'native-1');assert.deepEqual(sql.rows[0].command_payload,{...command,payload_sha256:pending.payload_sha256});
  assert.equal((await owner.memoryProposals(source,'session',d.processed_event_id))[0]!.receipt!.receipt_ref,receipt.receipt_ref);
  await tool('paios_open_reply',{context:{run_id:'native-1',session_id:'session',tool_call_id:'final-open'},args:{reply_mode:'text',receipt_refs:[receipt.receipt_ref]}});
  Object.assign(runs[1]!,{status:'completed',output:'controlled native reply after actual commit'});
  const result=await owner.result(source,'session',newD.processed_event_id);assert.equal(result.result.reply_text,'controlled native reply after actual commit');assert.ok(result.result.receipt_refs.includes(receipt.receipt_ref));assert.equal(runs.length,2);
  const header=await until(async()=>published.find(packet=>packet.operation==='result_header' && packet.processed_event_id===newD.processed_event_id));
  assert.equal(header!.run_id,'native-1');assert.ok(header!.receipt_refs.includes(receipt.receipt_ref));
  const packet=await until(async()=>published.find(packet=>packet.operation==='text_chunk' && packet.processed_event_id===newD.processed_event_id));
  assert.equal(packet!.chunk.text,'controlled native reply after actual commit');
  const chunk=packet!.chunk;
  const ack=await send({operation:'ack',processed_event_id:newD.processed_event_id,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,route_version:chunk.route_version,target_device_id:chunk.target_device_id,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:new Date().toISOString()}},'ack_receipt');
  assert.equal(ack.operation,'ack_receipt');assert.equal(ack.receipt.status,'rendered');assert.equal(runs.length,2);
  // Already committed decision returns the original SQL receipt, without new D/run or changing run attribution.
  const replay=await owner.decideMemory(source,'session',d.processed_event_id,request);assert.equal(replay.status,'already_committed');assert.equal(runs.length,2);assert.equal((await pool.query('SELECT run_id FROM paios_l3_receipts')).rows[0].run_id,'native-1');
  // Legacy proposals are retained but cannot acquire a guessed origin binding.
  const key=sha256(canonical({principal_id:'owner',command_id:'legacy'}));
  await storage.publish('memory-proposals',key,Buffer.from(canonical({principal_id:'owner',command:{...command,command_id:'legacy',payload_sha256:commandDigest({...command,command_id:'legacy'})},context_ref:'old'})));
  await assert.rejects(owner.decideMemory(source,'session',d.processed_event_id,{...request,command_id:'legacy'}),/BINDING_NOT_SUPPORTED/);assert.equal((await owner.memoryProposals(source,'session',d.processed_event_id)).some(v=>v.command.command_id==='legacy'),false);assert.ok(await storage.read('memory-proposals',key));
  for(const kind of ['reject','conflict','cancel','unknown'] as const){
    const submitted=await owner.submit({schema_version:'paios.event.v1',event_id:`origin-${kind}`,device_id:'mac',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(`explicit ${kind}`)},source,'session',false);
    const origin=submitted.processed_event;const originalRun=await until(async()=>(await owner.event(source,'session',origin.processed_event_id)).admission.run_id);
    const e={...evidence,event_id:origin.event_id,processed_event_id:origin.processed_event_id,raw_ref:origin.raw_ref,archive_revision:origin.archive_revision,time_range:origin.time_range};
    const proposed={...command,command_id:`command-${kind}`,operation:kind==='conflict'?'correct' as const:'create' as const,assertion:{...a,assertion_id:kind==='conflict'?'assertion':`assertion-${kind}`,evidence_refs:[e]},evidence_refs:[e]};
    const staged=await tool('paios_l3_commit',{context:{run_id:originalRun,session_id:'session',tool_call_id:'propose'},args:proposed}) as typeof pending;assert.equal(staged.status,'pending_approval');
    const choice={command_id:proposed.command_id,payload_sha256:staged.payload_sha256,decision:kind==='reject'?'reject' as const:'approve' as const,control_id:`click-${kind}`};
    const publish=storage.publish.bind(storage);
    if(kind==='unknown'){
      storage.publish=async(namespace,key,bytes)=>{if(namespace==='processed-events')throw Error('CONTROLLED_EXECUTION_EIO');return publish(namespace,key,bytes);};
      try {const failed=await owner.decideMemory(source,'session',origin.processed_event_id,choice);assert.equal(failed.status,'decision_recorded');assert.ok('execution' in failed);if('execution' in failed)assert.equal(failed.execution.status,'unknown');assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'1');}
      finally {storage.publish=publish;}
    }
    const chosen=await owner.decideMemory(source,'session',origin.processed_event_id,choice);assert.ok('accepted' in chosen);if(!('accepted' in chosen))throw Error('unexpected receipt');
    // A live unrelated origin cannot claim the authorization by printing reference JSON.
    await assert.rejects(tool('paios_l3_commit',{context:{run_id:originalRun,session_id:'session',tool_call_id:'bad-reference'},args:{proposal_ref:chosen.proposal_ref,decision_ref:chosen.decision.decision_ref}}),/D_BINDING_DENIED/);
    Object.assign(runs.find(r=>r.run_id===originalRun)!,{status:'completed',output:'origin ended'});
    const decisionRun=await until(async()=>(await owner.event(source,'session',chosen.accepted.processed_event.processed_event_id)).admission.run_id);
    const args={proposal_ref:chosen.proposal_ref,decision_ref:chosen.decision.decision_ref};
    const resolved=()=>tool('paios_l3_commit',{context:{run_id:decisionRun,session_id:'session',tool_call_id:'resolved'},args});
    if(kind==='reject')await assert.rejects(tool('paios_l3_commit',{context:{run_id:decisionRun,session_id:'session',tool_call_id:'reject-bypass'},args:{...proposed,command_id:'reject-bypass',assertion:{...proposed.assertion,subject_ref:{type:'unknown_subject',id:'unknown'},status:'candidate'}}}),/MEM_DECISION_REFERENCE_REQUIRED/);
    if(kind==='cancel'){
      const remove=storage.removePending.bind(storage);let release!:()=>void;let held=false;
      const gate=new Promise<void>(resolve=>release=resolve);
      storage.removePending=async key=>{held=true;await gate;return remove(key);};
      try {await owner.cancelRun(source,'session',chosen.accepted.processed_event.processed_event_id);
      await until(async()=>held && (await owner.event(source,'session',chosen.accepted.processed_event.processed_event_id)).admission.state==='cancelled'?true:undefined);
      assert.deepEqual(await resolved(),{status:'pending',error_code:'RUN_BINDING_PENDING'});
      const count:number=runs.length;
      const replay=await owner.decideMemory(source,'session',origin.processed_event_id,choice);
      assert.ok('accepted' in replay);if('accepted' in replay)assert.equal(replay.accepted.admission.state,'cancelled');assert.equal(runs.length,count);
      assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'1');
      } finally {release();storage.removePending=remove;}
      continue;
    }
    if(kind==='unknown'){assert.equal((await resolved() as L3Receipt).status,'committed');assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'2');}
    else {await assert.rejects(resolved(),kind==='reject'?/PROPOSAL_REJECTED/:/VERSION_CONFLICT/);assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'1');}
    assert.equal(inputs.find(row=>row.d.processed_event_id===chosen.accepted.processed_event.processed_event_id)!.grant,false);
    Object.assign(runs.find(r=>r.run_id===decisionRun)!,{status:'completed',output:'controlled failure or rejection'});
    await until(async()=>{const event=await owner.event(source,'session',chosen.accepted.processed_event.processed_event_id);return event.admission.state==='completed'?true:undefined;});
  }
  // The original immutable proposal must stop exposing its payload after the L3 head is tombstoned.
  const deletion={command_id:'formal-delete',operation:'delete' as const,expected_version:1,assertion:a,evidence_refs:[evidence]};
  const erased=await l3.commit({...deletion,payload_sha256:commandDigest(deletion)},
    {authenticated:true,principal_id:'owner',run_id:'isolated-delete',context_ref:'explicit-fixture-delete',authorize:async()=>true,evidenceAvailable:async()=>true});
  assert.equal(erased.status,'committed');
  assert.deepEqual(await owner.memoryProposals(source,'session',d.processed_event_id),[]);
  const hidden=await send({operation:'memory_proposals',control_id:'view-deleted',processed_event_id:d.processed_event_id},'memory_proposals');
  assert.deepEqual(hidden.proposals,[]);
  authorized=false;await assert.rejects(owner.memoryProposals(source,'session',d.processed_event_id),/CURRENT_AUTH_UNAVAILABLE/);authorized=true;
  console.info('owned_schema',schema,'SQL_receipts',(await pool.query('SELECT count(*) FROM paios_l3_receipts')).rows[0].count,'native_creates',runs.length,'model_calls',0);
 } finally {await assembly?.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});console.info('owned_schema_removed',schema);}
});
