// The ambient lane's follow-up rule on its own (journal, no media): after a turn's reply is delivered, the asker's next
// utterance on that device — or one too short to identify — opens a new request turn without the wake word, inside a window
// anchored on delivery plus the reply's estimated read-out, its audio opening with the replied request's speech; the window
// ends on its timeout, another identified voice, 依米's own voice after the reply, a wake word or a live call's speech. One
// authority for what opens a turn: the lane.
import assert from 'node:assert/strict';
import test from 'node:test';
import {digest,type ProcessedEvent} from '../src/contracts.ts';
import {AmbientLane,type CallHeard,type FollowUpRequest,type WakeRequest} from '../src/ambient/lane.ts';
import {testJournal} from './speech-fixture.ts';

const T=Date.parse('2026-10-09T14:55:06.000Z');
const REPLY='可以的，告诉我一下你在哪个城市，我马上帮你查明天会不会下雨。';  // the field's reply: 27 syllables
const ANCHOR=T+27*250,UNTIL=ANCHOR+10000;
let n=0;
/** One heard utterance as the ambient worker's D: [start, end) UTC ms, its text, voiceprint label and wake word; `stream`
 *  names the capture stream (its raw_ref). */
function heard(start_ms:number,text:string,speaker?:string,options:{wake?:boolean;device?:string;ms?:number;stream?:string}={}):ProcessedEvent {
  const id=`processed:u${++n}`,end_ms=start_ms+(options.ms??1500);
  return {principal_id:'owner',device_id:options.device??'phone',processed_event_id:id,raw_ref:`l5:${digest(options.stream??'day')}`,archive_revision:digest(['rev',id]),
    segment_id:`segment:${n}`,speakers:[],content:{audio_observations:[{observation_kind:'sample_transcription',segments:[{start_sample:0,
      end_sample_exclusive:(end_ms-start_ms)*16,text,...(speaker?{speaker,identity_scope:'local_voiceprint',speaker_score:0.8}:{}),
      ...(options.wake?{wake:{keyword:'依米',end_sample:4800}}:{}),
      source_parts:[{clipped_scope_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms,end_ms}}]}]}]}} as unknown as ProcessedEvent;
}
/** A turn's request D as admitted: its framing, the turn consumer's one identity, and its audio (the wake word from
 *  T-16 s, the request heard from T-15.5 s until T-13 s, on the day's stream). */
function turnD(voiceprint:string|null,options:{device?:string;framing?:boolean;stream?:string}={}):ProcessedEvent {
  const id=`processed:t${++n}`;
  return {principal_id:'owner',device_id:options.device??'phone',processed_event_id:id,raw_ref:`l5:${digest(options.stream??'day')}`,
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:T-16000,end_ms:T-13000},
    speakers:voiceprint?[{identity_scope:'local_voiceprint',voiceprint,score:0.8,segments:1,speech_ms:1800}]:[],
    content:options.framing===false?{transcript:'x'}:{wake_request:{kind:'ambient_wake',text:'x',heard_at:new Date(T-15500).toISOString()}}} as unknown as ProcessedEvent;
}
async function setup(t:test.TestContext,options:{call_heard?:CallHeard}={}) {
  const journal=await testJournal(t),lane=new AmbientLane<string>(journal,{...options,now:()=>T});
  const hear=(d:ProcessedEvent)=>lane.observe(d,'host');
  /** The detector's silence after the last utterance: whatever turn it closes. */
  const pause=(through:number,device='phone')=>lane.silence('owner',device,through,false);
  return {journal,lane,hear,pause};
}

test('the asker\'s next utterance after the reply follows up without the wake word: a new turn framed as a follow-up',async t=>{
  const {lane,hear,pause}=await setup(t);
  const asked=turnD('owner');lane.replied(asked,REPLY);
  const answer=heard(T+5900,'你看不到我在哪个城市吗？','owner');
  assert.deepEqual(hear(answer),[]);
  const [turn]=pause(T+5900+1500+1300);
  assert.ok(turn);assert.equal(turn.follows,asked.processed_event_id);
  assert.deepEqual([turn.wake.processed_event_id,turn.wake.wake,turn.request_start_ms],[answer.processed_event_id,null,T+5900]);
  // Its audio opens with the replied request's speech, which identifies a short follow-up together with its words.
  assert.deepEqual([turn.window,turn.speaker_carrier],[{start_ms:T-15500,end_ms:T+7400},{end_ms:T-13000,request_start_ms:T+5900}]);
  const framing=lane.request(turn,turn.parts[0]!.text) as FollowUpRequest;
  assert.deepEqual(framing,{kind:'ambient_follow_up',text:'你看不到我在哪个城市吗？',heard_at:new Date(T+5900).toISOString(),
    follows_processed_event_id:asked.processed_event_id,opened_processed_event_id:answer.processed_event_id});
  assert.equal(lane.opener('owner',framing)?.processed_event_id,answer.processed_event_id,'"确认是我" finds where it opened');
  // The window was spent: the same voice again is ambient speech.
  hear(heard(T+9000,'算了','owner'));assert.deepEqual(pause(T+12000),[]);
});

test('the window runs from delivery to 10 s after the reply\'s estimated read-out; speech before delivery is not an answer',async t=>{
  const late=await setup(t);late.lane.replied(turnD('owner'),REPLY);
  late.hear(heard(UNTIL+1,'我在杭州','owner'));assert.deepEqual(late.pause(UNTIL+5000),[],'past the window');
  const last=await setup(t);last.lane.replied(turnD('owner'),REPLY);
  last.hear(heard(T-800,'嗯，明天要出门','owner'));
  last.hear(heard(UNTIL,'我在杭州','owner'));assert.equal(last.pause(UNTIL+3000).length,1,'the last moment still opens; earlier speech left it armed');
  // The anchor grows with the reply (capped), never shrinks below delivery.
  const long=await setup(t);long.lane.replied(turnD('owner'),'好'.repeat(400));
  long.hear(heard(T+30000+9000,'继续','owner'));assert.equal(long.pause(T+45000).length,1);
  // The silence detector past the window forgets it.
  const swept=await setup(t);swept.lane.replied(turnD('owner'),REPLY);
  assert.deepEqual(swept.pause(UNTIL+1),[]);swept.hear(heard(T+2000,'我在杭州','owner'));assert.deepEqual(swept.pause(T+6000),[]);
});

test('another identified voice, a live call, or 依米\'s own voice after the reply ends the window; a short answer opens it',async t=>{
  const other=await setup(t);other.lane.replied(turnD('owner'),REPLY);
  other.hear(heard(T+2000,'你们在说什么呀','speaker:3'));other.hear(heard(T+5000,'我在杭州','owner'));
  assert.deepEqual(other.pause(T+9000),[],'someone else spoke first');
  const echo=await setup(t);echo.lane.replied(turnD('owner'),REPLY);
  echo.hear(heard(T+500,'可以的，告诉我一下你在哪个城市','assistant'));echo.hear(heard(T+3000,'杭州',undefined,{ms:500}));
  const [short]=echo.pause(T+5000);
  assert.ok(short?.follows&&short.speaker_carrier,'the reply heard back while it plays neither opens nor ends it; a short answer too short to identify opens it');
  const after=await setup(t);after.lane.replied(turnD('owner'),REPLY);
  after.hear(heard(ANCHOR+100,'好的，已经帮你设好闹钟了','assistant'));after.hear(heard(ANCHOR+3000,'我在杭州','owner'));
  assert.deepEqual(after.pause(ANCHOR+8000),[],'依米 saying something else after the reply ends it');
  const span=T+2000,call=await setup(t,{call_heard:(_p,_d,s)=>s.start_ms===span});call.lane.replied(turnD('owner'),REPLY);
  call.hear(heard(span,'我在杭州','owner'));call.hear(heard(T+5000,'我在杭州','owner'));
  assert.deepEqual(call.pause(T+9000),[],'the live call answers what it heard; the window is over');
});

test('a follow-up with the wake word is a wake turn; another device, an unknown voice or an empty reply opens nothing',async t=>{
  const wake=await setup(t);wake.lane.replied(turnD('owner'),REPLY);
  wake.hear(heard(T+2000,'一米，我在杭州','owner',{wake:true,ms:2000}));
  const [turn]=wake.pause(T+6000);assert.equal(turn?.follows,undefined);
  assert.equal((wake.lane.request(turn!,'我在杭州') as WakeRequest).kind,'ambient_wake');
  const device=await setup(t);device.lane.replied(turnD('owner',{device:'glasses'}),REPLY);
  device.hear(heard(T+2000,'我在杭州','owner'));assert.deepEqual(device.pause(T+6000),[]);
  assert.equal(device.hear(heard(T+2500,'我在杭州','owner',{device:'glasses'})).length,0);
  assert.equal(device.pause(T+6000,'glasses').length,1,'the device that heard the turn');
  for(const [d,reply] of [[turnD(null),REPLY],[turnD('owner'),'  '],[turnD('owner',{framing:false}),REPLY],[turnD('assistant'),REPLY]] as const){
    const none=await setup(t);none.lane.replied(d,reply);none.hear(heard(T+2000,'我在杭州','owner'));
    assert.deepEqual(none.pause(T+6000),[]);
  }
});

test('a guest follows up as the same voice; a chained follow-up\'s reply re-arms the window; an uncertain owner is the owner',async t=>{
  const guest=await setup(t);guest.lane.replied(turnD('speaker:1'),'今天是十月九号。');
  guest.hear(heard(T+2000,'那明天是星期几','speaker:1'));
  const [first]=guest.pause(T+5000);assert.ok(first?.follows);
  guest.lane.replied(turnD('speaker:1'),'明天是星期六。',T+8000);
  guest.hear(heard(T+9000,'谢谢你','speaker:1'));assert.equal(guest.pause(T+12000).length,1,'chained');
  guest.lane.replied(turnD('speaker:1'),'不客气。',T+13000);
  guest.hear(heard(T+14000,'帮我点个外卖','owner'));assert.deepEqual(guest.pause(T+17000),[],'the owner is another voice here');
  const owner=await setup(t);owner.lane.replied(turnD('owner_uncertain'),REPLY);
  owner.hear(heard(T+2000,'我在杭州','owner'));assert.equal(owner.pause(T+6000).length,1);
});

test('the carrier is the replied request\'s speech on the same stream, within the turn consumer\'s 60 s',async t=>{
  const other=await setup(t);other.lane.replied(turnD('owner'),REPLY);
  other.hear(heard(T+2000,'杭州',undefined,{ms:600,stream:'reconnected'}));
  const [restarted]=other.pause(T+4000);
  assert.deepEqual([restarted?.follows!==undefined,restarted?.speaker_carrier,restarted?.window.start_ms],[true,undefined,T+2000],'a new stream: no carrier');
  const late=await setup(t);late.lane.replied(turnD('owner'),'好'.repeat(200),T+5000);
  late.hear(heard(T+45000,'杭州',undefined,{ms:600}));
  const [far]=late.pause(T+47000);assert.ok(far);assert.equal(far.speaker_carrier,undefined,'request and answer more than 60 s apart');
});
