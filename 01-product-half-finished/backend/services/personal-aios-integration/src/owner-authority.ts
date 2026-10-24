import {check,isIdentifier} from './contracts.ts';
import type {ProcessedEvent,TrustedContext} from './contracts.ts';

/** One D.speakers entry from the local voiceprint registry, aggregated per label over the D's speech segments.
 *  `unknown` covers segments the registry could not attribute (too short, low quality, unmatched); `assistant` is 依米's
 *  own voice heard back from a speaker. */
export interface VoiceprintSpeaker {
  identity_scope: 'local_voiceprint'; voiceprint: 'owner' | 'owner_uncertain' | `speaker:${string}` | 'assistant' | 'unknown';
  score: number | null; speech_ms: number; segments: number; call_only?: true;
}
const AUDIO_MEDIA = ['audio', 'muxed_av', 'livekit_tracks'];
function voiceprintEntries(event: Pick<ProcessedEvent, 'speakers'>): VoiceprintSpeaker[] {
  return event.speakers.filter(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
    entry.identity_scope === 'local_voiceprint') as unknown as VoiceprintSpeaker[];
}
// Voiceprint labels exist only on server-built captured-speech D (sample-results gates them to the local voiceprint worker).
export function validateVoiceprintSpeakers(event: ProcessedEvent): void {
  const entries = voiceprintEntries(event);
  if (!entries.length) return;
  check(AUDIO_MEDIA.includes(event.media_type) && (event.segment_basis === 'speech_candidate' || event.segment_basis === 'wake_turn') &&
    !['voice_frontend', 'direct_text', 'direct_app'].includes(event.processing.path_id), 'D_VOICEPRINT_SOURCE_INVALID');
  for (const entry of entries) check(Object.keys(entry).sort().join(',') === (entry.call_only===undefined?'identity_scope,score,segments,speech_ms,voiceprint':'call_only,identity_scope,score,segments,speech_ms,voiceprint') &&
    (entry.call_only===undefined||entry.call_only===true&&entry.voiceprint==='owner') &&
    (['owner', 'owner_uncertain', 'assistant', 'unknown'].includes(entry.voiceprint) ||
      entry.voiceprint.startsWith('speaker:') && isIdentifier(entry.voiceprint.slice(8))) &&
    (entry.score === null || Number.isFinite(entry.score) && entry.score >= -1 && entry.score <= 1) &&
    Number.isSafeInteger(entry.speech_ms) && entry.speech_ms >= 0 && Number.isSafeInteger(entry.segments) && entry.segments > 0,
    'D_VOICEPRINT_SPEAKER_INVALID');
  check(new Set(entries.map(entry => entry.voiceprint)).size === entries.length, 'D_VOICEPRINT_SPEAKER_INVALID');
}
/** Captured speech: an audio-bearing media D with audio results, except a voice-frontend turn the paired phone sent. */
function capturedSpeech(event: Pick<ProcessedEvent, 'media_type' | 'processing' | 'content'>): boolean {
  return AUDIO_MEDIA.includes(event.media_type) && event.processing.path_id !== 'voice_frontend' &&
    (event.content.transcript !== undefined || event.content.audio_observations !== undefined);
}
/** Who spoke a captured-speech D, from local voiceprint entries only. `owner`: all speech owner-verified, at least 1 s (a wake
 *  turn, identified over its wake word and request together and checked against the request alone, at least 0.8 s);
 *  `owner_uncertain`: owner speech present but not all verified (an uncertain band, or another voice in the same D — 依米's
 *  own voice included); `assistant`: all of it is 依米's own voice heard back, never a request; `other`: everything else,
 *  including speech with no voiceprint evidence at all. null: not captured speech. */
export function voiceEvidence(event: Pick<ProcessedEvent, 'media_type' | 'segment_basis' | 'processing' | 'content' | 'speakers'>):
  'owner' | 'owner_uncertain' | 'assistant' | 'other' | null {
  if (!capturedSpeech(event)) return null;
  const entries = voiceprintEntries(event), ms = (label: string) => entries.filter(e => e.voiceprint === label).reduce((n, e) => n + e.speech_ms, 0);
  const owner = ms('owner'), uncertain = ms('owner_uncertain'), others = entries.length - entries.filter(e => e.voiceprint.startsWith('owner')).length;
  const trustedOwner = owner > 0 && entries.every(entry=>entry.voiceprint==='owner') && entries.some(entry=>entry.call_only===true);
  if ((trustedOwner || owner >= (event.segment_basis === 'wake_turn' ? 800 : 1000)) && uncertain === 0 && others === 0) return 'owner';
  if (owner + uncertain > 0) return 'owner_uncertain';
  return entries.length > 0 && entries.every(e => e.voiceprint === 'assistant') ? 'assistant' : 'other';
}
export type RunScope = 'owner' | 'owner_uncertain' | 'guest';
/** Only server-framed speech addressed to the assistant on a paired terminal is eligible for biometric confirmation. */
export function directedVoice(event:Pick<ProcessedEvent,'origin'|'device_type'|'media_type'|'segment_basis'|'processing'>):boolean {
  return event.origin==='device_observation'&&['phone','mac','glasses'].includes(event.device_type)&&AUDIO_MEDIA.includes(event.media_type)&&
    (event.segment_basis==='wake_turn'||event.segment_basis==='speech_candidate'&&
      ['voice_frontend','voice_frontend_local_voiceprint'].includes(event.processing.path_id));
}
/** Privacy scope controls the context a run may read; ownerActionGrant separately owns action/request eligibility.
 *  Principal-attributed D and device-level observations keep owner scope. Directed paired speech that is not verified
 *  stays restricted until biometric confirmation; other unverified speech remains an isolated guest. */
export function runScope(event: Pick<ProcessedEvent, 'origin' | 'device_type' | 'media_type' | 'segment_basis' | 'user_identity' | 'principal_id' | 'content' | 'speakers' |
  'processing'>): RunScope {
  if (principalAttribution(event) !== null) return 'owner';
  if(directedVoice(event))return 'owner_uncertain';
  const app=event.content.app_event as {kind?:unknown;speaker?:unknown}|undefined;
  if(app?.kind==='voice_turn')return app.speaker==='owner_uncertain'?'owner_uncertain':'guest';
  if ((event.content.app_event as {kind?:unknown}|undefined)?.kind === 'glasses_gesture') return 'guest';
  const voice = voiceEvidence(event);
  return voice === null ? 'owner' : voice === 'other' || voice === 'assistant' ? 'guest' : 'owner_uncertain';
}
/** The guest's isolated session key (per speaker per local day) and dominant other voice label. */
export function guestKey(event: Pick<ProcessedEvent, 'speakers' | 'captured_at'> & {content?:ProcessedEvent['content']}): string {
  const others = voiceprintEntries(event).filter(e => e.voiceprint.startsWith('speaker:')).sort((a, b) => b.speech_ms - a.speech_ms);
  const day = new Intl.DateTimeFormat('en-CA', {year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(event.captured_at));
  const app=event.content?.app_event as {kind?:unknown;speaker?:unknown}|undefined;
  const speaker=app?.kind==='voice_turn'&&typeof app.speaker==='string'&&app.speaker.startsWith('speaker:')&&
    isIdentifier(app.speaker.slice(8))?app.speaker:others[0]?.voiceprint??'unknown';
  return `${speaker}:${day}`;
}
export type PrincipalAttribution = 'explicit_text' | 'owner_call_turn' | 'owner_confirmation' | 'owner_voice' | 'owner_gesture' | 'owner_override';
/** The one rule for a D attributable to its authenticated principal: an explicit typed prompt, a live-call turn the call
 *  source attested from the principal's own paired device, the paired phone's "确认是我" for an uncertain voice request,
 *  captured speech the local voiceprint registry verified as the owner's, or a server card answered in that verified wear session. Not business approval (L3 active writes
 *  still need exact user approval). */
export function principalAttribution(event: Pick<ProcessedEvent, 'origin' | 'media_type' | 'segment_basis' | 'user_identity' | 'principal_id' | 'content' |
  'speakers' | 'processing'>):
  PrincipalAttribution | null {
  const override=event.content.owner_override as {source_processed_event_id?:unknown;authority?:unknown}|undefined;
  if(event.origin==='device_observation'&&AUDIO_MEDIA.includes(event.media_type)&&
    override?.authority==='owner_override'&&typeof override.source_processed_event_id==='string'&&
    (event.segment_basis==='wake_turn'&&event.content.wake_request!==undefined||
      event.segment_basis==='speech_candidate'&&['voice_frontend','voice_frontend_local_voiceprint'].includes(event.processing.path_id)))return 'owner_override';
  if (event.user_identity !== event.principal_id) return null;
  if (event.origin === 'explicit_user_prompt' && event.media_type === 'text') return 'explicit_text';
  if (event.origin === 'device_observation' && event.media_type === 'app_event') {
    const app = event.content.app_event;
    return app !== null && typeof app === 'object' && !Array.isArray(app) && app.kind === 'voice_confirmation' ? 'owner_confirmation' :
      (app as {kind?:unknown}|undefined)?.kind === 'glasses_gesture' ? 'owner_gesture' :
      (app as {kind?:unknown;speaker?:unknown}|undefined)?.kind === 'voice_turn' &&
        (app as {speaker?:unknown}).speaker === 'owner' ? 'owner_call_turn' : null;
  }
  if (event.origin === 'device_observation' && voiceEvidence(event) === 'owner') return 'owner_voice';
  return null;
}

/** Only the authenticated native-cron admission path can carry isolated build inputs. */
export const isBuildTask=(d:ProcessedEvent):boolean=>d.source.channel==='background_scheduled'&&
  (d.content.app_event as {kind?:unknown}|undefined)?.kind==='build_task';

/** The only authority for owner requests. Continuations resolve their durable producer-owned origin. */
export type OwnerOriginResolver=(d:ProcessedEvent)=>Promise<ProcessedEvent|undefined>;
export async function ownerActionGrant(d: ProcessedEvent,resolve?:OwnerOriginResolver,
  request?:{payment_source:Pick<TrustedContext,'principal_id'|'device_id'|'device_type'>&{chat_ui:boolean}}):Promise<('desktop'|'terminal'|'file')[]> {
  const seen=new Set<string>();
  for(;;){
    if(seen.has(d.processed_event_id))return [];
    seen.add(d.processed_event_id);
    const kind=(d.content.app_event as {kind?:unknown}|undefined)?.kind;
    if(isBuildTask(d)||kind==='proactive_care'||kind==='place_transition')return [];
    // Errand continuation authorizes work, never a new per-request payment intent.
    if((kind==='errand_result'||kind==='errand_delivery_failed'||kind==='camera_result'||kind==='task_failure'||kind==='release_approval_required')&&request?.payment_source)return [];
    if(kind==='scheduled_task'||kind==='desktop_queue_task'||kind==='errand_result'||kind==='errand_delivery_failed'||kind==='camera_result'||kind==='task_failure'||kind==='release_approval_required'){
      const original=await resolve?.(d);
      if(!original||original.principal_id!==d.principal_id)return [];
      d=original;continue;
    }
    // Paired phone PTT can request a payment card; it never grants native desktop tools or proves a voice payment.
    const source=request?.payment_source;
    if(source?.device_type==='phone'&&source.chat_ui&&source.device_id===d.device_id&&source.principal_id===d.principal_id&&
      d.processing.path_id==='voice_frontend')return ['desktop','terminal','file'];
    const attribution=principalAttribution(d);
    return attribution!==null&&attribution!=='owner_gesture'?['desktop','terminal','file']:[];
  }
}
