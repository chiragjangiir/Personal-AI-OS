import { check, digest, validateProcessed, type ArchivedEvent, type ProcessedEvent, type RawEvent, type TrustedContext,
  type Json } from './contracts.ts';
import { RawArchive } from './archive.ts';

export class UnifiedIngress {
  private readonly archive: RawArchive;
  constructor(archive: RawArchive) { this.archive = archive; }
  archiveUpload(raw:RawEvent,trusted:TrustedContext):Promise<ArchivedEvent> {
    check((raw.media_type==='visual'&&raw.mime.startsWith('image/')||raw.media_type==='file')&&raw.representation==='uploaded_original',
      'ORIGINAL_UPLOAD_REQUIRED');
    check(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]+)?$/u.test(raw.mime),'INVALID_UPLOAD_MIME');
    return this.archive.archive(raw,trusted);
  }
  async accept(raw: RawEvent, trusted: TrustedContext): Promise<ProcessedEvent> {
    // Validate actual text/App bytes before publishing a success; preserve exact original bytes.
    let content: ProcessedEvent['content'];
    if (raw.media_type === 'text') {
      check(raw.mime === 'text/plain;charset=utf-8', 'TEXT_ENCODING_UNSUPPORTED');
      const text = new TextDecoder('utf-8', {fatal: true}).decode(raw.payload);
      check(text.trim().length > 0 || Boolean(raw.attachments?.length), 'EMPTY_TEXT');
      content = {text};
    } else if (raw.media_type === 'app_event') {
      check(raw.mime === 'application/json', 'APP_ENCODING_UNSUPPORTED');
      let parsed: Json;
      try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw.payload)) as Json; }
      catch { throw new Error('APP_PAYLOAD_INVALID'); }
      // Finite JSON validity is checked by digest; the raw serialization is retained in L5.
      digest(parsed);
      check(trusted.submission !== 'owner_call_turn' || parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
        parsed.kind === 'voice_turn' && parsed.speaker === 'owner', 'CALL_TURN_PAYLOAD_INVALID');
      // Only the server-side "确认是我" path may present a voice confirmation, and it presents nothing else.
      const confirmation = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.kind === 'voice_confirmation';
      check(confirmation === (trusted.submission === 'owner_confirmation'), 'VOICE_CONFIRMATION_PAYLOAD_INVALID');
      const gesture = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.kind === 'glasses_gesture';
      check(gesture === (trusted.submission === 'owner_gesture' || trusted.submission === 'unidentified_gesture'), 'GESTURE_PAYLOAD_INVALID');
      if(parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed)&&['errand_result','camera_result'].includes(String(parsed.kind))&&parsed.origin_processed_event_id!==undefined)
        check(trusted.submission==='errand_result','ERRAND_REPLAY_CONFLICT',403);
      content = {app_event: parsed};
    } else {
      await this.archive.archive(raw, trusted);
      throw new Error('MEDIA_PREPROCESSING_NOT_CONFIGURED');
    }
    const archived = await this.archive.archive(raw, trusted);
    return this.finalize(archived,content);
  }
  /** A server observation retry keeps the first durable capture, including its source and processing identity. */
  async replayApp(archived:ArchivedEvent):Promise<ProcessedEvent> {
    check(archived.media_type==='app_event','APP_REPLAY_REQUIRED');
    const bytes=await this.archive.read(archived.raw_ref,archived.principal_id,archived.archive_revision);
    return this.finalize(archived,{app_event:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Json});
  }
  private finalize(archived:ArchivedEvent,content:ProcessedEvent['content']):ProcessedEvent {
    const {attachments, ...source} = archived;
    if (attachments !== undefined) content = {...content, attachments};
    const processed: ProcessedEvent = {...source,
      processed_event_id: `d:${digest({raw_ref: archived.raw_ref, archive_revision: archived.archive_revision,
        policy_version: 'direct-4.1.1'})}`, revision: 1, replaces_processed_event_id: null,
      segment_id: null, segment_basis: null, continuation_hint: 'not_applicable', continuation: null,
      coverage: {status: 'complete', missing_ranges: []}, content, speakers: [],
      intent_class: archived.origin === 'explicit_user_prompt' ? 'explicit_request' : 'observation',
      reply_hint: archived.origin === 'explicit_user_prompt' ? 'respond' : 'policy',
      processing: {path_id: archived.media_type === 'text' ? 'direct_text' : 'direct_app', models: [],
        policy_version: 'direct-4.1.1', archive_revision: archived.archive_revision, completed_at: archived.received_at},
      quality: {status: 'complete', warnings: []}};
    validateProcessed(processed);
    return processed;
  }
}
