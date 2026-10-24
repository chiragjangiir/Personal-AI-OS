import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {loadHostConfiguration} from '../src/host-configuration.ts';
import {acquireProcessLock,type ProcessLockRelease} from '../src/process-lock.ts';
import {isLegacyOriginal,type TurnAudioReference} from '../src/voice/turn-collection.ts';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {readFile,readdir,writeFile,rename,lstat} from 'node:fs/promises';
import {resolve,dirname,extname,relative,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {check,sha256,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {openTurnModel,THINKING_MAX_BYTES} from '../src/voice/turn-model.mjs';
import type {ModelFile} from '../src/voiceprint/engine.ts';

export interface TurnSample {audio:string|TurnAudioReference[];finished:boolean;label:string}
export async function readTurnCorpus(input:string):Promise<TurnSample[]> {
  const absolute=resolve(input),directory=extname(absolute)!=='.json';
  const base=directory ? absolute : dirname(absolute);
  const values:unknown[]=directory ? await Promise.all((await readdir(base)).filter(name=>/^\d+-[a-f0-9-]{36}\.json$/u.test(name)).sort().map(async name=>
    ((row)=>({...row,audio:row.audio??name.replace(/\.json$/u,'.wav')}))(JSON.parse(await readFile(resolve(base,name),'utf8'))))) :
    JSON.parse(await readFile(absolute,'utf8'));
  check(Array.isArray(values)&&values.length>0,'TURN_EVAL_CORPUS_REQUIRED');
  return values.map(value=>{
    const row=value as Partial<TurnSample>;
    const finished=row.finished ?? (row.label==='finished' ? true : row.label==='not_finished' ? false : undefined);
    check((typeof row.audio==='string'||Array.isArray(row.audio))&&typeof finished==='boolean'&&typeof row.label==='string','TURN_EVAL_SAMPLE_INVALID');
    return {audio:typeof row.audio==='string'?resolve(base,row.audio):row.audio!,finished:finished!,label:row.label!};
  });
}

/** Parse actual RIFF chunks; accepted audio is exclusively WAV mono 16 kHz PCM16. */
export async function readTurnWave(path:string):Promise<Float32Array> {
  return decodeTurnWave(await readFile(path));
}
function turnWaveData(bytes:Buffer):Buffer {
  check(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE','TURN_EVAL_WAV_INVALID');
  let valid=false,data:Buffer|undefined;
  for(let offset=12;offset+8<=bytes.length;) {
    const kind=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
    check(start+size<=bytes.length,'TURN_EVAL_WAV_TRUNCATED');
    if(kind==='fmt ') {
      check(size>=16,'TURN_EVAL_WAV_FORMAT_INVALID');
      valid=bytes.readUInt16LE(start)===1&&bytes.readUInt16LE(start+2)===1&&
        bytes.readUInt32LE(start+4)===16000&&bytes.readUInt16LE(start+12)===2&&bytes.readUInt16LE(start+14)===16;
    }
    if(kind==='data')data=bytes.subarray(start,start+size);
    offset=start+size+(size%2);
  }
  check(valid&&data&&data.length>0&&data.length%2===0,'TURN_EVAL_WAV_FORMAT_INVALID');
  return data!;
}
function decodeTurnWave(bytes:Buffer):Float32Array {
  const data=turnWaveData(bytes),samples=new Float32Array(data.length/2);
  for(let index=0;index<samples.length;index++)samples[index]=data!.readInt16LE(index*2)/32768;
  return samples;
}

export async function readTurnAudio(sample:TurnSample,archive?:RawArchive):Promise<Float32Array>{
  if(typeof sample.audio==='string')return readTurnWave(sample.audio);
  check(archive,'TURN_EVAL_ARCHIVE_REQUIRED');
  const parts=await Promise.all(sample.audio.map(async ref=>{
    if('silence_samples' in ref)return new Float32Array(ref.silence_samples);
    if('legacy_original' in ref) {check(isLegacyOriginal(ref),'TURN_EVAL_LEGACY_REFERENCE_INVALID');
      return decodeTurnWave(Buffer.from(await archive!.read(ref.legacy_original.event.raw_ref,ref.legacy_original.event.principal_id,ref.legacy_original.event.archive_revision)));}
    if('original' in ref)return decodeTurnWave(Buffer.from(await archive!.read(ref.event.raw_ref,ref.event.principal_id,ref.event.archive_revision)));
    check(ref.chunk.format==='pcm_s16le:16000:1','TURN_EVAL_ARCHIVE_FORMAT_INVALID');
    const bytes=Buffer.from((await archive!.readExactChunk(ref.event,ref.chunk,ref.event.bytes)).bytes);
    check(Number.isSafeInteger(ref.sample_from)&&Number.isSafeInteger(ref.sample_to)&&ref.sample_from>=0&&ref.sample_to>ref.sample_from&&ref.sample_to*2<=bytes.length,'TURN_EVAL_ARCHIVE_RANGE_INVALID');
    return Float32Array.from({length:ref.sample_to-ref.sample_from},(_,i)=>bytes.readInt16LE((i+ref.sample_from)*2)/32768);
  }));
  const audio=new Float32Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){audio.set(part,offset);offset+=part.length;}return audio;
}

export async function evaluateTurns(modelFile:ModelFile,samples:TurnSample[],threshold=.45,archive?:RawArchive) {
  check(Number.isFinite(threshold)&&threshold>0&&threshold<1&&samples.length>0,'TURN_EVAL_CONFIG_INVALID');
  const model=await openTurnModel(modelFile),rows:(TurnSample&{duration_seconds:number;probability:number;predicted_finished:boolean;correct:boolean;latency_ms:number})[]=[];
  try {
    for(const sample of samples) {
      const audio=await readTurnAudio(sample,archive),started=performance.now();
      const probability=await model.score(audio),latency_ms=performance.now()-started,predicted_finished=probability>=threshold;
      rows.push({...sample,duration_seconds:audio.length/16000,probability,predicted_finished,
        correct:predicted_finished===sample.finished,latency_ms});
    }
  } finally {await model.close();}
  const classes=Object.fromEntries([true,false].map(finished=>{
    const group=rows.filter(row=>row.finished===finished),latencies=group.map(row=>row.latency_ms).sort((a,b)=>a-b);
    const quantile=(fraction:number)=>latencies.length ? latencies[Math.ceil(fraction*latencies.length)-1]! : null;
    return [finished ? 'finished' : 'not_finished',{count:group.length,correct:group.filter(row=>row.correct).length,
      median_cpu_inference_ms:quantile(.5),p90_cpu_inference_ms:quantile(.9)}];
  }));
  return {schema:'paios.turn-eval.v1',created_at:new Date().toISOString(),model:modelFile,threshold,
    execution:'offline CPU; one thread; audio remains local',count:rows.length,
    accuracy:rows.filter(row=>row.correct).length/rows.length,
    false_finished:rows.filter(row=>!row.finished&&row.predicted_finished).length,
    missed_finished:rows.filter(row=>row.finished&&!row.predicted_finished).length,classes,rows};
}

/** Explicit admin regeneration only. Evaluation never imports or opens a voice transport. */
export async function renderThinking(configPath:string,output:string) {
  const {createFrontRealtimeSession}=await import(new URL('../../qwen-embedded/server/src/voice/embedded-realtime-session.mjs',import.meta.url).href);
  const {WebSocket}=await import(new URL('../../qwen-embedded/server/src/voice/node-websocket.mjs',import.meta.url).href);
  const source=resolve(configPath),config=JSON.parse(await readFile(source,'utf8')),front=config.voice_frontend,call=front.call;
  const model=call?.model ?? front.model,voice=call?.voice ?? front.voice,dialect=call?.dialect ?? front.dialect ?? 'nested-audio';
  const apiKey=(await readFile(front.key_file,'utf8')).trim(),chunks:Buffer[]=[];
  let resolveDone!:()=>void,rejectDone!:(error:Error)=>void;
  const done=new Promise<void>((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const timer=setTimeout(()=>rejectDone(new Error('THINKING_RENDER_TIMEOUT')),45000);
  // A drawn-out thinking hum ("emmm"), never a short 嗯, only covers a reply still silent 2 s after user speech stops.
  // A prompt comparison: a prompt naming 嗯———— gave 0.3-1.0 s; the spelled-out emmm gives about 1.2 s of closed-mouth hum.
  const instructions='你只生成声音素材，不聊天、不搜索、不调用工具。只发出一个拖得很长的闭口鼻音 emmmmmmm，就像人被问到问题时一边思考一边发出的“嗯~~~~”，持续约两秒，语调平稳略微下滑，结尾渐弱。不说任何字词。',text='emmmmmmmmmm~~~~';
  const session=createFrontRealtimeSession({provider:front.provider,model,voice,dialect,region:front.region,endpoint:front.endpoint,
    transcription_model:call?.transcription_model ?? front.transcription_model,apiKey,WebSocket,
    instructions,expressive:call?.expressive!==false,speechOnly:true,manualTurns:true,
    onEvent:(event:{type:string;delta?:string})=>{
      if(['response.audio.delta','response.output_audio.delta'].includes(event.type)&&typeof event.delta==='string')chunks.push(Buffer.from(event.delta,'base64'));
      if(event.type==='response.done')resolveDone();
      if(event.type==='error')rejectDone(new Error('THINKING_RENDER_PROVIDER_ERROR'));
    },onError:()=>rejectDone(new Error('THINKING_RENDER_TRANSPORT_ERROR'))});
  try {
    await session.connect();void session.greet(text,instructions).catch(rejectDone);await done;
    const generated=Buffer.concat(chunks);check(generated.length>0,'THINKING_RENDER_EMPTY');
    const pcm=Buffer.from(generated.subarray(0,Math.min(generated.length,THINKING_MAX_BYTES))),fadeSamples=Math.min(4800,pcm.length/2);
    for(let n=0;n<fadeSamples;n++) {
      const offset=pcm.length-2*fadeSamples+2*n;
      pcm.writeInt16LE(Math.round(pcm.readInt16LE(offset)*(fadeSamples-1-n)/fadeSamples),offset);
    }
    const path=resolve(dirname(output),`thinking-hum-${model}-${voice}.pcm`);
    await writeFile(path,pcm);
    const asset={schema:'paios.thinking-asset.v1',path,sha256:createHash('sha256').update(pcm).digest('hex'),
      bytes:pcm.length,duration_ms:pcm.length/48,model,voice,dialect,format:'PCM16LE',sample_rate:24000,channels:1,
      source,rendered_at:new Date().toISOString(),render:{speechOnly:true,manualTurns:true,expressive:call?.expressive!==false,
        text,instructions,generated_duration_ms:generated.length/48,truncated:generated.length>pcm.length,fade_out_ms:fadeSamples/24}};
    await writeFile(output,JSON.stringify(asset,null,2)+'\n');return asset;
  } finally {clearTimeout(timer);session.close();await session.join();}
}

async function publishLegacyIndex(root:string,path:string,event:import('../src/contracts.ts').ArchivedEvent) {
  if(path.startsWith('state/call-turns/')&&path.endsWith('.wav')) {
    const metadata=resolve(root,path.replace(/\.wav$/u,'.json')),label=JSON.parse(await readFile(metadata,'utf8'));
    check(['paios.call-turn.v1','paios.call-turn.v2'].includes(label.schema)&&['finished','not_finished'].includes(label.label),
      'LEGACY_TURN_LABEL_INVALID');
    check(label.principal_id===undefined||label.principal_id===event.principal_id,'LEGACY_TURN_OWNER_MISMATCH');
    const ref={legacy_original:{event,sample_rate:16000}};
    check(isLegacyOriginal(ref),'LEGACY_TURN_ORIGINAL_INVALID');
    await writeFile(metadata+'.tmp',JSON.stringify({...label,schema:'paios.call-turn.v2',sample_rate:16000,audio:[ref]}),{mode:0o600});
    await rename(metadata+'.tmp',metadata);return;
  }
  check(path.startsWith('central-storage/visual-memory/frames/'),'LEGACY_VISUAL_PATH_INVALID');
  const database=resolve(root,'central-storage/visual-memory/visual.sqlite'),stat=await lstat(database);
  check(stat.isFile()&&!stat.isSymbolicLink(),'LEGACY_VISUAL_CATALOGUE_INVALID');
  const db=new DatabaseSync(database,{allowExtension:true});
  try {
    db.loadExtension(createRequire(import.meta.url)('sqlite-vec').getLoadablePath());
    const original=path.slice('central-storage/visual-memory/'.length);
    const columns=new Set(db.prepare('PRAGMA table_info(frames)').all().map(row=>row.name));
    db.exec('BEGIN IMMEDIATE');
    try {
    const matches=db.prepare("SELECT id FROM frames WHERE original=? AND principal_id=?"+
      (columns.has('owner_delete')?' AND owner_delete=0':'')+" AND state!='deleting'").all(original,event.principal_id);
    check(matches.length>0,'LEGACY_VISUAL_OWNER_PATH_UNRESOLVED');
      for(const column of ['raw_ref','archive_revision','payload_sha256'])if(!columns.has(column))db.exec(`ALTER TABLE frames ADD COLUMN ${column} TEXT`);
      for(const row of matches)db.prepare('UPDATE frames SET raw_ref=?,archive_revision=?,payload_sha256=? WHERE id=? AND original=? AND principal_id=?')
        .run(event.raw_ref,event.archive_revision,event.payload_sha256,row.id!,original,event.principal_id);
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_refs'").get())
        db.prepare('INSERT OR IGNORE INTO capture_refs(raw_ref,archive_revision,principal_id,captured_ms) SELECT raw_ref,archive_revision,principal_id,captured_ms FROM frames WHERE original=? AND principal_id=?').run(original,event.principal_id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
}

/** Explicit source-retaining import. The manifest binds established provenance to exact original bytes. */
export async function migrateLegacyOriginals(root:string,archive:RawArchive,manifestPath:string,output:string) {
  root=resolve(root);output=resolve(output);
  check(output!==resolve(manifestPath)&&!['state/call-turns/','central-storage/visual-memory/'].some(path=>relative(root,output).startsWith(path)),
    'LEGACY_REPORT_OVERWRITES_SOURCE');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as {schema:string;entries:{path:string;sha256:string;
    evidence_ref:string;raw:Omit<RawEvent,'payload'>;trusted:TrustedContext}[]};
  check(manifest.schema==='paios.legacy-original-provenance.v1'&&Array.isArray(manifest.entries),'LEGACY_PROVENANCE_MANIFEST_INVALID');
  const provenance=new Map(manifest.entries.map(entry=>[entry.path,entry]));
  check(provenance.size===manifest.entries.length,'LEGACY_PROVENANCE_DUPLICATE');
  const rows:{path:string;sha256?:string;bytes?:number;status:string;kind?:string;reason?:string;event?:unknown;evidence_ref?:string}[]=[];
  const walk=async(directory:string):Promise<string[]>=>{
    const result:string[]=[];
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      check(!entry.isSymbolicLink(),'LEGACY_ORIGINAL_SYMLINK');
      if(entry.isDirectory())result.push(...await walk(path));else if(entry.isFile())result.push(path);
    }
    return result;
  };
  const persist=async()=>{
    const report={schema:'paios.legacy-original-import.v1',source_root:root,source_retained:true,
      resolved:rows.filter(row=>row.status==='verified').length,unresolved:rows.filter(row=>row.status==='unresolved').length,
      derived:rows.filter(row=>row.status==='derived_retained').length,rows};
    await writeFile(output+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(output+'.tmp',output);return report;
  };
  // Inventory retained bytes first; catalogue references distinguish originals from derived thumbnails.
  const files:string[]=[];
  for(const directory of ['central-storage/visual-memory/frames','state/call-turns']) {
    try{files.push(...(await walk(join(root,directory))).filter(path=>directory.includes('visual-memory')||path.endsWith('.wav')));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  for(const path of files.sort()) {
    check(path!==output&&path!==output+'.tmp','LEGACY_REPORT_OVERWRITES_SOURCE');
    const payload=await readFile(path);
    rows.push({path:relative(root,path),sha256:sha256(payload),bytes:payload.length,status:'unresolved',reason:'established_provenance_missing'});
  }
  const inventoried=new Set(rows.map(row=>row.path)),catalogue=resolve(root,'central-storage/visual-memory/visual.sqlite');
  const originals=new Set<string>(),thumbnails=new Set<string>(),ownerDeleted=new Map<string,string>();
  let catalogExists=true;try{await lstat(catalogue);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')catalogExists=false;else throw error;}
  if(catalogExists) {
    const db=new DatabaseSync(catalogue,{readOnly:true});
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(frames)').all().map(row=>row.name));
      const records=db.prepare('SELECT id,original'+['raw_ref','thumbnail','owner_delete'].filter(column=>columns.has(column)).map(column=>','+column).join('')+' FROM frames').all();
      for(const record of records) {
        const path=typeof record.original==='string'&&record.original?`central-storage/visual-memory/${record.original}`:`catalogue:visual-frame:${record.id}`;
        if(record.original)originals.add(path);
        if(record.original&&Number(record.owner_delete)>0)ownerDeleted.set(path,Number(record.owner_delete)===1?
          'legacy_catalogue_owner_deletion_pending':'legacy_catalogue_owner_deletion_completed');
        if(typeof record.thumbnail==='string'&&record.thumbnail)thumbnails.add(`central-storage/visual-memory/${record.thumbnail}`);
        if(inventoried.has(path)||record.owner_delete||(!record.original&&record.raw_ref))continue;
        rows.push({path,status:'unresolved',reason:'legacy_catalogue_original_missing'});inventoried.add(path);
      }
    }finally{db.close();}
  }
  for(const row of rows) {
    row.kind=originals.has(row.path)?'catalogue_original':thumbnails.has(row.path)?'derived_thumbnail':
      row.path.startsWith('state/call-turns/')?'turn_original':'independent_original';
    if(row.kind==='derived_thumbnail'){row.status='derived_retained';delete row.reason;}
    if(ownerDeleted.has(row.path))row.reason=ownerDeleted.get(row.path)!;
  }
  await persist();
  for(const row of rows) {
    const entry=provenance.get(row.path);if(!entry||row.sha256===undefined||row.status==='derived_retained'||ownerDeleted.has(row.path))continue;
    try {
      const path=resolve(root,row.path),payload=await readFile(path);
      check(resolve(root,entry.path)===path&&entry.sha256===row.sha256&&sha256(payload)===row.sha256&&
        typeof entry.evidence_ref==='string'&&entry.evidence_ref.length>0,'LEGACY_PROVENANCE_BINDING_INVALID');
      if(row.path.startsWith('state/call-turns/')&&row.path.endsWith('.wav'))turnWaveData(payload);
      const event=await archive.archive({...entry.raw,payload},entry.trusted);
      const readback=await archive.read(event.raw_ref,event.principal_id,event.archive_revision);
      check(readback.byteLength===payload.length&&sha256(readback)===row.sha256,'LEGACY_ORIGINAL_READBACK_MISMATCH');
      row.event=event;row.evidence_ref=entry.evidence_ref;
      if(row.kind!=='independent_original')await publishLegacyIndex(root,row.path,event);
      row.status='verified';delete row.reason;
    } catch(error) {
      row.reason=error instanceof Error?error.message:String(error);
    }
    await persist();
  }
  // A manifest must not silently hide originals which disappeared from its inventory.
  for(const key of provenance.keys())if(!inventoried.has(key))rows.push({path:key,status:'unresolved',reason:'source_original_missing'});
  return persist();
}

// Offline: --config config.json --input manifest.json|directory --output evaluation.json.
// Explicit provider render: --render-thinking config.json --output asset-manifest.json.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=new Map<string,string>();
  for(let index=2;index<process.argv.length;index+=2)args.set(process.argv[index]!,process.argv[index+1]!);
  let disk:PosixStorage|undefined,archive:RawArchive|undefined,release:ProcessLockRelease|undefined;
  const configure=async(path:string)=>{
    const config=await loadHostConfiguration(path) as {storage_root:string;max_event_bytes:number;lock_file:string;
      archive_tiering?:{cold:import('../src/cold-storage.ts').ColdConfig;min_free_bytes?:number};
      voice_frontend?:{call?:{turn_manager?:{model:ModelFile;threshold?:number}}}};
    if(args.has('--migrate-legacy')||args.has('--restore-archive')){
      check(typeof config.lock_file==='string'&&config.lock_file.length>0,'LEGACY_IMPORT_PROCESS_LOCK_REQUIRED');release=await acquireProcessLock(config.lock_file);}
    const tier=config.archive_tiering;
    disk=new PosixStorage(config.storage_root,tier?{cold:tier.cold,...(tier.min_free_bytes===undefined?{}:{min_free_bytes:tier.min_free_bytes})}:{});
    archive=new RawArchive(disk,config.max_event_bytes);return config;
  };
  try {
  check(args.has('--output')||args.has('--restore-archive'),'TURN_EVAL_OUTPUT_REQUIRED');
  if(args.has('--restore-archive')) {
    await configure(args.get('--restore-archive')!);
    console.log(JSON.stringify(await archive!.restoreSnapshot()));
  } else if(args.has('--render-thinking')) {
    const asset=await renderThinking(args.get('--render-thinking')!,resolve(args.get('--output')!));
    console.log(JSON.stringify({path:asset.path,bytes:asset.bytes,duration_ms:asset.duration_ms,model:asset.model,voice:asset.voice,sha256:asset.sha256}));
  } else if(args.has('--migrate-legacy')) {
    check(args.has('--config')&&args.has('--provenance'),'LEGACY_IMPORT_CONFIG_REQUIRED');
    await configure(args.get('--config')!);
    const result=await migrateLegacyOriginals(args.get('--migrate-legacy')!,archive!,args.get('--provenance')!,args.get('--output')!);
    console.log(JSON.stringify({resolved:result.resolved,unresolved:result.unresolved,source_retained:true}));
    if(result.unresolved)process.exitCode=2;
  } else {
  check(args.has('--config')&&args.has('--input'),'usage: turn-eval.ts --config config.json --input manifest.json|directory --output evaluation.json');
  const config=await configure(args.get('--config')!);
  const manager=config.voice_frontend?.call?.turn_manager;
  check(manager?.model,'TURN_EVAL_MODEL_REQUIRED');
  const result=await evaluateTurns(manager.model,await readTurnCorpus(args.get('--input')!),manager.threshold ?? .45,archive!);
  const output=resolve(args.get('--output')!);
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  const persisted=JSON.parse(await readFile(output,'utf8'));
  console.log(JSON.stringify({output,count:persisted.count,accuracy:persisted.accuracy,classes:persisted.classes}));
  }
  }finally{try{await archive?.close();}finally{try{await disk?.close();}finally{await release?.();}}}
}
