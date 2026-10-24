// Native memory of the speech engine under the ambient lane's load: the real LocalSpeechEngine, its worker threads and
// the pinned sherpa models, fed windows the way SherpaAudioWorker does (finite VAD, ASR, tagging, keyword spotting,
// speaker embedding) next to one long-lived continuous VAD stream. Prints one JSON line per sample.
//   node tools/speech-memory.ts [--models <dir with the sherpa models>] [--seconds 10] [--windows 200] [--every 20]
//     [--ops vad,asr,tag,kws,embed] [--wav <16 kHz mono PCM16 WAV>]
// `embed` is the windowed embedding every non-payment caller uses; `embed-whole` is one native call on the whole input.
// Linux: RssAnon plus the smaps split the production sampler uses (glibc [heap], 64 MiB arena heaps, small maps).
// macOS: vmmap's live malloc bytes (ALLOCATED) and footprint, which separate live native memory from allocator caching.
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {BroadcastChannel} from 'node:worker_threads';
import {LocalSpeechEngine,parseLocalSpeechConfig} from '../src/voiceprint/engine.ts';
import {SherpaSileroStreamFactory} from '../src/media/silero-stream.ts';
import {embedSpeech} from '../src/voiceprint/contracts.ts';

const {values:o}=parseArgs({options:{models:{type:'string'},seconds:{type:'string',default:'10'},windows:{type:'string',default:'200'},
  every:{type:'string',default:'20'},ops:{type:'string',default:'vad,asr,tag,kws,embed'},wav:{type:'string'},'diagnostic-gc':{type:'boolean',default:false}}});
const root=o.models??(process.env.PAIOS_MODEL_ROOT?join(process.env.PAIOS_MODEL_ROOT,'sherpa'):undefined);
if(!root)throw new Error('SPEECH_MEMORY_MODEL_FIXTURE_REQUIRED');
// Reuse the configured model pins and policies. The engine verifies them once; the probe never repins different weights.
const production=JSON.parse(readFileSync(new URL('../../../../../deploy/cloud/cloud.json',import.meta.url),'utf8')).pcm.media.audio.config;
const config=parseLocalSpeechConfig(JSON.parse(JSON.stringify(production).replaceAll('${PAIOS_MODEL_ROOT}/sherpa',root)));
const ops=new Set(o.ops.split(',')),seconds=Number(o.seconds),windows=Number(o.windows),every=Number(o.every);

function pcmWindow():Buffer {
  const n=Math.round(seconds*16000),out=Buffer.alloc(n*2);
  if(o.wav){const wav=readFileSync(o.wav),data=wav.indexOf('data')+8;for(let i=0;i<n;i++)out.writeInt16LE(wav.readInt16LE(data+(i*2)%(wav.length-data-1)),i*2);return out;}
  // Voiced-like signal: a gliding harmonic tone in 1.6 s bursts with a 0.4 s gap, plus noise (deterministic).
  let s=1;for(let i=0;i<n;i++){s=(s*1103515245+12345)&0x7fffffff;const t=i/16000,on=t%2<1.6;
    out.writeInt16LE(Math.round(32767*((on?0.2*Math.sin(2*Math.PI*(140+40*Math.sin(t*3))*t)*(1+Math.sin(2*Math.PI*620*t)/2):0)+0.01*(s/0x7fffffff-0.5))),i*2);}
  return out;
}
function memory() {
  const sample:Record<string,number>={rss_mib:process.memoryUsage.rss()/1048576};
  if(existsSync('/proc/self/smaps')) {
    const status=readFileSync('/proc/self/status','utf8');sample.rss_anon_mib=Number(/RssAnon:\s+(\d+)/u.exec(status)![1])/1024;
    let heap=0,arenas=0,small=0,mid=0;
    for(const block of readFileSync('/proc/self/smaps','utf8').split(/\n(?=[0-9a-f]+-[0-9a-f]+ )/u)) {
      const [range,,,,,path]=block.split('\n',1)[0]!.split(/\s+/u),[a,b]=range!.split('-').map(x=>parseInt(x,16));
      const rss=Number(/\nRss:\s+(\d+)/u.exec(block)?.[1]??0)/1024,size=(b!-a!)/1048576;
      if(path==='[heap]')heap+=rss;else if(path)continue;else if(size>=63&&size<=64)arenas+=rss;else if(size<1)small+=rss;else mid+=rss;
    }
    Object.assign(sample,{heap_mib:heap,arena64_mib:arenas,small_mib:small,mid_mib:mid});
  } else if(process.platform==='darwin') {
    const out=execFileSync('vmmap',['--summary',String(process.pid)],{encoding:'utf8',maxBuffer:1<<26});
    const mib=(text:string)=>Number(text.slice(0,-1))*({K:1/1024,M:1,G:1024}[text.at(-1)!]??0);
    sample.footprint_mib=mib(/Physical footprint:\s+(\S+)/u.exec(out)![1]!);sample.footprint_peak_mib=mib(/Physical footprint \(peak\):\s+(\S+)/u.exec(out)![1]!);
    sample.malloc_live_mib=mib(/^DefaultMallocZone\S*(?:\s+\S+){5}\s+(\S+)/mu.exec(out)![1]!);
  }
  for(const key of Object.keys(sample))sample[key]=Math.round(sample[key]!);
  return sample;
}

// Optional probe only: GC must run in each native-owning isolate, not the main thread. Stream wrapper finalization
// counts indicate reachability; they are not destructor counters or proof that malloc returned pages to the OS.
const channelName=`speech-memory:${randomUUID()}`,channel=o['diagnostic-gc']?new BroadcastChannel(channelName):undefined;
const thread=o['diagnostic-gc']?new URL('data:text/javascript,'+encodeURIComponent(`
  import {createRequire} from 'node:module';
  import {BroadcastChannel,workerData} from 'node:worker_threads';
  import {Session} from 'node:inspector';
  const source=${JSON.stringify(new URL('../src/voiceprint/engine-thread.ts',import.meta.url).href)};
  const sherpa=createRequire(source)('sherpa-onnx-node'),counts={};
  const registry=new FinalizationRegistry(name=>{counts[name].finalized++;});
  for(const name of ['OfflineRecognizer','AudioTagging','SpeakerEmbeddingExtractor','KeywordSpotter']){
    const prototype=sherpa[name].prototype,create=prototype.createStream;
    counts[name]={created:0,finalized:0};
    prototype.createStream=function(...args){const stream=create.apply(this,args);counts[name].created++;registry.register(stream.handle,name);return stream;};
  }
  const channel=new BroadcastChannel(${JSON.stringify(channelName)}),lane=workerData.speaker_only?'speaker':workerData.call_only?'call':'ambient';
  channel.onmessage=async({data})=>{
    if(data.kind!=='probe')return;
    let error;
    if(data.gc){const session=new Session();session.connect();
      try{await new Promise((resolve,reject)=>session.post('HeapProfiler.collectGarbage',err=>err?reject(err):resolve()));}
      catch(failure){error=String(failure);}finally{session.disconnect();}
      await new Promise(resolve=>setImmediate(resolve));
    }
    channel.postMessage({id:data.id,lane,counts,error,memory:process.memoryUsage()});
  };
  channel.unref();await import(source);
`)):undefined;
const engine=await LocalSpeechEngine.open(config,thread?{thread}:{}),signal=new AbortController().signal,vad=new SherpaSileroStreamFactory(async()=>engine);
let probeId=0;
async function nativeLifetime(gc=false){
  if(!channel)return undefined;
  const id=++probeId,expected=Object.entries(engine.resourceSnapshot()).filter(([,lane])=>lane!==null).map(([lane])=>lane);
  const replies:Record<string,unknown>={};
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const listener=({data}:{data:{id:number;lane:string;error?:string}})=>{
      if(data.id!==id)return;
      if(data.error){clearTimeout(timer);channel.removeEventListener('message',listener);reject(new Error(data.error));return;}
      replies[data.lane]=data;
      if(expected.every(lane=>Object.hasOwn(replies,lane))){clearTimeout(timer);channel.removeEventListener('message',listener);resolve(replies);}
    };
    const timer=setTimeout(()=>{channel.removeEventListener('message',listener);reject(new Error('SPEECH_MEMORY_PROBE_TIMEOUT'));},10000);
    channel.addEventListener('message',listener);channel.postMessage({kind:'probe',id,gc});
  });
}
const pcm=pcmWindow(),samples=new Float32Array(pcm.length/2);for(let n=0;n<samples.length;n++)samples[n]=pcm.readInt16LE(n*2)/32768;
const continuous=await vad.open(signal);
const report=async(phase:string,extra:object={})=>console.log(JSON.stringify({phase,seconds,ops:o.ops,
  ...(channel?{native_lifetime:await nativeLifetime()}:{}),resources:engine.resourceSnapshot(),...memory(),...extra}));
await report('loaded');
let busy=0;
for(let w=1;w<=windows;w++) {
  const start=performance.now();
  await continuous.write(pcm);
  if(ops.has('vad')){const finite=await vad.open(signal);await finite.write(pcm);await finite.finish();await finite.close();}
  const analysis=[ops.has('asr')?engine.transcribe(samples):undefined,ops.has('tag')?engine.tag(samples):undefined,
    ops.has('embed')?embedSpeech(engine,samples):ops.has('embed-whole')?engine.embed(samples):undefined,ops.has('kws')?(async()=>{const stream=await engine.keywords!.open(signal);
      for(let at=0;at<samples.length;at+=1600)await stream.write(samples.subarray(at,at+1600));await stream.finish();})():undefined];
  await Promise.all(analysis);busy+=performance.now()-start;
  if(w%every===0){await report(`window ${w}`,{ms_per_window:Math.round(busy/every)});busy=0;}
}
await new Promise(resolve=>setTimeout(resolve,5000));await report('idle 5 s');
if(channel){const finalized=await nativeLifetime(true);await report('diagnostic worker GC',{gc_native_lifetime:finalized});}
await continuous.close();await engine.close();channel?.close();
console.log(JSON.stringify({phase:'engine closed',seconds,ops:o.ops,...memory()}));
