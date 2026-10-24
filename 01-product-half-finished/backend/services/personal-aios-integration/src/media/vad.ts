import {check} from '../contracts.ts';

export interface VadConfig {
  sample_rate: number; frame_ms: number; rms_threshold: number;
  silence_ms: number; min_speech_ms: number; max_candidate_ms: number; max_chunk_samples: number;
  candidate_overlap_ms: number;
}
export interface SpeechCandidate {
  start_ms: number; end_ms: number; basis: 'silence' | 'resource_limit' | 'gap' | 'flush';
  semantic_status: 'open';
  overlap_context_ms: number;
}
// PCM16 mono frame-energy candidate detector, not speaker identification or semantic inference.
// The partial analysis frame survives receive-chunk boundaries; silence is still archived upstream.
export class PcmVad {
  private pending: number[] = [];
  private frameStart = 0;
  private nextMs: number | null = null;
  private speechStart: number | null = null;
  private lastSpeechEnd = 0;
  private voicedMs = 0;
  private overlapContextMs = 0;
  readonly frameSamples: number;
  readonly config: VadConfig;
  constructor(config: VadConfig) {
    this.config=config;
    check(Object.values(config).every(n => Number.isFinite(n) && n > 0) && config.rms_threshold <= 1,
      'INVALID_VAD_CONFIG');
    this.frameSamples = config.sample_rate*config.frame_ms/1000;
    check(Number.isSafeInteger(this.frameSamples) && this.frameSamples > 0 &&
      config.max_candidate_ms >= config.frame_ms && config.max_chunk_samples >= this.frameSamples,
      'INVALID_VAD_FRAME');
    check(config.candidate_overlap_ms<config.max_candidate_ms&&config.candidate_overlap_ms%config.frame_ms===0,'INVALID_VAD_OVERLAP');
  }
  private close(basis: SpeechCandidate['basis'], end: number): SpeechCandidate[] {
    const candidate = this.speechStart !== null && this.voicedMs >= this.config.min_speech_ms ?
      [{start_ms:this.speechStart,end_ms:end,basis,semantic_status:'open' as const,overlap_context_ms:this.overlapContextMs}] : [];
    this.speechStart=null; this.voicedMs=0;this.overlapContextMs=0; return candidate;
  }
  feed(pcm: Uint8Array, sourceStartMs: number): SpeechCandidate[] {
    check(pcm.byteLength%2 === 0 && pcm.byteLength > 0 && pcm.byteLength/2 <= this.config.max_chunk_samples &&
      Number.isFinite(sourceStartMs), 'INVALID_VAD_PCM');
    const out: SpeechCandidate[] = [];
    if (this.nextMs !== null && Math.abs(sourceStartMs-this.nextMs) > 0.001) {
      check(sourceStartMs >= this.nextMs, 'VAD_OUT_OF_ORDER');
      out.push(...this.close('gap',this.lastSpeechEnd)); this.pending=[];
    }
    if (this.pending.length === 0) this.frameStart=sourceStartMs;
    const view = new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
    for (let i=0; i<pcm.byteLength; i+=2) {
      this.pending.push(view.getInt16(i,true)/32768);
      if (this.pending.length < this.frameSamples) continue;
      const start=this.frameStart, end=start+this.config.frame_ms;
      const rms=Math.sqrt(this.pending.reduce((s,v)=>s+v*v,0)/this.pending.length);
      this.pending=[]; this.frameStart=end;
      if (rms >= this.config.rms_threshold) {
        if (this.speechStart === null) this.speechStart=start;
        this.lastSpeechEnd=end; this.voicedMs+=this.config.frame_ms;
      }
      if (this.speechStart !== null && end-this.speechStart >= this.config.max_candidate_ms) {
        const emitted=this.close('resource_limit',this.lastSpeechEnd);out.push(...emitted);
        if(emitted.length){this.speechStart=this.lastSpeechEnd-this.config.candidate_overlap_ms;this.overlapContextMs=this.config.candidate_overlap_ms;}
      }
      else if (this.speechStart !== null && end-this.lastSpeechEnd >= this.config.silence_ms)
        out.push(...this.close('silence',this.lastSpeechEnd));
    }
    this.nextMs=sourceStartMs+pcm.byteLength/2*1000/this.config.sample_rate;
    return out;
  }
  flush(): SpeechCandidate[] {
    const out=this.close('flush',this.lastSpeechEnd); this.pending=[]; this.nextMs=null; return out;
  }
}
