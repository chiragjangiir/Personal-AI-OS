import {check} from '../contracts.ts';
import type {VoiceprintChannel} from './contracts.ts';

export interface VoiceprintScoring {
  cohort?: Float32Array[];
  cohort_top_k?: number;
  calibration?: Partial<Record<VoiceprintChannel, {verified: number; uncertain: number}>>;
}
const cosine=(a:Float32Array,b:Float32Array)=>{
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]!*b[i]!;aa+=a[i]!*a[i]!;bb+=b[i]!*b[i]!;}
  check(aa>0&&bb>0,'VOICEPRINT_COHORT_INVALID');return dot/Math.sqrt(aa*bb);
};
/** Adaptive symmetric score normalization. The highest impostor scores form each side's cohort. */
export function normalizedScore(probe:Float32Array,reference:Float32Array,cohort:Float32Array[],topK=20):number {
  check(cohort.length>=2&&Number.isSafeInteger(topK)&&topK>=2&&cohort.every(v=>v.length===probe.length&&v.every(Number.isFinite)),
    'VOICEPRINT_COHORT_INVALID');
  const statistics=(vector:Float32Array)=>{
    const scores=cohort.map(c=>cosine(vector,c)).sort((a,b)=>b-a).slice(0,topK),mean=scores.reduce((a,b)=>a+b,0)/scores.length;
    // A variance floor prevents a homogeneous cohort from amplifying float rounding into an arbitrary score.
    const deviation=Math.max(.01,Math.sqrt(scores.reduce((n,s)=>n+(s-mean)**2,0)/scores.length));
    return {mean,deviation};
  };
  const a=statistics(probe),b=statistics(reference),raw=cosine(probe,reference);
  return .5*((raw-a.mean)/a.deviation+(raw-b.mean)/b.deviation);
}
