import type {ModelFile} from '../voiceprint/engine.ts';

export interface CallTurnConfiguration {
  enabled:boolean;model:ModelFile;thinking_sound:ModelFile&{model:string;voice:string};
  threshold?:number;max_wait_ms?:number;thinking_reply_ms?:number;
}
export const THINKING_MAX_BYTES:number;
export function parseCallTurnConfiguration(value:unknown,model:string,voice:string):CallTurnConfiguration;
export function openTurnModel(config:ModelFile):Promise<{
  score(samples:Float32Array,signal?:AbortSignal):Promise<number>;
  snapshot():{
    state:'unloaded'|'loading'|'ready'|'closing'|'failed'|'closed';session_count:number;jobs:number;queued_jobs:number;
    active_audio_bytes:number;queued_audio_bytes:number;admitted_audio_bytes:number;
    limits:{jobs:number;audio_samples:number;audio_bytes:number};
    session_options:{executionProviders:string[];executionMode:string;intraOpNumThreads:number;
      interOpNumThreads:number;graphOptimizationLevel:string;enableCpuMemArena:boolean};
    process_rss_bytes:number;worker_memory?:{heapUsed:number;external:number;arrayBuffers:number};
  };
  close():Promise<void>;
}>;

export function whisperLogMel(samples:Float32Array):Float32Array;
