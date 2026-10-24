// Controlled native module for LocalSpeechEngine tests: the engine's thread protocol, no model. Dispatches are
// announced on a BroadcastChannel so tests can prove what reached the thread. transcribe sentinels: first sample
// -1 holds the thread for `length` ms, -2 crashes the thread.
import {parentPort,workerData} from 'node:worker_threads';
import type {ThreadConfig,ThreadReply,ThreadRequest} from '../src/voiceprint/engine.ts';
const config=workerData as ThreadConfig,port=parentPort!,channel=new BroadcastChannel('paios-speech-fake');
if(!config.call_only&&config.asr.model.endsWith('fail-load'))throw new Error('CONTROLLED_LOAD_FAILURE');
if(config.call_only&&config.speaker.model.endsWith('slow-load'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
channel.postMessage({kind:config.speaker_only?'speaker_started':config.call_only?'call_started':'started',...(config.call_only?{min_speech_ms:config.vad.min_speech_ms}:{}),keywords:config.kws?.keywords??null,threshold:config.kws?.threshold??null});
const hold=new Int32Array(new SharedArrayBuffer(4)),vads=new Map<number,{tail:number;speech:boolean}>(),spots=new Map<number,number>();
let next=1;
port.on('message',(request:ThreadRequest)=>{
  channel.postMessage({kind:'dispatched',op:request.op,...('samples' in request?{length:request.samples.length,buffer_bytes:request.samples.buffer.byteLength}:{})});
  let value:unknown=null;
  if(request.op==='transcribe'){
    if(request.samples[0]===-1)Atomics.wait(hold,0,0,request.samples.length);
    if(request.samples[0]===-2)process.exit(3);
    value={text:`fake:${request.samples.length}`};
  } else if(request.op==='embed')value=new Float32Array(4).fill(request.samples.length);
  else if(request.op==='vad_open'||request.op==='kws_open'){value=next++;request.op==='vad_open'?vads.set(value as number,{tail:0,speech:false}):spots.set(value as number,0);}
  else if(request.op==='vad_write'){
    if(config.call_only&&request.samples[0]===-1)Atomics.wait(hold,0,0,200);
    if(config.call_only&&request.samples[0]===-2)process.exit(3);
    const state=vads.get(request.stream);
    if(!state)return port.postMessage({id:request.id,ok:false,code:'SPEECH_STREAM_UNKNOWN',status:409} satisfies ThreadReply);
    const events=[];
    for(let at=0;at<request.samples.length;at+=512){const voiced=request.samples[at]!==0;
      if(voiced&&!state.speech)events.push({at:state.tail+512,start:state.tail});if(!voiced&&state.speech)events.push({at:state.tail+512,end:state.tail});
      state.speech=voiced;state.tail+=512;}
    value=events;
  } else if(request.op==='kws_write'){
    const fed=(spots.get(request.stream)??0)+request.samples.length;spots.set(request.stream,fed);
    value=request.samples.includes(0.5)?[{keyword:'依米',at_sample:fed}]:[];
  } else if(request.op==='vad_close'){
    if(config.vad.model.endsWith('fail-close'))return port.postMessage({id:request.id,ok:false,code:'CONTROLLED_CLOSE_FAILURE',status:500} satisfies ThreadReply);
    vads.delete(request.stream);
  }
  else if(request.op==='kws_close')spots.delete(request.stream);
  port.postMessage({id:request.id,ok:true,value} satisfies ThreadReply);
});
port.postMessage({ready:true,version:'fake',dim:4});
