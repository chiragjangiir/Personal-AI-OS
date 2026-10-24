import {strict as assert} from 'node:assert';
import test from 'node:test';
import {DashScopeEmbedding,describeVision,parseEmbeddingConfiguration} from '../src/visual/models.ts';
import {HermesClient} from '../src/hermes-client.ts';
import type {QwenVoiceConfiguration} from '../src/voice/qwen-resources.mjs';

const voiceConfiguration: QwenVoiceConfiguration = {usable: true, provider: 'dashscope', model: 'qwen3.8-omni-flash-realtime',
  region: 'cn-beijing', endpoint: 'wss://synthetic.invalid', apiKey: 'existing-provider-key', voice: 'Tina', instructions: ''};
const configuration={...voiceConfiguration,...parseEmbeddingConfiguration({model:'alternate-vl-embedding',endpoint:'https://alternate-embedding.invalid/vl-api'},voiceConfiguration)};
test('call intent transport sends only current utterance and rejects invalid public contracts',async()=>{
  const text='这一段由我来讲，你先安静一下',abort=new AbortController();
  let result:unknown={stop:true,guests:'unchanged',directed:true,hangup:false},status=200;
  const http:typeof fetch=async(url,options)=>{
    assert.equal(String(url),'http://127.0.0.1:8642/v1/paios/call-intent');
    assert.equal((options!.headers as Record<string,string>).Authorization,`Bearer ${'a'.repeat(24)}`);
    assert.equal(options!.method,'POST');assert.equal(options!.redirect,'error');assert.ok(options!.signal);
    assert.deepEqual(JSON.parse(String(options!.body)),{text});
    return new Response(JSON.stringify(result),{status});
  };
  const client=new HermesClient('http://127.0.0.1:8642','a'.repeat(24),1000,4096,undefined,http);
  assert.deepEqual(await client.classifyCall(text,abort.signal),result);
  for (result of ['allow','revoke','unchanged'].map(guests=>({stop:false,guests,directed:true,hangup:false})))
    assert.deepEqual(await client.classifyCall(text),result);
  for (result of [{stop:'false',guests:'allow'},{stop:false,guests:'everyone'},null,
    {stop:false,guests:'unchanged',reason:'extra'}])
    await assert.rejects(client.classifyCall(text),/CALL_INTENT_INVALID/);
  status=503;await assert.rejects(client.classifyCall(text),/HERMES_HTTP_503/);
  const oversized=new HermesClient('http://127.0.0.1:8642','a'.repeat(24),1000,32,undefined,
    async()=>new Response(' '.repeat(33)));
  await assert.rejects(oversized.classifyCall(text),/CALL_INTENT_TOO_LARGE/);
  const cancellable=new HermesClient('http://127.0.0.1:8642','a'.repeat(24),1000,4096,undefined,
    async(_url,options)=>{abort.abort();options!.signal!.throwIfAborted();return new Response();});
  await assert.rejects(cancellable.classifyCall(text,abort.signal),{name:'AbortError'});
});
test('call intent has a three second deadline and preserves a shorter configured timeout',async()=>{
  const http:typeof fetch=async(_url,options)=>new Promise((_resolve,reject)=>{
    const signal=options!.signal!;
    const guard=setTimeout(()=>reject(new Error('CALL_INTENT_DEADLINE_MISSING')),4000);
    signal.addEventListener('abort',()=>{clearTimeout(guard);reject(signal.reason);},{once:true});
  });
  for(const timeout of [240000,25]){
    const client=new HermesClient('http://127.0.0.1:8642','a'.repeat(24),timeout,4096,undefined,http),start=performance.now();
    await assert.rejects(client.classifyCall('先停一下'),{name:'TimeoutError'});
    const elapsed=performance.now()-start;
    assert.ok(elapsed<(timeout===25?1000:3900),`classification deadline elapsed ${elapsed}ms`);
  }
});
test('DashScope image and query share credentials and vector space; provider errors and dimension drift surface', async () => {
  assert.throws(()=>parseEmbeddingConfiguration({model:''},configuration),/EMBEDDING_CONFIG/);
  const bodies: any[] = []; let mode = 'ok';
  const http: typeof fetch = async (url, options) => {
    assert.equal(String(url), configuration.endpoint);
    assert.equal((options!.headers as Record<string,string>).Authorization, 'Bearer existing-provider-key');
    bodies.push(JSON.parse(String(options!.body)));
    return new Response(JSON.stringify({output: {embeddings: [{index: 0, embedding: Array(mode === 'short' ? 4 : 1024).fill(.1)}]}}),
      {status: mode === 'failure' ? 429 : 200});
  };
  const model = new DashScopeEmbedding(configuration, http);
  assert.equal((await model.embedImage(Buffer.from('image'))).length, 1024);
  assert.equal((await model.embedQuery('a red cup')).length, 1024);
  assert.equal(bodies[0].input.contents[0].image, 'data:image/jpeg;base64,aW1hZ2U=');
  assert.equal(bodies[0].model,'alternate-vl-embedding');assert.equal(bodies[1].model, bodies[0].model); assert.equal(bodies[1].parameters.dimension, 1024);
  mode = 'failure'; await assert.rejects(model.embedQuery('cup'), /HTTP_429/);
  mode = 'short'; await assert.rejects(model.embedQuery('cup'), /VECTOR_INVALID/);
  assert.throws(() => new DashScopeEmbedding({...configuration, region: 'ap-southeast-1'}, http), /REQUIRES_BEIJING/);
  const oversized = new DashScopeEmbedding(configuration, async () => new Response(' '.repeat(128 * 1024 + 1)));
  await assert.rejects(oversized.embedQuery('cup'), /RESPONSE_TOO_LARGE/);
});
test('caption declares a schema while owner questions retain the bounded free-text transport', async () => {
  const image = Buffer.from([255,216,255]);
  let valid = true;
  const http: typeof fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:8642/v1/paios/vision');
    assert.equal((options!.headers as Record<string,string>).Authorization, `Bearer ${'a'.repeat(24)}`);
    const body = JSON.parse(String(options!.body));
    assert.equal(body.image_url, `data:image/jpeg;base64,${image.toString('base64')}`);
    if (body.prompt === 'Where is the cup?') {
      assert.deepEqual(Object.keys(body).sort(), ['image_url','prompt']);
      return new Response('The cup is on the table.', {headers:{'Content-Type':'text/plain'}});
    }
    assert.deepEqual(Object.keys(body).sort(), ['image_url','prompt','response_schema']);
    assert.deepEqual(body.response_schema,{type:'object',additionalProperties:false,required:['caption','ocr'],
      properties:{caption:{type:'string',pattern:'\\S',maxLength:8000},ocr:{type:'string',maxLength:16000}}});
    assert.match(body.prompt, /JSON object with string fields caption and ocr/);
    return valid ? Response.json({caption:'red cup',ocr:'hello'}) : new Response('invalid structured visual response',{status:502});
  };
  const model = new HermesClient('http://127.0.0.1:8642', 'a'.repeat(24), 1000, 4096, undefined, http);
  const describe=()=>describeVision((bytes,prompt,signal)=>model.analyzeVision(bytes,prompt,signal),image);
  assert.deepEqual(await describe(), {caption: 'red cup', ocr: 'hello'});
  assert.equal(await model.analyzeVision(image, 'Where is the cup?'), 'The cup is on the table.');
  valid = false; await assert.rejects(describe(), /HERMES_HTTP_502/);
  const failure=new HermesClient('http://127.0.0.1:8642','a'.repeat(24),1000,4096,undefined,
    async()=>new Response('vision_analyze failed',{status:502}));
  await assert.rejects(failure.analyzeVision(image,'Where is the cup?'),/HERMES_HTTP_502/);
  const oversized = new HermesClient('http://127.0.0.1:8642', 'a'.repeat(24), 1000, 4096, undefined,
    async () => new Response(' '.repeat(4097)));
  await assert.rejects(oversized.analyzeVision(image,'Describe'), /VISION_TOO_LARGE/);
});

import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseCallTurnConfiguration} from '../src/voice/turn-model.mjs';
import {readTurnCorpus,readTurnAudio} from '../tools/turn-eval.ts';
test('call turn configuration pins assets and binds enabled thinking audio to the selected model and voice',()=>{
  const pin={path:'/not-loaded/turn.onnx',sha256:'a'.repeat(64)},model='call-model',voice='call-voice';
  const config={enabled:true,model:pin,thinking_sound:{...pin,model,voice}};
  assert.deepEqual(parseCallTurnConfiguration(config,model,voice),config);
  for(const selected of [[model,'other-voice'],['other-model',voice]])
    assert.throws(()=>parseCallTurnConfiguration(config,selected[0]!,selected[1]!),/CALL_TURN_CONFIGURATION_INVALID/);
  const rollback={...config,enabled:false};
  assert.deepEqual(parseCallTurnConfiguration(rollback,'other-model','other-voice'),rollback);
  assert.deepEqual(parseCallTurnConfiguration({...config,thinking_reply_ms:2000},model,voice),{...config,thinking_reply_ms:2000});
  for(const invalid of [{...config,unknown:true},{...config,enabled:'true'},{...config,collect:true},{...config,collect:false},
    {...config,threshold:1},{...config,max_wait_ms:99},{...config,thinking_reply_ms:2001},{...config,thinking_pause_ms:900},
    {...config,model:{...pin,path:'relative.onnx'}},{...config,model:{...pin,sha256:'invalid'}},
    {...config,thinking_sound:{...config.thinking_sound,sha256:'invalid'}},
    {...config,thinking_sound:{...config.thinking_sound,extra:true}}])
    assert.throws(()=>parseCallTurnConfiguration(invalid,model,voice),/CALL_TURN_CONFIGURATION_INVALID/);
});
test('offline corpus retains existing labels and legacy originals after collection removal',async t=>{
  const root=await mkdtemp(join(tmpdir(),'turn-collection-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {RawArchive}=await import('../src/archive.ts'),{PosixStorage}=await import('../src/storage.ts'),{StreamArchive}=await import('../src/stream-archive.ts');
  const storage=new PosixStorage(join(root,'l5')),archive=new RawArchive(storage,4096),stream=new StreamArchive(storage,{max_chunk_bytes:4096,max_total_bytes:4096,max_chunks:8,max_revisions:8,max_seq:8});
  const trusted={principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'mic',consent_ref:'owner-consent',submission:'observation' as const};
  const chunk={track_id:'microphone',stream_epoch:'e',seq:0,modality:'audio' as const,format:'pcm_s16le:16000:1',source_range:{kind:'interval' as const,timebase_id:'samples',stream_epoch:'e',start_ms:0,end_ms:.125}};
  const saved=await stream.append({schema_version:'paios.event.v1',event_id:'owner-audio',device_id:'phone',device_type:'phone',captured_at:'2026-10-14T00:00:00.000Z',source:{channel:'mic'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.from([0,64,0,192])},trusted,'2026-10-14T00:00:00.000Z',chunk);
  const legacy='1000000000000-00000000-0000-0000-0000-000000000000',wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);wav.writeInt16LE(16384,44);wav.writeInt16LE(-16384,46);
  await writeFile(join(root,`${legacy}.wav`),wav);await writeFile(join(root,`${legacy}.json`),JSON.stringify({schema:'paios.call-turn.v1',at:'2001-09-09T01:46:40.000Z',label:'finished',probability:.8,sample_rate:16000,samples:2}));
  const current=join(root,'1800000000000-00000000-0000-0000-0000-000000000001.json');
  await writeFile(current,JSON.stringify({schema:'paios.call-turn.v2',label:'not_finished',probability:.2,audio:[{event:saved.event,chunk,sample_from:0,sample_to:2}]}));
  const files=await readdir(root),metadata=await readFile(current);
  const corpus=await readTurnCorpus(root);assert.equal(corpus.length,2);
  for(const sample of corpus)assert.deepEqual(Array.from(await readTurnAudio(sample,archive)),[.5,-.5]);
  assert.equal(JSON.parse(await readFile(join(root,`${legacy}.json`),'utf8')).schema,'paios.call-turn.v1');
  assert.deepEqual(await readdir(root),files);assert.deepEqual(await readFile(current),metadata);
  assert.deepEqual(await readFile(join(root,`${legacy}.wav`)),wav);
});


test('front search forwards only the public query to the native search endpoint',async()=>{
  const client=new HermesClient('http://127.0.0.1:8642','synthetic-token-at-least-24-chars',1000,4096,undefined,
    (async(url,options)=>{
      assert.equal(String(url),'http://127.0.0.1:8642/v1/paios/front-search');
      assert.deepEqual(JSON.parse(String(options?.body)),{query:'public question'});
      return Response.json({success:true,data:{web:[]}});
    }) as typeof fetch);
  assert.deepEqual(await client.searchCall('public question'),{success:true,data:{web:[]}});
});
