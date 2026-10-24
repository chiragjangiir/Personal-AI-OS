// Ambient journal (SQLite, owner-only) and the ambient lane's wake rules on synthetic captured-speech D: conversation
// boundaries, queries over time / speaker / text, read-time names, wake stripping, the next-utterance rule and context.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AmbientJournal,parseAmbientPolicy} from '../src/ambient/journal.ts';
import {AmbientLane,resolveSpeaker,speakerNames,stripWake,utterances} from '../src/ambient/lane.ts';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import type {ProcessedEvent} from '../src/contracts.ts';

const T0=Date.parse('2026-10-09T08:00:00.000Z');
async function open(t:test.TestContext,policy={}) {
  const directory=await mkdtemp(join(tmpdir(),'paios-ambient-journal-'));
  const journal=AmbientJournal.open(join(directory,'ambient-journal'),policy);
  t.after(async()=>{journal.close();await rm(directory,{recursive:true,force:true});});
  return {directory,journal,lane:new AmbientLane<string>(journal)};
}

test('the previous release still reads the journal: label v2, and a v3 file is labelled back',async t=>{
  const {directory,journal}=await open(t);journal.close();
  const file=join(directory,'ambient-journal','journal.sqlite');
  const label=()=>{const db=new DatabaseSync(file);try{return (db.prepare("SELECT value FROM meta WHERE key='schema'").get() as {value:string}).value;}finally{db.close();}};
  assert.equal(label(),'paios.ambient-journal.v2');
  const db=new DatabaseSync(file);db.exec("UPDATE meta SET value='paios.ambient-journal.v3' WHERE key='schema'");db.close();
  AmbientJournal.open(join(directory,'ambient-journal')).close();
  assert.equal(label(),'paios.ambient-journal.v2');
});
/** `wake`: the spotter heard 依米, ending at that fraction of the utterance (1: the wake word was all that was said). */
type Spoken={at:number;ms?:number;text:string;speaker?:string;wake?:number;lang?:string};
let serial=0;
/** A continuous D whose local transcription heard these utterances (times relative to T0, in ms). */
function heard(spoken:Spoken[],device='glasses',principal='owner'):ProcessedEvent {
  const id=++serial,range=(s:Spoken)=>({kind:'interval',timebase_id:'utc_epoch_ms',start_ms:T0+s.at,end_ms:T0+s.at+(s.ms??2000)});
  return {principal_id:principal,device_id:device,processed_event_id:`processed:${id}`,raw_ref:`l5:${'a'.repeat(64)}`,archive_revision:'b'.repeat(64),
    segment_id:`segment:${id}`,time_range:{...range(spoken[0]!),end_ms:range(spoken.at(-1)!).end_ms},
    content:{transcript:spoken.map(s=>s.text).join(''),audio_observations:[{observation_kind:'sample_transcription',segments:spoken.map(s=>({
      start_sample:0,end_sample_exclusive:16000,text:s.text,...(s.speaker?{speaker:s.speaker,identity_scope:'local_voiceprint',speaker_score:0.8}:{}),
      ...(s.wake!==undefined?{wake:{keyword:'依米',end_sample:Math.round(16000*s.wake)}}:{}),...(s.lang?{lang:s.lang}:{}),
      source_parts:[{clipped_scope_range:range(s)}]}))}]},speakers:[]} as unknown as ProcessedEvent;
}

test('journal is owner-only, append-only and splits conversations at the configured silence gap',async t=>{
  const {directory,journal}=await open(t,{conversation_gap_ms:60000});
  assert.equal((await stat(join(directory,'ambient-journal'))).mode&0o777,0o700);
  assert.equal((await stat(join(directory,'ambient-journal','journal.sqlite'))).mode&0o777,0o600);
  const lane=new AmbientLane<string>(journal);
  lane.observe(heard([{at:0,text:'今天下午去开会',speaker:'owner'}]),'host');
  lane.observe(heard([{at:30000,text:'好的我知道了',speaker:'speaker:3'}]),'host');
  lane.observe(heard([{at:30000+2000+60001,text:'晚上吃什么',speaker:'owner'}]),'host');
  lane.observe(heard([{at:500000,text:'另一台设备',speaker:'owner'}],'phone'),'host');
  const rows=journal.search({principal_id:'owner',limit:10}).entries.reverse();
  assert.deepEqual(rows.map(r=>r.text),['今天下午去开会','好的我知道了','晚上吃什么','另一台设备']);
  assert.equal(rows[0]!.conversation_id,rows[1]!.conversation_id);
  assert.notEqual(rows[2]!.conversation_id,rows[1]!.conversation_id);
  assert.notEqual(rows[3]!.conversation_id,rows[2]!.conversation_id);
  const db=new DatabaseSync(join(directory,'ambient-journal','journal.sqlite'));t.after(()=>db.close());
  assert.throws(()=>db.exec("UPDATE entries SET text='x'"),/AMBIENT_JOURNAL_APPEND_ONLY/);
  assert.throws(()=>db.exec('DELETE FROM entries'),/AMBIENT_JOURNAL_APPEND_ONLY/);
  // A repeated D returns its stored rows; reopening keeps them.
  const again=journal.entriesOf('owner',rows[0]!.processed_event_id);assert.equal(again.length,1);
  journal.close();const reopened=AmbientJournal.open(join(directory,'ambient-journal'));t.after(()=>reopened.close());
  assert.equal(reopened.search({principal_id:'owner',limit:10}).entries.length,4);
  assert.throws(()=>parseAmbientPolicy({conversation_gap_ms:0}),/AMBIENT_POLICY_INVALID/);
  assert.throws(()=>parseAmbientPolicy({unknown:1}),/AMBIENT_POLICY_INVALID/);
});

test('journal queries: time range, speaker, trigram and short text terms, limit, principal isolation',async t=>{
  const {journal,lane}=await open(t);
  lane.observe(heard([{at:0,text:'明天我们去吃火锅吧',speaker:'owner',lang:'zh'}]),'host');
  lane.observe(heard([{at:10000,text:'老王说火锅店在人民广场',speaker:'speaker:7'}]),'host');
  lane.observe(heard([{at:20000,text:'我想吃面条'}]),'host');
  lane.observe(heard([{at:30000,text:'别人的火锅'}],'glasses','stranger'),'host');
  const texts=(q:Parameters<AmbientJournal['search']>[0])=>journal.search(q).entries.map(e=>e.text);
  assert.deepEqual(texts({principal_id:'owner',text:'火锅',limit:10}),['老王说火锅店在人民广场','明天我们去吃火锅吧']);
  assert.deepEqual(texts({principal_id:'owner',text:'人民广场',limit:10}),['老王说火锅店在人民广场']);
  assert.deepEqual(texts({principal_id:'owner',text:'火锅 人民广场',limit:10}),['老王说火锅店在人民广场']);
  assert.deepEqual(texts({principal_id:'owner',speakers:['speaker:7'],limit:10}),['老王说火锅店在人民广场']);
  assert.deepEqual(texts({principal_id:'owner',speakers:['unknown'],limit:10}),['我想吃面条']);
  assert.deepEqual(texts({principal_id:'owner',from_ms:T0+5000,until_ms:T0+25000,limit:10}),['我想吃面条','老王说火锅店在人民广场']);
  const page=journal.search({principal_id:'owner',limit:2});assert.equal(page.entries.length,2);assert.equal(page.truncated,true);
  assert.equal(journal.search({principal_id:'owner',text:'吃火锅',limit:10}).entries[0]!.lang,'zh');
  assert.deepEqual(texts({principal_id:'owner',text:'100%_',limit:10}),[]);
});

test('display names resolve at read time from the voiceprint registry, so a rename relabels old entries',async t=>{
  const {directory,journal,lane}=await open(t);
  const registry=new VoiceprintRegistry(new PosixStorage(join(directory,'store')),{id:'fixture',sha256:'c'.repeat(64),dim:16});
  const voice=new Float32Array(16);voice[3]=1;
  const cluster=await registry.identify(voice,{speech_ms:3000,observed_at:new Date(T0).toISOString(),mode:'observe'});
  assert.equal(cluster.kind,'speaker');const label=`speaker:${cluster.kind==='speaker'?cluster.cluster_id:''}`;
  lane.observe(heard([{at:0,text:'下周三我们一起去看展览',speaker:label},{at:3000,text:'好啊',speaker:'owner'}]),'host');
  const read=async()=>lane.search('owner',{},speakerNames(await registry.clusters()),await registry.clusters()) as {entries:{speaker:string;speaker_ref?:string}[]};
  assert.deepEqual((await read()).entries.map(e=>e.speaker),['主人',`说话人#${label.slice(8)}`]);
  await registry.renameCluster(label.slice(8),{display_name:'老王'});
  const renamed=await read();assert.deepEqual(renamed.entries.map(e=>e.speaker),['主人','老王']);assert.equal(renamed.entries[1]!.speaker_ref,label);
  const byName=lane.search('owner',{speaker:'老王'},speakerNames(await registry.clusters()),await registry.clusters()) as {entries:unknown[]};
  assert.equal(byName.entries.length,1);
  assert.deepEqual(resolveSpeaker('说话人#99',await registry.clusters()),[]);
  assert.deepEqual(resolveSpeaker('主人',[]),['owner','owner_uncertain']);
  assert.equal(journal.search({principal_id:'owner',speakers:[label],limit:5}).entries[0]!.speaker,label,'rows keep the label');
  const secondVoice=new Float32Array(16);secondVoice[4]=1;
  const second=await registry.identify(secondVoice,{speech_ms:3000,observed_at:new Date(T0).toISOString(),mode:'observe'});
  assert.equal(second.kind,'speaker'); const target=second.kind==='speaker'?second.cluster_id:'';
  await registry.renameCluster(target,{display_name:'王老师'},label.slice(8));
  await registry.close();
  const reopened=new VoiceprintRegistry(new PosixStorage(join(directory,'store')),{id:'fixture',sha256:'c'.repeat(64),dim:16});
  t.after(()=>reopened.close());
  const people=await reopened.clusters(),names=speakerNames(people);
  for(const reference of ['老王','王老师',label,`speaker:${target}`]) {
    const found=lane.search('owner',{speaker:reference},names,people) as {entries:{speaker:string;speaker_ref:string}[]};
    assert.deepEqual(found.entries.map(e=>[e.speaker,e.speaker_ref]),[['王老师',label]],'merge resolves old name and id without rewriting evidence');
  }
  assert.deepEqual(resolveSpeaker(label,people),[`speaker:${target}`],'mutation callers resolve one canonical id');
  assert.equal(journal.search({principal_id:'owner',speakers:[label],limit:5}).entries[0]!.speaker,label);

});

test('the fallback strip removes a leading wake word in any SenseVoice spelling and its punctuation',()=>{
  assert.equal(stripWake('依米，帮我看看明天会不会下雨。'),'帮我看看明天会不会下雨。');
  assert.equal(stripWake('一米。帮我叫车'),'帮我叫车');
  assert.equal(stripWake('嗯，伊米 帮我订外卖'),'帮我订外卖');
  assert.equal(stripWake('意味？帮我关灯'),'帮我关灯');
  assert.equal(stripWake('衣米！'),'');
  assert.equal(stripWake('帮我关灯'),'帮我关灯');
  assert.equal(stripWake('身高一米八'),'身高一米八','only a leading wake word');
});

const policy={turn_gap_ms:1300,request_follow_ms:8000,turn_max_ms:20000};
test('words after the wake word in its own utterance open a turn cut where the wake word ends; a pause of the gap closes it',async t=>{
  const {lane}=await open(t,policy);
  assert.deepEqual(lane.observe(heard([{at:0,text:'今天好累啊',speaker:'owner'}]),'host'),[]);
  assert.deepEqual(lane.observe(heard([{at:5000,ms:3000,text:'一米帮我看看明天会不会下雨',speaker:'owner',wake:0.25}]),'host'),[]);
  assert.deepEqual(lane.silence('owner','glasses',T0+8000+1299,false),[],'the pause has not reached the gap');
  const [turn]=lane.silence('owner','glasses',T0+8000+1300,false);
  // The analysed window starts at the wake word (a short request is identified with it); the request starts where it ends.
  assert.deepEqual([turn!.window,turn!.request_start_ms],[{start_ms:T0+5000,end_ms:T0+8000},T0+5000+750]);
  assert.deepEqual(turn!.parts.map(p=>p.text),['一米帮我看看明天会不会下雨']);
  assert.equal(turn!.wake.wake,'依米');assert.equal(turn!.host,'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+20000,false),[],'a closed turn closes once');
});

test('a wake word said alone: the request is the speaker\'s consecutive utterances, the wake segment only a trigger',async t=>{
  const {lane}=await open(t,policy);
  // The owner's measured pattern: "依米" alone (too short to identify), a pause, then the request with a mid-sentence pause.
  lane.observe(heard([{at:0,ms:450,text:'意味？',wake:1}]),'host');
  lane.observe(heard([{at:1000,ms:2200,text:'给我妈发个消息说，今晚。',speaker:'owner'}]),'host');
  lane.observe(heard([{at:3800,ms:900,text:'7点回家。'}]),'host');
  const [turn]=lane.silence('owner','glasses',T0+4700+1300,false);
  assert.deepEqual(turn!.parts.map(p=>p.text),['给我妈发个消息说，今晚。','7点回家。']);
  assert.equal(turn!.request_start_ms,T0+1000,'the wake-only segment is not part of the request');
  assert.deepEqual(turn!.window,{start_ms:T0,end_ms:T0+4700},'but the analysed window holds it, for a request too short alone');
  assert.equal(turn!.wake.text,'意味？');
  assert.equal(lane.request(turn!,'给我妈发个消息说，今晚。7点回家。').heard_at,new Date(T0+1000).toISOString());
  // The spotter's cut can leave a tail inside a wake word said alone: with no words once 依米 is stripped, it is alone.
  lane.observe(heard([{at:20000,ms:600,text:'依米。',wake:0.1}]),'host');
  lane.observe(heard([{at:21500,ms:700,text:'关灯。',speaker:'owner'}]),'host');
  const [short]=lane.silence('owner','glasses',T0+22200+1300,false);
  assert.deepEqual([short!.parts.map(p=>p.text),short!.request_start_ms,short!.window],[['关灯。'],T0+21500,{start_ms:T0+20000,end_ms:T0+22200}]);
  // Wake word and request beyond the turn cap together: the window starts where the request does.
  lane.observe(heard([{at:40000,ms:500,text:'依米',wake:1}]),'host');
  for(let n=0;n<4;n++)lane.observe(heard([{at:47000+n*4800,ms:4700,text:`第${n}段`,speaker:'owner'}]),'host');
  const [long]=lane.silence('owner','glasses',T0+66100+1300,false);
  assert.deepEqual(long!.window,{start_ms:T0+47000,end_ms:T0+66100});
});

test('a turn ends at the gap, the cap, another voice or a new wake word; a lone wake word lapses after the follow window',async t=>{
  const {lane}=await open(t,policy);
  // Gap: the late utterance closes the turn and is not part of it.
  lane.observe(heard([{at:0,ms:400,text:'依米',wake:1}]),'host');lane.observe(heard([{at:600,ms:1000,text:'帮我关灯',speaker:'owner'}]),'host');
  const [byGap]=lane.observe(heard([{at:1600+1301,ms:1000,text:'算了',speaker:'owner'}]),'host');
  assert.deepEqual(byGap!.parts.map(p=>p.text),['帮我关灯']);
  // Another voice inside the gap ends the owner's request.
  lane.observe(heard([{at:10000,ms:400,text:'依米',wake:1}]),'host');lane.observe(heard([{at:10500,ms:1500,text:'帮我订外卖',speaker:'owner'}]),'host');
  const [byVoice]=lane.observe(heard([{at:12200,ms:1000,text:'我也要一份',speaker:'speaker:4'}]),'host');
  assert.deepEqual(byVoice!.parts.map(p=>p.text),['帮我订外卖']);
  // Cap: a request may not run past the turn cap.
  lane.observe(heard([{at:30000,ms:400,text:'依米',wake:1}]),'host');
  for(let n=0;n<4;n++)assert.deepEqual(lane.observe(heard([{at:30500+n*5000,ms:4800,text:`第${n}段`,speaker:'owner'}]),'host'),[]);
  const [byCap]=lane.observe(heard([{at:50500,ms:1000,text:'第4段',speaker:'owner'}]),'host');
  assert.equal(byCap!.parts.length,4);assert.ok(byCap!.window.end_ms-byCap!.window.start_ms<=20000);
  // A new wake word closes the open turn and opens its own.
  lane.observe(heard([{at:60000,ms:400,text:'依米',wake:1}]),'host');lane.observe(heard([{at:60600,ms:1000,text:'现在几点',speaker:'owner'}]),'host');
  const [byWake]=lane.observe(heard([{at:61800,ms:2000,text:'依米打开空调',speaker:'owner',wake:0.3}]),'host');
  assert.deepEqual(byWake!.parts.map(p=>p.text),['现在几点']);
  assert.deepEqual(lane.silence('owner','glasses',T0+63800,true).map(t=>t.parts.map(p=>p.text)),[['依米打开空调']],'input exhausted closes at once');
  // A wake word alone with nothing after it within the follow window lapses.
  lane.observe(heard([{at:70000,ms:400,text:'依米',wake:1}]),'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+70400+8001,false),[]);
  assert.deepEqual(lane.observe(heard([{at:79000,ms:1000,text:'没事了',speaker:'owner'}]),'host'),[]);
  assert.deepEqual(lane.silence('owner','glasses',T0+90000,false),[],'the lapsed wake word took no request');
  // A labelled wake word only takes the same speaker's request; another device is its own lane.
  lane.observe(heard([{at:100000,ms:1200,text:'依米',speaker:'owner',wake:1}]),'host');
  lane.observe(heard([{at:101500,ms:1000,text:'你叫谁',speaker:'speaker:4'}]),'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+110000,false),[]);
  lane.observe(heard([{at:120000,ms:400,text:'依米',wake:1}],'phone'),'phone-host');lane.observe(heard([{at:120600,ms:1000,text:'几点了'}],'phone'),'phone-host');
  assert.deepEqual(lane.silence('owner','glasses',T0+130000,false),[]);
  assert.equal(lane.silence('owner','phone',T0+130000,false)[0]!.host,'phone-host');
});

test('依米\'s own voice heard back is journaled as 依米: never a wake word, never a request, never a pause inside one',async t=>{
  const {journal,lane}=await open(t,policy);
  // A reply that says 依米: journaled under its label without the wake word, so no turn opens.
  assert.deepEqual(lane.observe(heard([{at:0,ms:2500,text:'依米在呢，有什么需要帮忙的吗',speaker:'assistant',wake:0.2}]),'host'),[]);
  assert.deepEqual(lane.silence('owner','glasses',T0+10000,false),[]);
  // The owner's wake word alone, then the assistant's voice: the reply is not the request and it ends the wait.
  lane.observe(heard([{at:20000,ms:450,text:'意味？',wake:1}]),'host');
  assert.deepEqual(lane.observe(heard([{at:21000,ms:1500,text:'好的，我听着呢',speaker:'assistant'}]),'host'),[]);
  assert.deepEqual(lane.observe(heard([{at:23000,ms:1500,text:'帮我关灯',speaker:'owner'}]),'host'),[]);
  assert.deepEqual(lane.silence('owner','glasses',T0+30000,false),[]);
  // Inside a request it ends the request.
  lane.observe(heard([{at:40000,ms:2000,text:'依米帮我订外卖',speaker:'owner',wake:0.3}]),'host');
  const [closed]=lane.observe(heard([{at:42500,ms:1500,text:'好的，马上',speaker:'assistant'}]),'host');
  assert.deepEqual(closed!.parts.map(p=>p.text),['依米帮我订外卖']);
  const rows=journal.search({principal_id:'owner',speakers:resolveSpeaker('依米',[]),limit:10}).entries;
  assert.deepEqual(rows.map(r=>[r.speaker,r.wake]),[['assistant',null],['assistant',null],['assistant',null]]);
  assert.deepEqual((lane.search('owner',{speaker:'assistant'},speakerNames([]),[]) as {entries:{speaker:string}[]}).entries.map(e=>e.speaker),
    ['依米','依米','依米']);
  assert.deepEqual(lane.context(closed!.wake,speakerNames([])).entries.map(e=>e.speaker),['依米','未识别','依米','主人']);
});

test('speech a live call heard is the call\'s: journaled, never a wake turn; a turn from before the call ends; after hang-up wakes work',async t=>{
  const {journal}=await open(t,policy),calls:{start_ms:number;end_ms:number}[]=[];
  const lane=new AmbientLane<string>(journal,{call_heard:(principal,device,span)=>principal==='owner'&&device==='glasses'&&
    calls.some(c=>span.start_ms<c.end_ms&&span.end_ms>c.start_ms)});
  // A wake word said alone before the call; the request comes once the call is live: the call answers it, not the lane.
  lane.observe(heard([{at:0,ms:450,text:'意味？',wake:1}]),'host');
  calls.push({start_ms:T0+600,end_ms:T0+30000});
  assert.deepEqual(lane.observe(heard([{at:1000,ms:1500,text:'帮我叫车去机场',speaker:'owner'}]),'host'),[]);
  // During the call: "依米…" inline and alone, with a request — all journaled, no turn.
  assert.deepEqual(lane.observe(heard([{at:5000,ms:2500,text:'依米帮我叫车去机场',speaker:'owner',wake:0.25}]),'host'),[]);
  lane.observe(heard([{at:10000,ms:450,text:'意味？',wake:1}]),'host');lane.observe(heard([{at:11000,ms:1200,text:'叫车',speaker:'owner'}]),'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+20000,false),[]);
  assert.deepEqual(journal.search({principal_id:'owner',limit:10}).entries.map(e=>e.wake).reverse(),['依米',null,'依米','依米',null]);
  // A request begun before the call ends where the call takes over; its words from before still run.
  calls.length=0;
  lane.observe(heard([{at:40000,ms:2500,text:'依米帮我订一束花',speaker:'owner',wake:0.25}]),'host');
  calls.push({start_ms:T0+43000,end_ms:T0+50000});
  const [before]=lane.observe(heard([{at:43200,ms:1000,text:'送到公司',speaker:'owner'}]),'host');
  assert.deepEqual(before!.parts.map(p=>p.text),['依米帮我订一束花']);
  // After hang-up the lane listens again; another device was never the call's.
  lane.observe(heard([{at:60000,ms:2500,text:'依米现在几点',speaker:'owner',wake:0.25}]),'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+64000,false).map(turn=>turn.parts.map(p=>p.text)),[['依米现在几点']]);
  calls.push({start_ms:T0+70000,end_ms:T0+80000});
  lane.observe(heard([{at:71000,ms:2500,text:'依米今天几号',speaker:'owner',wake:0.25}],'phone'),'phone-host');
  assert.equal(lane.silence('owner','phone',T0+75000,false).length,1);
});

test('a retried D was decided when first journaled: it neither repeats nor reopens a turn',async t=>{
  const {lane}=await open(t,policy);
  const wake=heard([{at:0,ms:2000,text:'依米帮我关灯',speaker:'owner',wake:0.3}]);
  lane.observe(wake,'host');const [turn]=lane.silence('owner','glasses',T0+4000,false);assert.ok(turn);
  assert.deepEqual(lane.observe(wake,'host'),[]);assert.deepEqual(lane.silence('owner','glasses',T0+9000,false),[]);
});

test('the context window is the conversation before the wake word, at most the last minutes, within the byte budget',async t=>{
  const {journal,lane}=await open(t,{context_max_ms:60000,context_max_bytes:1600,conversation_gap_ms:30000});
  lane.observe(heard([{at:0,text:'上一段对话的内容',speaker:'owner'}]),'host');
  for(let n=0;n<8;n++)lane.observe(heard([{at:40000+n*10000,text:`第${n}句：我们周末去爬山吧`,speaker:n%2?'owner':'speaker:2'}]),'host');
  lane.observe(heard([{at:125000,ms:3000,text:'依米，把刚才说的记下来',speaker:'owner',wake:0.2}]),'host');
  const [turn]=lane.silence('owner','glasses',T0+130000,false);
  const context=lane.context(turn!.wake,speakerNames([{cluster_id:'2',label:'老李'}]));
  assert.equal(context.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(context.entries))<=1600);
  const texts=context.entries.map(e=>e.text);
  assert.ok(texts.length>=2&&texts.at(-1)==='第7句：我们周末去爬山吧','newest kept, chronological order');
  assert.ok(!texts.includes('上一段对话的内容'),'an earlier conversation is not context');
  assert.ok(context.entries.every(e=>Date.parse(e.at)>=T0+125000-60000));
  assert.equal(context.entries.find(e=>e.speaker_ref==='speaker:2')?.speaker,'老李');
  assert.equal(context.conversation_id,turn!.wake.conversation_id);
  assert.equal(journal.context(turn!.wake).length,5,'only rows inside the minute window before the wake word');
  assert.equal(lane.request(turn!,'一米，把刚才说的记下来',context).text,'把刚才说的记下来');
});

test('utterances: only local voiceprint labels name speakers; times must be wall clock',()=>{
  const timed=utterances(heard([{at:1000,ms:2000,text:'依米帮我关灯',wake:0.25}]))[0]!;
  assert.deepEqual([timed.wake,timed.wake_cut_ms],['依米',T0+1500],'the wake word end maps onto the utterance span');
  const d=heard([{at:0,text:'你好',speaker:'speaker:1'}]);
  (d.content.audio_observations as {segments:{identity_scope:string}[]}[])[0]!.segments[0]!.identity_scope='model_local';
  assert.equal(utterances(d)[0]!.speaker,null);
  const silent=heard([{at:0,text:''}]);assert.deepEqual(utterances(silent),[]);
  const plain={...heard([{at:0,text:'x'}]),content:{transcript:'纯文本转写'}} as ProcessedEvent;
  assert.equal(utterances(plain)[0]!.text,'纯文本转写');
  assert.throws(()=>utterances({...plain,time_range:{kind:'interval',timebase_id:'samples',start_ms:0,end_ms:1}} as ProcessedEvent),/AMBIENT_UTC_TIMEBASE_REQUIRED/);
});

test('sound bursts keep immutable evidence, survive restart, isolate device/principal, and never open a turn',async t=>{
  const {directory,journal,lane}=await open(t);
  const sound=(at:number,event='cough',device='glasses',principal='owner')=>{
    const d=heard([{at,ms:180,text:''}],device,principal);
    const segment=(d.content.audio_observations as unknown as {segments:Record<string,unknown>[]}[])[0]!.segments[0]!;
    segment.event=event;segment.emotion='neutral';return d;
  };
  const first=sound(0);assert.deepEqual(lane.observe(first,'host'),[]);
  const later=sound(170000);lane.observe(first,'host');lane.observe(sound(1000),'host');lane.observe(later,'host');
  // The burst a D's sound joined, counted over the whole burst so far (care's one event per burst).
  assert.deepEqual(journal.bursts('owner',later.processed_event_id).map(b=>[b.burst_id,b.count,b.start_ms]),
    [[journal.bursts('owner',first.processed_event_id)[0]!.burst_id,3,T0]]);
  lane.observe(sound(180001),'host');lane.observe(sound(2000,'sneeze'),'host');
  lane.observe(sound(2000,'cough','phone'),'host');lane.observe(sound(2000,'cough','glasses','stranger'),'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+400000,false),[]);
  assert.equal(journal.entriesOf('owner',first.processed_event_id)[0]!.event,'cough');
  const result=lane.search('owner',{event:'cough'},speakerNames([]),[]) as {entries:unknown[];events:{count:number;device_id:string}[]};
  assert.deepEqual(result.entries,[]);assert.deepEqual(result.events.map(e=>[e.count,e.device_id]),[[1,'glasses'],[1,'phone'],[3,'glasses']]);
  journal.close();const reopened=AmbientJournal.open(join(directory,'ambient-journal'));t.after(()=>reopened.close());
  assert.equal(reopened.search({principal_id:'owner',event:'cough',limit:10}).events.reduce((n,e)=>n+e.count,0),5);
  const db=new DatabaseSync(join(directory,'ambient-journal','journal.sqlite'));t.after(()=>db.close());
  assert.throws(()=>db.exec("UPDATE entries SET event='sneeze'"),/AMBIENT_JOURNAL_APPEND_ONLY/);
  assert.throws(()=>lane.search('owner',{event:'diagnosis'},speakerNames([]),[]),/AMBIENT_JOURNAL_QUERY_INVALID/);
});

test('emotion is attached to speech and returned by owner journal search',async t=>{
  const {journal,lane}=await open(t);
  const d=heard([{at:0,text:'今天很开心',speaker:'owner'}]);
  (d.content.audio_observations as unknown as {segments:Record<string,unknown>[]}[])[0]!.segments[0]!.emotion='happy';
  lane.observe(d,'host');
  assert.equal(journal.search({principal_id:'owner',limit:5}).entries[0]!.emotion,'happy');
  assert.equal((lane.search('owner',{},speakerNames([]),[]) as {entries:{emotion:string}[]}).entries[0]!.emotion,'happy');
});

test('BGM annotates speech through the worker, wake turn and text search; a text-less cough is event-only',async t=>{
  const {controlledEngine,transcribeWindow}=await import('./speech-fixture.ts');
  const {journal,lane}=await open(t),engine=controlledEngine({wake:[1]});let identified=0;
  engine.transcribe=async samples=>Math.round((samples.find(x=>x!==0)??0)*32768)===1?
    {text:'依米现在几点',event:'bgm',emotion:'happy'}:{text:'',event:'cough',emotion:'neutral'};
  const speakers={model:engine.speaker_model,identify:async()=>{identified++;return {kind:'owner' as const,band:'verified' as const,score:0.9};}};
  const pcm=Buffer.alloc(30720*2);
  for(let n=0;n<20480;n++)pcm.writeInt16LE(1,n*2);
  for(let n=24576;n<26624;n++)pcm.writeInt16LE(2,n*2);
  const {d}=await transcribeWindow(t,pcm,engine,speakers,T0);lane.observe(d,'host');
  assert.equal(identified,1);assert.ok(engine.calls.includes('kws_open'));
  const rows=journal.entriesOf('owner',d.processed_event_id);
  assert.deepEqual(rows.map(e=>[e.text,e.speaker,e.wake,e.event]),[['依米现在几点','owner','依米','bgm'],['',null,null,'cough']]);
  const [turn]=lane.silence('owner','glasses',T0+10000,true,d.raw_ref);
  assert.equal(turn!.wake.event,'bgm');assert.deepEqual(turn!.parts.map(e=>e.text),['依米现在几点']);
  const found=lane.search('owner',{query:'依米'},speakerNames([]),[]) as {entries:{text:string;event:string;emotion:string}[]};
  assert.deepEqual(found.entries.map(e=>[e.text,e.event,e.emotion]),[['依米现在几点','bgm','happy']]);
  const all=journal.search({principal_id:'owner',limit:10});assert.equal(all.entries.length,1);
  assert.deepEqual(all.events.map(e=>[e.event,e.count]),[['cough',1],['bgm',1]]);
  assert.deepEqual(lane.context(rows[1]!,speakerNames([])).entries.map(e=>e.text),['依米现在几点']);
});

test('v1 journal upgrades additively and retains append-only historical rows',async t=>{
  const {directory,journal,lane}=await open(t);lane.observe(heard([{at:0,text:'旧记录',speaker:'owner'}]),'host');journal.close();
  const file=join(directory,'ambient-journal','journal.sqlite'),db=new DatabaseSync(file);
  db.exec('DROP INDEX entries_burst;DROP INDEX entries_burst_id;ALTER TABLE entries DROP COLUMN event;'+
    'ALTER TABLE entries DROP COLUMN emotion;ALTER TABLE entries DROP COLUMN burst_id;');
  db.exec("UPDATE meta SET value='paios.ambient-journal.v1' WHERE key='schema'");db.close();
  const migrated=AmbientJournal.open(join(directory,'ambient-journal'));t.after(()=>migrated.close());
  assert.equal(migrated.search({principal_id:'owner',limit:10}).entries[0]!.text,'旧记录');
  assert.deepEqual(migrated.search({principal_id:'owner',limit:10}).events,[]);
});

test('late silence from another PCM epoch cannot close the current epoch turn',async t=>{
  const {lane}=await open(t);
  const wake=heard([{at:0,text:'依米现在几点',speaker:'owner',wake:0.2}]);lane.observe(wake,'host');
  assert.deepEqual(lane.silence('owner','glasses',T0+10000,true,`l5:${'c'.repeat(64)}`),[]);
  assert.equal(lane.silence('owner','glasses',T0+10000,true,wake.raw_ref).length,1);
  const old=heard([{at:20000,text:'依米现在几点',speaker:'owner',wake:0.2}]);lane.observe(old,'host');
  const next=heard([{at:22500,text:'这句话属于新音频流',speaker:'owner'}]);next.raw_ref=`l5:${'d'.repeat(64)}`;
  const [closed]=lane.observe(next,'host');assert.deepEqual(closed!.parts.map(p=>p.text),['依米现在几点']);
});

test('a voice claim reserves its device while opening, journals concurrent speech, and deduplicates its wake',async t=>{
  const {journal}=await open(t,policy),lane=new AmbientLane<string>(journal);
  const verified=(at:number)=>({...heard([{at,ms:1500,text:'依米，几点了',speaker:'owner',wake:0.25}]),
    media_type:'audio',segment_basis:'speech_candidate',processing:{path_id:'media_audio',models:[],policy_version:'fixture',archive_revision:'b'.repeat(64),completed_at:new Date(T0).toISOString()},
    speakers:[{identity_scope:'local_voiceprint',voiceprint:'owner',speech_ms:1500,segments:1,score:0.9}]}) as ProcessedEvent;
  const first=verified(0),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<boolean>();let offers=0;
  const opening=lane.observeVoice(first,'host',async()=>{offers++;entered.resolve();return finish.promise;});
  await entered.promise;
  assert.deepEqual(lane.silence('owner','glasses',T0+10000,false),[],'no text turn exists during opening');
  assert.deepEqual(await lane.observeVoice(verified(2000),'host',async()=>{offers++;return true;}),[]);
  finish.resolve(true);assert.deepEqual(await opening,[]);
  assert.deepEqual(await lane.observeVoice(first,'host',async()=>{offers++;return true;}),[]);
  assert.equal(offers,1);assert.equal(journal.search({principal_id:'owner',limit:10}).entries.length,2);
});

test('a call that opens after a pending wake owns overlapping request audio at silence',async t=>{
  const {journal}=await open(t,policy);let live=false;
  const lane=new AmbientLane<string>(journal,{call_heard:()=>live});
  lane.observe(heard([{at:0,ms:1500,text:'依米，几点了',speaker:'owner',wake:0.25}]),'host');
  live=true;assert.deepEqual(lane.silence('owner','glasses',T0+10000,false),[]);
  live=false;assert.deepEqual(lane.silence('owner','glasses',T0+12000,false),[],'late call consumed the turn once');
});

test('ambient voice keeps annotated requests and epoch fencing; sound-only entries never become voice turns',async t=>{
  const {journal}=await open(t),lane=new AmbientLane<string>(journal,{voice_active:()=>true});let offers=0;
  const annotated=(spoken:Spoken,event:string)=>{
    const d=heard([spoken]);
    Object.assign((d.content.audio_observations as unknown as {segments:object[]}[])[0]!.segments[0]!,{event,emotion:'happy'});
    return d;
  };
  const offer=async()=>{offers++;return true;};
  assert.deepEqual(await lane.observeVoice(annotated({at:0,ms:180,text:''},'cough'),'host',offer),[]);
  assert.equal(offers,0);
  const wake=annotated({at:1000,text:'依米现在几点',wake:0.2},'bgm');
  assert.deepEqual(await lane.observeVoice(wake,'host',offer),[]);assert.equal(offers,1);
  assert.deepEqual(await lane.observeVoice(annotated({at:3500,ms:180,text:''},'cough'),'host',offer),[]);
  assert.deepEqual(lane.silence('owner','glasses',T0+10000,true,`l5:${'c'.repeat(64)}`),[]);
  const [turn]=lane.silence('owner','glasses',T0+10000,true,wake.raw_ref);
  assert.ok(turn!.voice_session_id);assert.deepEqual(turn!.parts.map(e=>[e.text,e.event,e.emotion]),[['依米现在几点','bgm','happy']]);
  assert.equal(lane.request(turn!,'现在几点').voice_session_id,turn!.voice_session_id);
  await lane.observeVoice(annotated({at:11000,ms:180,text:''},'cough'),'host',offer);
  assert.deepEqual(lane.silence('owner','glasses',T0+20000,true,wake.raw_ref),[]);
  assert.equal(offers,1);assert.equal(journal.search({principal_id:'owner',event:'cough',limit:10}).events[0]!.count,3);
});


test('exact source erasure removes journal rows and FTS, survives restart and blocks source replay',async t=>{
  const {directory,journal,lane}=await open(t);
  const erased=heard([{at:0,text:'private secret words',speaker:'owner'}]);
  const kept=heard([{at:3000,text:'unrelated surviving words',speaker:'owner'}]);kept.raw_ref=`l5:${'c'.repeat(64)}`;
  const other=heard([{at:0,text:'another principal secret words',speaker:'owner'}],'glasses','other');
  lane.observe(erased,'host');lane.observe(kept,'host');lane.observe(other,'host');
  const anchor=journal.entriesOf('owner',kept.processed_event_id)[0]!;
  assert.equal(journal.search({principal_id:'owner',text:'secret',limit:10}).entries.length,1);
  assert.equal(journal.context(anchor).length,1);
  const file=join(directory,'ambient-journal','journal.sqlite'),db=new DatabaseSync(file);t.after(()=>db.close());
  assert.throws(()=>db.exec("DELETE FROM entries WHERE principal_id='owner'"),/AMBIENT_JOURNAL_APPEND_ONLY/);
  assert.equal(journal.eraseSources('owner',[erased.raw_ref,erased.raw_ref]),1);
  assert.deepEqual(journal.search({principal_id:'owner',text:'secret',limit:10}).entries,[]);
  assert.deepEqual(journal.entriesOf('owner',erased.processed_event_id),[]);
  assert.deepEqual(journal.context(anchor),[]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entries WHERE principal_id=? AND raw_ref=?').get('owner',erased.raw_ref)!.n,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries_text WHERE entries_text MATCH 'private'").get()!.n,0);
  assert.equal(journal.search({principal_id:'owner',limit:10}).entries[0]!.text,kept.content.transcript);
  assert.equal(journal.search({principal_id:'other',text:'secret',limit:10}).entries.length,1);
  assert.throws(()=>lane.observe(erased,'host'),/AMBIENT_JOURNAL_SOURCE_ERASED/);
  assert.throws(()=>db.exec('DELETE FROM erased_sources'),/AMBIENT_JOURNAL_ERASURE_IMMUTABLE/);
  assert.throws(()=>db.exec("DELETE FROM entries WHERE principal_id='other'"),/AMBIENT_JOURNAL_APPEND_ONLY/);
  assert.equal(journal.eraseSources('owner',[erased.raw_ref]),0,'repeated erasure is idempotent');
  journal.close();
  const reopened=AmbientJournal.open(join(directory,'ambient-journal'));t.after(()=>reopened.close());
  assert.deepEqual(reopened.search({principal_id:'owner',text:'secret',limit:10}).entries,[]);
  assert.throws(()=>new AmbientLane<string>(reopened).observe(erased,'host'),/AMBIENT_JOURNAL_SOURCE_ERASED/);
  assert.equal(reopened.search({principal_id:'owner',limit:10}).entries.length,1);
  // Even a source without an existing journal row is fenced before late processing can append it.
  const late=heard([{at:6000,text:'late secret words',speaker:'owner'}]);late.raw_ref=`l5:${'d'.repeat(64)}`;
  assert.equal(reopened.eraseSources('owner',[late.raw_ref]),0);
  assert.throws(()=>new AmbientLane<string>(reopened).observe(late,'host'),/AMBIENT_JOURNAL_SOURCE_ERASED/);
});

test('an explicit dial reaches its call owner while an automatic voice decision still holds the claim',async t=>{
  const {journal}=await open(t),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<boolean>();
  let active:string|undefined,offers=0;const lane=new AmbientLane<string>(journal,{voice_active:(_p,_d,id)=>active===id});
  const automatic=lane.claimVoice('owner','glasses',async()=>{entered.resolve();return release.promise;});await entered.promise;
  try {
    assert.equal(await lane.openVoice('owner','glasses','dial',async()=>{offers++;active='dial';return true;},'dial'),true);
    assert.equal(offers,1);
    assert.equal(await lane.openVoice('owner','glasses','care',async()=>{offers++;return true;}),false);
    assert.equal(offers,1,'the automatic claim still fences another automatic offer');
    release.resolve(true);await automatic;
    lane.observe(heard([{at:20000,text:'现在几点',speaker:'owner'}]),'host');
    assert.equal(lane.silence('owner','glasses',T0+30000,true)[0]?.voice_session_id,'dial');
  } finally {release.resolve(true);await automatic;}
});

test('an accepted offer cannot install an inactive voice session and explicit dial reports supersession',async t=>{
  const {journal}=await open(t),lane=new AmbientLane<string>(journal,{voice_active:()=>false});
  assert.equal(await lane.openVoice('owner','glasses','automatic',async()=>true),false);
  await assert.rejects(lane.openVoice('owner','glasses','dial',async()=>true,'dial'),{code:'VOICE_CALL_SUPERSEDED'});
});

test('a late accepted automatic wake cannot overwrite the newer explicit voice session',async t=>{
  const {journal}=await open(t),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<boolean>();
  let active:string|undefined;const lane=new AmbientLane<string>(journal,{voice_active:(_p,_d,id)=>active===id});
  const automatic=lane.observeVoice(heard([{at:0,text:'依米',speaker:'owner',wake:1}]),'host',async()=>{entered.resolve();return release.promise;});
  await entered.promise;
  try {
    assert.equal(await lane.openVoice('owner','glasses','dial',async()=>{active='dial';return true;},'dial'),true);
    release.resolve(true);await automatic;
    lane.observe(heard([{at:2000,text:'现在几点',speaker:'owner'}]),'host');
    assert.equal(lane.silence('owner','glasses',T0+30000,true)[0]?.voice_session_id,'dial');
  } finally {release.resolve(true);await automatic;}
});
