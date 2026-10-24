import {canonical,check,digest,type Json,type ProcessedEvent} from '../contracts.ts';
import {parseSpeakerLabel,stripWake,TURN_WINDOW_MAX_MS,wakeCarriesRequest} from '../voiceprint/contracts.ts';
export {stripWake} from '../voiceprint/contracts.ts';
import {SOUND_EVENTS,SPEECH_EMOTIONS,type SoundEvent,type SpeechEmotion} from '../voiceprint/contracts.ts';
import type {AmbientJournal,JournalEntry,JournalUtterance} from './journal.ts';
import type {UtteranceRef} from '../payment/contracts.ts';

/** The request framing a turn's D carries (`content.wake_request`): a wake turn (`ambient_wake`) or a follow-up
 *  (`ambient_follow_up`: its asker answering a delivered reply without the wake word; `follows_processed_event_id` is the
 *  request D whose reply it answers, `opened_processed_event_id` the D of its first utterance). `context`: the
 *  conversation heard before the turn opened, only on a verified owner's turn; display names are the registry's at the time
 *  the context was read. */
export type TurnRequest=WakeRequest|FollowUpRequest|VoiceRequest;
export interface WakeRequest {
  kind:'ambient_wake';wake:string;text:string;heard_at:string;wake_processed_event_id:string;voice_session_id?:string;voice_turn?:number;context?:AmbientContext;
}
export interface FollowUpRequest {
  kind:'ambient_follow_up';text:string;heard_at:string;follows_processed_event_id:string;opened_processed_event_id:string;voice_session_id?:string;voice_turn?:number;context?:AmbientContext;
}
export interface VoiceRequest {kind:'ambient_voice';text:string;heard_at:string;voice_session_id:string;voice_turn?:number;opened_processed_event_id:string;context?:AmbientContext}
export interface AmbientContext {conversation_id:string;entries:{at:string;speaker:string;speaker_ref?:string;text:string;
  evidence?:ReturnType<typeof journalEvidence>;instruction_eligible?:boolean}[];truncated:boolean}
/** Display name of a stored voiceprint label (`owner`, `speaker:12`, `assistant`, or null for an unattributed utterance). */
export type SpeakerNames=(label:string|null)=>{speaker:string;speaker_ref?:string};
/** A closed turn: the utterance that opened it (`wake`: the wake word's, or a follow-up's first words), the audio window
 *  the turn consumer analyses (UTC: from the wake word through the last utterance when that fits the turn cap — a short
 *  request is identified together with its wake word — else from where the request starts), where the request starts, the
 *  D of its last utterance (whose pinned candidate the window is cut from) and the host's handle for admitting it.
 *  `follows`: a follow-up's replied request D; `speaker_carrier`: its window opens with that request or a bare wake (UTC, until
 *  `end_ms`), which identifies a short follow-up together with its own words (from `request_start_ms`). */
export interface WakeTurn<H> {
  wake:JournalEntry;parts:JournalEntry[];window:{start_ms:number;end_ms:number};request_start_ms:number;last:ProcessedEvent;host:H;follows?:string;voice_session_id?:string;voice_continuation?:true;
  speaker_carrier?:{end_ms:number;request_start_ms:number};
}
/** The replied request's speech (UTC) on its stream. */
interface Carrier {start_ms:number;end_ms:number;raw_ref:string}
interface OpenTurn<H> {
  wake:JournalEntry;speaker:string|null;start_ms?:number;end_ms:number;parts:JournalEntry[];last?:ProcessedEvent;host:H;follows?:string;carrier?:Carrier;voice_session_id?:string;voice_continuation?:true;
}
/** A delivered reply's follow-up window on the device that heard its turn: the asker's voice, the replied D and its request
 *  speech, delivery, the estimated end of the reply being read out, and the window's end. */
interface FollowUp {speaker:string;follows:string;carrier?:Carrier;from_ms:number;anchor_ms:number;until_ms:number}
interface PayWindow {from_ms:number;until_ms:number;phrases:Set<string>;heard:(u:UtteranceRef&{text:string;speaker:string|null})=>void}
const payPhrase=(text:string)=>stripWake(text).replace(/[\s\p{P}\p{S}]/gu,'');
/** Whether a live call on the device took its microphone's audio during the span (UTC ms) — the call answers what it hears. */
export type CallHeard=(principal:string,device:string,span:{start_ms:number;end_ms:number})=>boolean;
export type VoiceOpenIntent='dial'|'automatic';

const person=(label:string|null)=>label==='owner_uncertain'?'owner':label;
/** The one identified voice of a turn D (the turn consumer's identity over its request), or null. */
function turnVoice(d:ProcessedEvent):string|null {
  const voices=new Set(d.speakers.flatMap(entry=>{const e=entry as {identity_scope?:unknown;voiceprint?:unknown}|null;
    return e?.identity_scope==='local_voiceprint'&&typeof e.voiceprint==='string'&&parseSpeakerLabel(e.voiceprint)?[person(e.voiceprint)!]:[];}));
  return voices.size===1?[...voices][0]!:null;
}
/** Syllables a reply takes to read out: a Han, kana or Hangul character each, about three letters or digits otherwise. */
const syllables=(text:string)=>[...text].reduce((n,c)=>n+(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(c)?1:
  /[\p{L}\p{N}]/u.test(c)?1/3:0),0);
const iso=(ms:number)=>new Date(ms).toISOString();
/** The journal is a derived search index. Each result points back to the archived observation. */
function journalEvidence(e:JournalEntry) {
  return {processed_event_id:e.processed_event_id,segment_id:e.segment_id,raw_ref:e.raw_ref,archive_revision:e.archive_revision,
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:e.start_ms,end_ms:e.end_ms}};
}
interface ObservedSegment {
  start_sample?:unknown;end_sample_exclusive?:unknown;text?:unknown;speaker?:unknown;identity_scope?:unknown;speaker_score?:unknown;
  wake?:{keyword?:unknown;end_sample?:unknown};lang?:unknown;event?:unknown;emotion?:unknown;
  source_parts?:{clipped_scope_range?:{kind:string;timebase_id:string;start_ms:number;end_ms:number}}[];
}
function utcSpan(range:{kind:string;timebase_id:string;start_ms?:number;end_ms?:number}|undefined,end?:{end_ms?:number},rounded=true):[number,number] {
  // The journal is wall-clock: production clock maps target utc_epoch_ms; any other timebase cannot be placed.
  check(range?.kind==='interval'&&range.timebase_id==='utc_epoch_ms','AMBIENT_UTC_TIMEBASE_REQUIRED',422);
  return rounded?[Math.floor(range.start_ms!),Math.ceil((end??range).end_ms!)]:[range.start_ms!,(end??range).end_ms!];
}
function transcription(d:ProcessedEvent):{segments?:ObservedSegment[]}|undefined {
  return (Array.isArray(d.content.audio_observations)?d.content.audio_observations:[]).find(value=>value!==null&&
    typeof value==='object'&&!Array.isArray(value)&&value.observation_kind==='sample_transcription') as {segments?:ObservedSegment[]}|undefined;
}
/** Utterances of one captured-speech D: the local transcription's segments (speaker labels only from the local voiceprint
 *  scope, the wake word's end mapped onto the utterance's span), or a single utterance for a plain string transcript.
 *  Empty text with a classified event or emotion is journaled. 依米's own voice heard back is journaled as 依米 and its wake
 *  words are not wake words. */
export function utterances(d:ProcessedEvent):JournalUtterance[] {
  const observation=transcription(d);
  if(!observation){
    const text=typeof d.content.transcript==='string'?d.content.transcript.trim():'';
    if(!text)return [];
    const [start_ms,end_ms]=utcSpan(d.time_range as never);
    return [{segment_index:0,start_ms,end_ms,speaker:null,score:null,text,lang:null,wake:null,wake_cut_ms:null}];
  }
  return (observation.segments??[]).flatMap((segment,segment_index)=>{
    const voiceprint=segment.identity_scope==='local_voiceprint'&&parseSpeakerLabel(segment.speaker)?segment.speaker as string:null;
    const text=typeof segment.text==='string'?segment.text.trim():'';
    const wake=typeof segment.wake?.keyword==='string'&&voiceprint!=='assistant'?segment.wake.keyword:null;
    const event=SOUND_EVENTS.includes(segment.event as SoundEvent)?segment.event as SoundEvent:undefined;
    const emotion=SPEECH_EMOTIONS.includes(segment.emotion as SpeechEmotion)?segment.emotion as SpeechEmotion:undefined;
    if(!text&&!wake&&!event&&!emotion)return [];
    const parts=(segment.source_parts??[]).filter(part=>part.clipped_scope_range);
    const [start_ms,end_ms]=utcSpan(parts[0]?.clipped_scope_range,parts.at(-1)?.clipped_scope_range);
    const samples=Number(segment.end_sample_exclusive)-Number(segment.start_sample),cut=Number(segment.wake?.end_sample);
    return [{segment_index,start_ms,end_ms,speaker:voiceprint,score:voiceprint&&typeof segment.speaker_score==='number'?segment.speaker_score:null,
      text,lang:typeof segment.lang==='string'?segment.lang:null,wake,...(event?{event}:{}),...(emotion?{emotion}:{}),
      wake_cut_ms:wake===null?null:Math.min(end_ms,start_ms+Math.round((end_ms-start_ms)*(samples>0&&cut>=0?cut/samples:0)))}];
  });
}

/** The ambient lane, the one authority for what opens a turn: every continuous D is journaled and never runs; a turn opens
 *  on a wake word, or — a follow-up — on the next utterance of the voice whose turn's reply was just delivered, without the
 *  wake word (see `replied`). Its request is the same speaker's consecutive utterances (words after the wake word in its own
 *  utterance, or utterances starting within the follow window after a wake word said alone; a follow-up's own words) until
 *  a pause of the turn gap, the turn cap, another voice (依米's own included: a reply heard back never opens, joins or
 *  continues a request) or a new wake word. Speech a live call on the device heard is the call's to answer: it is journaled
 *  but never opens or joins a turn (the same request would run twice), and it ends a turn or a follow-up window opened
 *  before the call. The wake-only utterance is a trigger, never part of the request. Open turns and follow-up windows are
 *  per device and held in memory (a restart drops them); a retried D was decided when it was first journaled. A wake may
 *  open neutral voice immediately. That session retains these same turns for identity and scoped admission. Its call
 *  lifetime comes from voice_active, and assistant echo never closes its pending wake or becomes a request. */
export class AmbientLane<H> {
  readonly journal:AmbientJournal;
  private readonly turns=new Map<string,OpenTurn<H>>();
  private readonly voiceClaims=new Set<string>();
  private readonly voiceSessions=new Map<string,{id:string;carrier?:Carrier}>();
  private readonly voiceActive:((principal:string,device:string,id:string)=>boolean)|undefined;
  private readonly followUps=new Map<string,FollowUp>();
  private readonly payWindows=new Map<string,PayWindow>();
  private readonly heard:CallHeard|undefined;
  private readonly now:()=>number;
  constructor(journal:AmbientJournal,options:{call_heard?:CallHeard;now?:()=>number;voice_active?:(principal:string,device:string,id:string)=>boolean}={}){
    this.journal=journal;this.voiceActive=options.voice_active;this.heard=options.call_heard;this.now=options.now??Date.now;
  }
  /** The payment authority owns eligibility and expiry. This device window only diverts matching journal speech. */
  openPayWindow(options:{principal_id:string;device_id:string;until_ms:number;phrases:string[]},
    heard:(u:UtteranceRef&{text:string;speaker:string|null})=>void):()=>void {
    const key=digest([options.principal_id,options.device_id]);
    const window:PayWindow={from_ms:this.now(),until_ms:options.until_ms,phrases:new Set(options.phrases.map(payPhrase).filter(Boolean)),heard};
    this.payWindows.set(key,window);
    return ()=>{if(this.payWindows.get(key)===window)this.payWindows.delete(key);};
  }
  private payHeard(d:ProcessedEvent,e:JournalEntry,key:string):boolean {
    const window=this.payWindows.get(key);
    if(!window)return false;
    if(this.now()>=window.until_ms){this.payWindows.delete(key);return false;}
    if(d.device_type!=='phone'&&d.device_type!=='glasses'||!window.phrases.has(payPhrase(e.text)))return false;
    // Journal bounds are whole milliseconds; archived PCM keeps the source's precise sample support.
    const segment=transcription(d)?.segments?.[e.segment_index],parts=(segment?.source_parts??[]).filter(part=>part.clipped_scope_range);
    const [start_ms,end_ms]=segment?utcSpan(parts[0]?.clipped_scope_range,parts.at(-1)?.clipped_scope_range,false):
      utcSpan(d.time_range as never,undefined,false);
    if(start_ms<window.from_ms||start_ms>=window.until_ms)return false;
    window.heard({device_id:e.device_id,device_type:d.device_type,raw_ref:e.raw_ref,archive_revision:e.archive_revision,
      start_ms,end_ms,captured_at:iso(start_ms),processed_event_id:e.processed_event_id,transcript:e.text,
      text:e.text,speaker:e.speaker});
    return true;
  }
  /** Journal one continuous D; returns the turns its utterances closed. */
  observe(d:ProcessedEvent,host:H):WakeTurn<H>[] {
    const decisions=this.decide(d,host);let step=decisions.next();
    while(!step.done)step=decisions.next(false);
    return step.value;
  }
  /** Open a neutral voice session on a wake. Retain its audio turn for the existing identity analysis and admission. */
  async observeVoice(d:ProcessedEvent,host:H,offer:(wake:JournalEntry)=>Promise<boolean>,serverWake=true):Promise<WakeTurn<H>[]> {
    const decisions=this.decide(d,host,serverWake);let step=decisions.next();
    while(!step.done)step=decisions.next(await this.claimVoice(d.principal_id,d.device_id,()=>offer(step.value as JournalEntry)));
    return step.value;
  }
  /** Reserve one device's decision before any asynchronous call opening, including a turn verified on reanalysis. */
  async claimVoice(principal:string,device:string,offer:()=>Promise<boolean>):Promise<boolean> {
    const key=digest([principal,device]);if(this.voiceClaims.has(key))return true;
    this.voiceClaims.add(key);
    try {return await offer();}
    finally {this.voiceClaims.delete(key);}
  }
  /** Automatic openings share the wake claim. An explicit dial reaches the call owner, which owns replacement. */
  async openVoice(principal:string,device:string,id:string,offer:()=>Promise<boolean>,intent?:VoiceOpenIntent):Promise<boolean> {
    const key=digest([principal,device]);
    const accepted=intent==='dial'?await offer():!this.voiceClaims.has(key)&&await this.claimVoice(principal,device,offer);
    if(!accepted)return false;
    const active=this.voiceActive?.(principal,device,id)!==false;
    if(intent==='dial')check(active,'VOICE_CALL_SUPERSEDED',409);
    if(!active)return false;
    this.voiceSessions.set(key,{id});return true;
  }
  private *decide(d:ProcessedEvent,host:H,serverWake=true):Generator<JournalEntry,WakeTurn<H>[],boolean> {
    if(this.journal.entriesOf(d.principal_id,d.processed_event_id).length)return [];
    const entries=this.journal.append({principal_id:d.principal_id,device_id:d.device_id,processed_event_id:d.processed_event_id,
      raw_ref:d.raw_ref,archive_revision:d.archive_revision,segment_id:d.segment_id!},utterances(d));
    const key=digest([d.principal_id,d.device_id]),closed:WakeTurn<H>[]=[];
    let voice=this.activeVoice(d.principal_id,d.device_id);
    for(const e of entries) {
      if(this.payHeard(d,e,key)){
        const turn=this.turns.get(key);this.turns.delete(key);this.followUps.delete(key);
        if(turn?.parts.length){const ready=this.ready(turn);if(!this.callOwns(ready))closed.push(ready);}
        continue;
      }
      // A classified sound with no words is a journal observation, never a request or follow-up.
      if(!e.text&&(e.event||!e.wake))continue;
      if(this.voiceClaims.has(key)){this.followUps.delete(key);continue;}
      if(voice&&e.speaker==='assistant')continue;
      let turn=this.turns.get(key);
      const call=!voice&&this.heard?.(d.principal_id,d.device_id,e)===true;
      if(turn&&(call||!this.joins(turn,e))){this.turns.delete(key);if(turn.parts.length){const ready=this.ready(turn);if(!this.callOwns(ready))closed.push(ready);}turn=undefined;}
      if(turn){turn.parts.push(e);turn.speaker??=person(e.speaker);turn.start_ms??=e.start_ms;turn.end_ms=e.end_ms;turn.last=d;turn.host=host;continue;}
      const follow=this.followUp(key,e,call);
      if(call)continue;
      if(voice&&(e.wake===null||!serverWake)&&e.speaker!=='assistant') {
        this.turns.set(key,{wake:e,speaker:person(e.speaker),start_ms:e.start_ms,end_ms:e.end_ms,parts:[e],last:d,host,
          voice_session_id:voice.id,voice_continuation:true,...(voice.carrier?.raw_ref===d.raw_ref?{carrier:voice.carrier}:{})});continue;
      }
      if(follow){this.turns.set(key,{wake:e,speaker:follow.speaker,start_ms:e.start_ms,end_ms:e.end_ms,parts:[e],last:d,host,follows:follow.follows,
        ...(follow.carrier?.raw_ref===d.raw_ref?{carrier:follow.carrier}:{})});continue;}
      // Local-wake terminals own new voice activation; their continuous speech remains in the journal.
      if(e.wake===null||!serverWake)continue;
      let voice_session_id=voice?.id;
      if(!voice&&(yield e)) {
        const proposed=digest([e.processed_event_id,e.segment_index]);
        if(this.voiceActive?.(d.principal_id,d.device_id,proposed)===false)continue;
        voice_session_id=proposed;this.voiceSessions.set(key,{id:voice_session_id});voice=this.activeVoice(d.principal_id,d.device_id);
      }
      const inline=wakeCarriesRequest(e.text,e.end_ms-e.wake_cut_ms!);
      this.turns.set(key,{wake:e,speaker:person(e.speaker),end_ms:e.end_ms,parts:inline?[e]:[],host,...(voice_session_id?{voice_session_id,...(!inline?{carrier:{start_ms:e.start_ms,end_ms:e.end_ms,raw_ref:d.raw_ref}}:{})}:{}),...(inline?{start_ms:e.wake_cut_ms!,last:d}:{})});
    }
    return closed;
  }
  /** A turn's reply was delivered (`at_ms`, wall clock; the default is now): the next utterance of the voice the turn was
   *  identified as — or one too short to identify, which the turn consumer then identifies together with the replied
   *  request's speech — heard on the device that heard the turn, opens a follow-up turn without the wake word. The server knows
   *  delivery, not playback or reading: the window runs from delivery until `follow_up_ms` after the reply would have been
   *  read out (`reply_unit_ms` per syllable, capped). A chained follow-up's reply re-arms it. Nothing is armed for an
   *  empty reply, a non-turn D or a turn whose voice is unknown (who answers could not be told). */
  replied(d:ProcessedEvent,reply:string,at_ms=this.now()):void {
    const speaker=turnVoice(d),policy=this.journal.policy;
    if(d.content.wake_request===undefined||speaker===null||speaker==='assistant'||!reply.trim()||!Number.isFinite(at_ms))return;
    const from=Math.round(at_ms),anchor=from+Math.min(policy.reply_max_ms,Math.round(syllables(reply)*policy.reply_unit_ms));
    const heard=Date.parse(String((d.content.wake_request as {heard_at?:unknown}).heard_at)),range=d.time_range as {kind:string;timebase_id?:string;end_ms?:number}|undefined;
    const carrier=range?.kind==='interval'&&range.timebase_id==='utc_epoch_ms'&&Number.isFinite(heard)&&heard<range.end_ms!?
      {start_ms:heard,end_ms:range.end_ms!,raw_ref:d.raw_ref}:undefined;
    const key=digest([d.principal_id,d.device_id]),voice=this.activeVoice(d.principal_id,d.device_id);
    if(voice&&carrier)voice.carrier=carrier;
    this.followUps.set(key,{speaker,follows:d.processed_event_id,...(carrier?{carrier}:{}),from_ms:from,anchor_ms:anchor,
      until_ms:anchor+policy.follow_up_ms});
  }
  /** Whether `e` opens a follow-up of the device's armed window. Speech from before the delivery, and 依米's own reply heard
   *  back while it would still be playing, neither open nor end it. Anything else ends it: the asker's next utterance, or one
   *  too short to identify ("杭州", "好的": the turn consumer identifies it with the carrier), opens the follow-up — unless it
   *  has the wake word (then it is a wake turn) or a live call heard it — and the timeout, another identified voice or
   *  依米's voice after the reply end it unanswered. */
  private followUp(key:string,e:JournalEntry,call:boolean):FollowUp|undefined {
    const w=this.followUps.get(key),who=person(e.speaker);
    if(!w||e.start_ms<w.from_ms||who==='assistant'&&e.start_ms<w.anchor_ms)return undefined;
    this.followUps.delete(key);
    return e.start_ms<=w.until_ms&&!call&&e.wake===null&&(who===null||who===w.speaker)?w:undefined;
  }
  /** The detector heard no speech on the device through `through_ms`: a turn whose pause reached the gap (or whose input
   *  ended) closes; a wake word alone past the follow window lapses, and so does a follow-up window past its end. */
  silence(principal:string,device:string,through_ms:number,exhausted=false,raw_ref?:string):WakeTurn<H>[] {
    const key=digest([principal,device]);this.activeVoice(principal,device);
    const turn=this.turns.get(key),policy=this.journal.policy;
    if(raw_ref!==undefined&&turn&&turn.wake.raw_ref!==raw_ref)return [];
    if((this.followUps.get(key)?.until_ms??Infinity)<through_ms)this.followUps.delete(key);
    if(!turn)return [];
    if(!turn.parts.length){if(exhausted||through_ms-turn.wake.end_ms>policy.request_follow_ms)this.turns.delete(key);return [];}
    if(!exhausted&&through_ms-turn.end_ms<policy.turn_gap_ms&&through_ms-turn.start_ms!<policy.turn_max_ms)return [];
    this.turns.delete(key);const ready=this.ready(turn);return this.callOwns(ready)?[]:[ready];
  }
  private activeVoice(principal:string,device:string) {
    const key=digest([principal,device]),voice=this.voiceSessions.get(key);
    if(voice&&this.voiceActive?.(principal,device,voice.id)===true)return voice;
    if(voice){this.voiceSessions.delete(key);if(this.turns.get(key)?.voice_session_id)this.turns.delete(key);this.followUps.delete(key);}
    return undefined;
  }
  /** A manual call owns its audio. An ambient voice session retains the existing identity turn. */
  callOwns(turn:WakeTurn<H>):boolean {
    return !turn.voice_session_id&&this.heard?.(turn.last.principal_id,turn.last.device_id,turn.window)===true;
  }
  /** A follow-up's window opens with its carrier when both fit the turn consumer's budget. */
  private ready(turn:OpenTurn<H>):WakeTurn<H> {
    const carrier=turn.carrier&&turn.end_ms-turn.carrier.start_ms<=TURN_WINDOW_MAX_MS&&turn.carrier.end_ms<=turn.start_ms!?turn.carrier:undefined;
    const start=carrier?carrier.start_ms:turn.end_ms-turn.wake.start_ms<=this.journal.policy.turn_max_ms?turn.wake.start_ms:turn.start_ms!;
    return {wake:turn.wake,parts:turn.parts,window:{start_ms:start,end_ms:turn.end_ms},request_start_ms:turn.start_ms!,last:turn.last!,host:turn.host,
      ...(turn.follows?{follows:turn.follows}:{}),...(turn.voice_session_id?{voice_session_id:turn.voice_session_id}:{}),...(turn.voice_continuation?{voice_continuation:true}:{}),...(carrier?{speaker_carrier:{end_ms:carrier.end_ms,request_start_ms:turn.start_ms!}}:{})};
  }
  private joins(turn:OpenTurn<H>,e:JournalEntry):boolean {
    const policy=this.journal.policy,who=person(e.speaker);
    if(turn.wake.raw_ref!==e.raw_ref||e.wake!==null||who==='assistant'||turn.speaker!==null&&who!==null&&who!==turn.speaker)return false;
    if(!turn.parts.length)return e.start_ms-turn.wake.end_ms<=policy.request_follow_ms;
    return e.start_ms-turn.end_ms<=policy.turn_gap_ms&&e.end_ms-turn.start_ms!<=policy.turn_max_ms;
  }
  /** The utterance an earlier turn opened at, from its D's framing (for "确认是我", which re-admits it as the owner). */
  opener(principal:string,framing:unknown):JournalEntry|undefined {
    const f=framing as Partial<{kind:string;heard_at:string;wake_processed_event_id:string;opened_processed_event_id:string}>|null|undefined;
    if(f?.kind==='ambient_follow_up'||f?.kind==='ambient_voice')return typeof f.opened_processed_event_id==='string'?
      this.journal.entriesOf(principal,f.opened_processed_event_id).find(e=>iso(e.start_ms)===f.heard_at):undefined;
    return typeof f?.wake_processed_event_id==='string'?this.journal.entriesOf(principal,f.wake_processed_event_id).find(e=>e.wake!==null):undefined;
  }
  /** The conversation heard before the turn opened, newest kept first within the byte budget, then chronological. */
  context(wake:JournalEntry,names:SpeakerNames):AmbientContext {
    const entries:AmbientContext['entries']=[];let bytes=2,truncated=false;
    for(const e of this.journal.context(wake)) {
      if(!e.text)continue;
      const item={at:iso(e.start_ms),...names(e.speaker),speaker_ref:e.speaker??'unknown',text:e.text,
        evidence:journalEvidence(e),instruction_eligible:e.speaker==='owner'},size=Buffer.byteLength(canonical(item))+1;
      if(bytes+size>this.journal.policy.context_max_bytes){truncated=true;break;}
      entries.unshift(item);bytes+=size;
    }
    return {conversation_id:wake.conversation_id,entries,truncated};
  }
  request(turn:WakeTurn<H>,text:string,context?:AmbientContext):TurnRequest {
    const request=stripWake(text).slice(0,4000),heard_at=iso(turn.request_start_ms);
    if(turn.voice_continuation)return {kind:'ambient_voice',text:request,heard_at,voice_session_id:turn.voice_session_id!,
      opened_processed_event_id:turn.wake.processed_event_id,...(context?{context}:{})};
    const voice=turn.voice_session_id?{voice_session_id:turn.voice_session_id}:{};
    return turn.follows?{kind:'ambient_follow_up',text:request,heard_at,follows_processed_event_id:turn.follows,
      opened_processed_event_id:turn.wake.processed_event_id,...voice,...(context?{context}:{})}:
      {kind:'ambient_wake',wake:turn.wake.wake!,text:request,heard_at,wake_processed_event_id:turn.wake.processed_event_id,...voice,...(context?{context}:{})};
  }
  /** Owner journal search with read-time names. `speaker`: owner / 主人, unknown / 未识别, assistant / 依米, speaker:N / 说话人#N,
   *  or a given name. */
  search(principal:string,args:Record<string,unknown>,names:SpeakerNames,clusters:{cluster_id:string;display_name:string|null;aliases?:{ids:string[];names:string[]}}[]):Json {
    const time=(value:unknown)=>{if(value===undefined)return undefined;
      check(typeof value==='string'&&Number.isFinite(Date.parse(value)),'AMBIENT_SEARCH_TIME_INVALID',422);return Date.parse(value);};
    const limit=args.limit===undefined?20:args.limit;
    check(Number.isSafeInteger(limit)&&Number(limit)>=1&&Number(limit)<=50&&(args.query===undefined||typeof args.query==='string'&&args.query.length<=200)&&
      (args.speaker===undefined||typeof args.speaker==='string'&&args.speaker.length<=64),'AMBIENT_SEARCH_INVALID',422);
    const speakers=args.speaker===undefined?undefined:resolveSpeaker(args.speaker as string,clusters,true);
    if(speakers&&!speakers.length)return {status:'found',entries:[],events:[],truncated:false,note:'speaker_not_found'};
    const result=this.journal.search({principal_id:principal,...(time(args.from)!==undefined?{from_ms:time(args.from)!}:{}),
      ...(time(args.until)!==undefined?{until_ms:time(args.until)!}:{}),...(speakers?{speakers}:{}),
      ...(args.event!==undefined?{event:args.event as SoundEvent}:{}),
      ...(typeof args.query==='string'&&args.query.trim()?{text:args.query}:{}),limit:Number(limit)});
    const entries:Json[]=[];let bytes=0,truncated=result.truncated;
    for(const e of result.entries) {
      const item={at:iso(e.start_ms),until:iso(e.end_ms),...names(e.speaker),speaker_ref:e.speaker??'unknown',text:e.text,
        conversation_id:e.conversation_id,evidence:journalEvidence(e),instruction_eligible:e.speaker==='owner',
        ...(e.speaker==='owner'&&e.emotion?{emotion:e.emotion}:{}),...(e.event?{event:e.event}:{})};
      bytes+=Buffer.byteLength(canonical(item));if(bytes>65536){truncated=true;break;}entries.push(item);
    }
    const events:Json[]=[];
    for(const e of result.events){const item={event:e.event,count:e.count,at:iso(e.start_ms),until:iso(e.end_ms),...names(e.speaker),
      device_id:e.device_id,burst_id:e.burst_id};bytes+=Buffer.byteLength(canonical(item));if(bytes>65536){truncated=true;break;}events.push(item);}
    return {status:'found',entries,events,truncated,classification:'model_observation_not_diagnosis'};
  }
}
/** Stored labels for a speaker reference the owner or the model used. */
export function resolveSpeaker(reference:string,clusters:{cluster_id:string;display_name:string|null;aliases?:{ids:string[];names:string[]}}[],includeAliases=false):string[] {
  const value=reference.trim();
  if(['owner','主人','我'].includes(value))return ['owner','owner_uncertain'];
  if(['unknown','未识别'].includes(value))return ['unknown'];
  if(['assistant','依米'].includes(value))return ['assistant'];
  const number=/^(?:speaker:|(?:说话人|人物)\s*#?|#)?(\d{1,9})$/u.exec(value)?.[1];
  const matches=clusters.filter(c=>number?c.cluster_id===number||c.aliases?.ids.includes(number):c.display_name===value||c.aliases?.names.includes(value));
  return [...new Set(matches.flatMap(c=>[c.cluster_id,...(includeAliases?c.aliases?.ids??[]:[])].map(id=>`speaker:${id}`)))];
}
/** Read-time display names from the registry's current cluster list. */
export function speakerNames(clusters:{cluster_id:string;label:string;aliases?:{ids:string[];names:string[]}}[]):SpeakerNames {
  const named=new Map(clusters.flatMap(c=>[c.cluster_id,...(c.aliases?.ids??[])].map(id=>[id,c.label] as const)));
  return label=>{
    if(label==='owner')return {speaker:'主人'};
    if(label==='owner_uncertain')return {speaker:'主人（未确认）'};
    if(label==='assistant')return {speaker:'依米'};
    const parsed=parseSpeakerLabel(label);
    if(parsed?.kind!=='speaker')return {speaker:'未识别'};
    return {speaker:named.get(parsed.cluster_id)??`说话人#${parsed.cluster_id}`,speaker_ref:label!};
  };
}
