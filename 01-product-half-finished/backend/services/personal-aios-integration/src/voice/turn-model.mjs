import {check,ContractError} from '../contracts.ts';
import {isAbsolute} from 'node:path';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {verifyModelFile} from '../voiceprint/engine.ts';

export const THINKING_MAX_BYTES=96000; // at most 2 s of 24 kHz mono PCM16

export function parseCallTurnConfiguration(value,model,voice) {
  const c=value;
  const pinned=f=>f&&typeof f.path==='string'&&isAbsolute(f.path)&&/^[a-f0-9]{64}$/u.test(f.sha256);
  check(c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).every(k=>['enabled','model','thinking_sound','threshold',
    'max_wait_ms','thinking_reply_ms'].includes(k))&&typeof c.enabled==='boolean'&&pinned(c.model)&&
    Object.keys(c.model).sort().join(',')==='path,sha256'&&pinned(c.thinking_sound)&&
    Object.keys(c.thinking_sound).sort().join(',')==='model,path,sha256,voice'&&
    (!c.enabled||(c.thinking_sound.model===model&&c.thinking_sound.voice===voice))&&
    (c.threshold===undefined||Number.isFinite(c.threshold)&&c.threshold>0&&c.threshold<1)&&
    ['max_wait_ms','thinking_reply_ms'].every(k=>c[k]===undefined||
      Number.isSafeInteger(c[k])&&Number(c[k])>=100&&Number(c[k])<=2000),
    'CALL_TURN_CONFIGURATION_INVALID');
  return c;
}

/** Fixed Whisper frontend: Slaney 80-mel, periodic Hann, centered reflect STFT.
 * Matches the Apache-2.0 Hugging Face Whisper frontend; Smart Turn is BSD-2-Clause.
 * Float32 boundaries match its power spectrum, mel matrix, log and normalization.
 */
export function whisperLogMel(samples) {
  if(!hann)initializeFrontend();
  const audio=new Float32Array(128000),tail=samples.subarray(Math.max(0,samples.length-128000));
  audio.set(tail,audio.length-tail.length);
  let mean=0;
  for(const value of audio)mean+=value;
  mean/=audio.length;
  let variance=0;
  for(const value of audio)variance+=(value-mean)**2;
  const scale=Math.sqrt(variance/audio.length+1e-7);
  for(let i=0;i<audio.length;i++)audio[i]=(audio[i]-mean)/scale;
  const features=new Float32Array(64000),power=new Float32Array(201),frame=new Float64Array(400);
  const realBins=new Float64Array(400),imaginaryBins=new Float64Array(400);
  for(let t=0;t<800;t++) {
    for(let n=0;n<400;n++) {
      let i=t*160+n-200;
      if(i<0)i=-i;
      if(i>=audio.length)i=2*audio.length-2-i;
      frame[n]=audio[i]*hann[n];
    }
    // 400 = 16 * 25: two small DFTs avoid the quadratic full 400-point DFT.
    for(let j=0;j<16;j++)for(let k=0;k<25;k++) {
      let real=0,imaginary=0;
      for(let n=0;n<25;n++) {
        const phase=k*n*16%400,value=frame[j+16*n];
        real+=value*cosines[phase];imaginary-=value*sines[phase];
      }
      realBins[j*25+k]=real;imaginaryBins[j*25+k]=imaginary;
    }
    for(let k=0;k<201;k++) {
      let real=0,imaginary=0;
      for(let j=0;j<16;j++) {
        const phase=k*j%400,at=j*25+k%25,c=cosines[phase],s=sines[phase];
        real+=realBins[at]*c+imaginaryBins[at]*s;
        imaginary+=imaginaryBins[at]*c-realBins[at]*s;
      }
      power[k]=real*real+imaginary*imaginary;
    }
    for(let m=0;m<80;m++) {
      let value=0;
      for(const [k,weight] of filters[m])value+=power[k]*weight;
      features[m*800+t]=Math.log10(Math.fround(Math.max(1e-10,Math.fround(value))));
    }
  }
  let maximum=-Infinity;
  for(const value of features)maximum=Math.max(maximum,value);
  for(let i=0;i<features.length;i++)features[i]=(Math.max(features[i],maximum-8)+4)/4;
  return features;
}

// Tables are initialized only inside the worker (or explicit offline frontend evaluation).
let hann,cosines,sines,filters;
function initializeFrontend() {
  hann=Float64Array.from({length:400},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/400));
  cosines=Float64Array.from({length:400},(_,i)=>Math.cos(2*Math.PI*i/400));
  sines=Float64Array.from({length:400},(_,i)=>Math.sin(2*Math.PI*i/400));
  const logStep=Math.log(6.4)/27,maximum=15+Math.log(8)/logStep;
  const hz=Array.from({length:82},(_,i)=> {
    const mel=i*maximum/81;return mel<15 ? mel*200/3 : 1000*Math.exp(logStep*(mel-15));
  });
  filters=Array.from({length:80},(_,m)=> {
    const weights=[];
    for(let k=0;k<201;k++) {
      const weight=Math.max(0,Math.min((k*40-hz[m])/(hz[m+1]-hz[m]),(hz[m+2]-k*40)/(hz[m+2]-hz[m+1])));
      if(weight>0)weights.push([k,Math.fround(weight*2/(hz[m+2]-hz[m]))]);
    }
    return weights;
  });
}

const turnLimits=Object.freeze({jobs:8,audio_samples:128000,audio_bytes:8*128000*Float32Array.BYTES_PER_ELEMENT});
const sessionOptions=Object.freeze({executionProviders:['cpu'],executionMode:'sequential',intraOpNumThreads:1,
  interOpNumThreads:1,graphOptimizationLevel:'all',enableCpuMemArena:false});

/** One lazy session serves the application's callers. CPU work stays off the call transport event loop. */
export async function openTurnModel(config) {
  await verifyModelFile(config);
  const jobs=new Map(),exited=Promise.withResolvers();
  let worker,next=0,active,activeBytes=0,closing,failure,state='unloaded',sessionCount=0,workerMemory;
  const settle=(id,error,probability)=> {
    const job=jobs.get(id);if(!job)return;
    jobs.delete(id);job.signal?.removeEventListener('abort',job.abort);
    if(error)job.reject(error);else job.resolve(probability);
  };
  const fail=error=> {
    failure??=error;state='failed';
    for(const id of jobs.keys())settle(id,failure);
  };
  const pump=()=> {
    if(active||closing||failure||!jobs.size)return;
    if(!worker) {
      state='loading';
      worker=new Worker(new URL(import.meta.url),{workerData:{turnModelPath:config.path}});
      worker.on('error',fail);
      worker.on('exit',code=> {
        if(!closing||code!==0)fail(new Error(`TURN_MODEL_WORKER_EXIT:${code}`));
        active=undefined;activeBytes=0;sessionCount=0;state=failure?'failed':'closed';exited.resolve();
      });
      worker.on('message',message=> {
        workerMemory=message.memory;
        if(message.ready){sessionCount=1;state=closing?'closing':'ready';pump();return;}
        if(message.id!==active){fail(new Error('TURN_MODEL_WORKER_PROTOCOL'));return;}
        active=undefined;activeBytes=0;
        settle(message.id,message.error?new Error(message.error):undefined,message.probability);pump();
      });
    }
    if(state!=='ready')return;
    const [id,job]=jobs.entries().next().value;active=id;activeBytes=job.audioBytes;
    try{worker.postMessage({id,audio:job.audio},[job.audio.buffer]);}catch(error){fail(error);}
  };
  return {
    async score(samples,signal) {
      check(!closing&&!failure,'TURN_MODEL_CLOSED',503);
      check(!signal?.aborted,'TURN_MODEL_CANCELLED',409);check(jobs.size<turnLimits.jobs,'TURN_MODEL_BUSY',503);
      check(samples instanceof Float32Array&&samples.length>0&&
        samples.every(value=>Number.isFinite(value)&&Math.abs(value)<=1),'TURN_AUDIO_INVALID');
      const audio=samples.slice(Math.max(0,samples.length-turnLimits.audio_samples)),id=++next;
      return new Promise((resolve,reject)=> {
        // Native calls cannot be preempted. Keep their admission until completion.
        const abort=()=>{signal.removeEventListener('abort',abort);reject(new ContractError('TURN_MODEL_CANCELLED',409));
          if(id!==active){jobs.delete(id);pump();}};
        jobs.set(id,{audio,audioBytes:audio.byteLength,signal,abort,resolve,reject});
        signal?.addEventListener('abort',abort,{once:true});pump();
      });
    },
    snapshot() {
      const queued=[...jobs.entries()].filter(([id])=>id!==active);
      const queuedBytes=queued.reduce((sum,[,job])=>sum+job.audioBytes,0);
      return {state,session_count:sessionCount,jobs:queued.length+(active?1:0),
        queued_jobs:queued.length,active_audio_bytes:activeBytes,queued_audio_bytes:queuedBytes,
        admitted_audio_bytes:activeBytes+queuedBytes,limits:turnLimits,session_options:sessionOptions,
        process_rss_bytes:process.memoryUsage().rss,worker_memory:workerMemory};
    },
    close() {
      return closing??=(async()=> {
        for(const id of jobs.keys())settle(id,new Error('TURN_MODEL_CLOSED'));
        if(!worker){state='closed';return;}
        if(failure){await worker.terminate();return;}
        state='closing';worker.postMessage({close:true});await exited.promise;
        if(failure)throw failure;
      })();
    },
  };
}

if(!isMainThread&&workerData?.turnModelPath) {
  initializeFrontend();
  const {InferenceSession,Tensor}=await import('onnxruntime-node');
  const session=await InferenceSession.create(workerData.turnModelPath,{...sessionOptions});
  const memory=()=>{const {heapUsed,external,arrayBuffers}=process.memoryUsage();return {heapUsed,external,arrayBuffers};};
  // Serialize requests: ORT CPU calls are synchronous native work even when run() returns a Promise.
  let queue=Promise.resolve();
  parentPort.on('message',({id,audio,close})=> {
    queue=queue.then(async()=> {
      if(close){await session.release();parentPort.close();return;}
      try {
        const outputs=await session.run({input_features:new Tensor('float32',whisperLogMel(audio),[1,80,800])});
        const probability=Number(outputs[session.outputNames[0]].data[0]);
        check(Number.isFinite(probability)&&probability>=0&&probability<=1,'TURN_MODEL_OUTPUT_INVALID',503);
        parentPort.postMessage({id,probability,memory:memory()});
      }catch(error){parentPort.postMessage({id,error:error instanceof Error ? error.message : String(error),memory:memory()});}
    });
  });
  parentPort.postMessage({ready:true,memory:memory()});
}
