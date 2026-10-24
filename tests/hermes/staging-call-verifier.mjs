// Execute canonical VERIFY with in-memory storage/SQLite ports; no product identities are synthesized.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync(process.argv[2],'utf8'),digest=JSON.stringify;
async function check(name,change,accept=true,kind='call'){
  const base={principal_id:'owner',device_id:'phone',scope:'owner'};
  const turn={kind:'voice_turn',call_id:'call',turn:1,speaker:'owner',route:'handoff',user:'request'};
  const early={...base,processed_event_id:'early',event_id:'event:handoff',content:{app_event:{...turn,phase:'handoff',assistant:''}}};
  const final={...base,processed_event_id:'final',event_id:'event',content:{app_event:{...turn,phase:'complete',handoff_event_id:early.event_id,assistant:'audible reply'}}};
  const guest={...base,scope:'guest',processed_event_id:'guest',event_id:'guest-event',content:{app_event:{...turn,turn:2,speaker:'unknown'}}};
  const greeting={...base,processed_event_id:'greeting',event_id:'greeting-event',content:{app_event:{...turn,turn:0,route:'front_only',user:'',assistant:'hello'}}};
  const rows=[{principal_id:'owner',processed_event_id:'early',kind:'notice',text:'background task',seq:1},
    {principal_id:'owner',processed_event_id:'final',kind:'owner',text:turn.user,seq:2},
    {principal_id:'owner',processed_event_id:'final',kind:'yimi',text:'audible reply',seq:3},
    {principal_id:'owner',processed_event_id:'guest',kind:'notice',text:'unconfirmed speech',seq:4},
    {principal_id:'owner',processed_event_id:'greeting',kind:'yimi',text:'hello',seq:5}];
  const data=new Map(),key=(ns,id)=>ns+':'+id,put=(ns,id,value)=>data.set(key(ns,digest(id)),value);
  for(const d of [early,final,guest,greeting])put('processed-events',{principal_id:'owner',processed_event_id:d.processed_event_id},d);
  const completion={processed_event_id:'final'},terminal={status:'completed',run_id:'native-run'};
  put('call-handoff-completions',{principal_id:'owner',event_id:early.event_id},completion);
  put('d-session-bindings',{principal_id:'owner',processed_event_id:'early'},{session_id:'session'});
  put('run-terminals',{principal_id:'owner',session_id:'session',processed_event_id:'early'},terminal);
  const receipt={principal_id:'owner',device_id:'phone',session_id:'session',call_id:'call',turns:[2,3,1],approvals:[],
    processed_event_id:'final',event_id:'event',run_id:'native-run'};
  const simple=(route)=>{
    rows.splice(0,rows.length,...rows.filter(r=>r.processed_event_id==='final'));
    final.content.app_event={...turn,route,assistant:'audible reply'};
    put('d-session-bindings',{principal_id:'owner',processed_event_id:'final'},{session_id:'session'});
    put('run-terminals',{principal_id:'owner',session_id:'session',processed_event_id:'final'},terminal);
  };
  change?.({early,final,guest,rows,data,key,put,completion,terminal,receipt,simple});
  const reads=[],output=[];
  const context=vm.createContext({Buffer,console:{log:s=>output.push(JSON.parse(s))},
    process:{argv:['node',kind,JSON.stringify(receipt)],env:{PAIOS_STAGE:'staging'}}});
  class Storage{
    async read(ns,id){reads.push([ns,id]);if(!data.has(key(ns,id)))throw Object.assign(Error('ENOENT'),{code:'ENOENT'});return Buffer.from(JSON.stringify(data.get(key(ns,id))));}
    async close(){}
  }
  class Database{prepare(){return {all:()=>rows};}close(){}}
  const exports={DatabaseSync:Database,join:(...x)=>x.join('/'),setTimeout:async()=>{},
    loadHostConfiguration:async()=>({storage_root:'/fixture'}),PosixStorage:Storage,digest,runScope:d=>d.scope};
  const module=new vm.SourceTextModule(source,{context});
  await module.link(async spec=>{
    const names=spec==='node:sqlite'?['DatabaseSync']:spec==='node:path'?['join']:spec==='node:timers/promises'?['setTimeout']:
      spec.endsWith('/contracts.ts')?['digest','runScope']:spec.endsWith('/storage.ts')?['PosixStorage']:['loadHostConfiguration'];
    return new vm.SyntheticModule(names,function(){for(const n of names)this.setExport(n,exports[n]);},{context});
  });
  let failure;try{await module.evaluate();}catch(error){failure=error;}
  if(accept){
    assert.equal(failure,undefined,name);assert.equal(output[0].verified.length,1);
    const result=output[0].verified[0];assert.equal(result.processed_event_id,'final');
    if(final.content.app_event?.phase==='complete'){
      assert.equal(result.handoff_lineage.initial_processed_event_id,'early');
      assert.equal(result.handoff_lineage.terminal.run_id,'native-run');
      assert(!reads.some(([ns,id])=>ns==='d-session-bindings'&&id===digest({principal_id:'owner',processed_event_id:'final'})));
    }
  }else assert(failure,name+' must reject');
  console.log(JSON.stringify({name,expected_accept:accept,status:'passed'}));
}
await check('initial notice covered by final timeline and completed early run; guest/greeting ignored');
await check('missing completion',f=>f.data.delete(f.key('call-handoff-completions',JSON.stringify({principal_id:'owner',event_id:f.early.event_id}))),false);
await check('wrong completion target',f=>f.completion.processed_event_id='other',false);
await check('wrong initial device',f=>f.early.device_id='other',false);
await check('wrong initial call',f=>f.early.content.app_event.call_id='other',false);
await check('wrong initial turn',f=>f.early.content.app_event.turn=9,false);
await check('wrong initial speaker',f=>f.early.content.app_event.speaker='unknown',false);
await check('wrong initial principal',f=>f.early.principal_id='other',false);
await check('missing initial binding',f=>f.data.delete(f.key('d-session-bindings',JSON.stringify({principal_id:'owner',processed_event_id:'early'}))),false);
await check('initial terminal not completed',f=>f.terminal.status='running',false);
await check('wrong final timeline reply',f=>f.rows[2].text='unrelated',false);
await check('orphan initial notice',f=>f.rows.splice(1,2),false);
await check('missing stored initial D',f=>f.data.delete(f.key('processed-events',JSON.stringify({principal_id:'owner',processed_event_id:'early'}))),false);
await check('front_only preserves original timeline contract',f=>f.simple('front_only'));
await check('ordinary handoff preserves own binding',f=>f.simple('handoff'));
await check('chat preserves original event/run contract',f=>{f.simple('handoff');f.final.content={text:'request'};},true,'chat');
await check('chat rejects different native run',f=>{f.simple('handoff');f.final.content={text:'request'};f.receipt.run_id='other';},false,'chat');
