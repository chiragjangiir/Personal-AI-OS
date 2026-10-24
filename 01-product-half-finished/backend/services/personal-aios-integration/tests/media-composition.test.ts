import test, {after, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {spawn} from 'node:child_process';
import {sha256, type RawEvent, type TrustedContext, type TimeRange} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {configureMediaReplay, parseMediaReplayConfiguration,type MediaCompositionSource} from '../src/media/setup.ts';
import type {MediaReplayConfiguration} from '../src/media/configuration.ts';
import {LocalSpeechEngine} from '../src/voiceprint/engine.ts';
import {fakeSpeechConfig, realModelsPresent, realSpeechConfig, sayPresent, synthesize, silence, VOICE_A} from './speech-fixture.ts';

const at = '2026-10-02T00:00:00.000Z';
const trusted: TrustedContext = {principal_id: 'source-test-owner', device_id: 'source-test-mac', device_type: 'mac',
    consent_ref: 'source-only-test', channel: 'controlled', submission: 'observation'};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const span = (end = 32): TimeRange => ({kind: 'interval', timebase_id: 'common', start_ms: 0, end_ms: end});
const raw = (payload: Buffer, visual = false, event_id = 'audio'): RawEvent => ({schema_version: 'paios.event.v1',
    event_id, device_id: trusted.device_id, device_type: 'mac', captured_at: at, source: {channel: trusted.channel},
    media_type: visual ? 'visual' : 'audio', mime: visual ? 'image/png' : 'audio/pcm',
    representation: 'received_decoded_sample', payload});
const vision = {base_url: 'https://configured-vision.invalid/custom/v1', model: 'qwen38-ninfer-standard-262k-c2-k7', timeout_ms: 1000,
    max_frames: 3, max_input_bytes: 65536, max_tokens: 128};
const real = {skip: !realModelsPresent || !sayPresent ? 'sherpa models or macOS say voices absent' : false};
let voices: Promise<{root: string; speech: Buffer}> | undefined;
// Real speech for the composition, synthesized once at runtime; nothing is committed.
const speech = () => voices ??= (async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'paios-composition-speech-'));
    return {root, speech: Buffer.concat([silence(0.3), await synthesize(root, VOICE_A, '明天会不会下雨。'), silence(0.6)])};
})();
after(async () => { if (voices) await fs.rm((await voices).root, {recursive: true, force: true}); });
async function fixture(t: TestContext, speechConfig = fakeSpeechConfig()) {
    const root = await fs.mkdtemp(join(tmpdir(), 'paios-composition-'));
    t.after(async () => {
        if (process.env.MEDIA_COMPOSITION_EVIDENCE_ROOT) {
            await fs.mkdir(process.env.MEDIA_COMPOSITION_EVIDENCE_ROOT, {recursive: true});
            await fs.cp(root, join(process.env.MEDIA_COMPOSITION_EVIDENCE_ROOT, basename(root)), {recursive: true});
        }
        await fs.rm(root, {recursive: true, force: true});
    });
    const config: MediaReplayConfiguration = {fixture_only: true,
        stream_budget: {max_chunk_bytes:400000,max_total_bytes:800000,max_chunks:8,max_revisions:8,max_seq:8},
        alignment: {max_chunks:8,max_visual_refs:4,max_frame_gap_ms:100,max_uncertainty_ms:2},
        processing: {policy_version:'composition-source-test',max_inflight:2,max_input_bytes:400000,timeout_ms:30000,
            allow_external:true,allow_replay:true,allow_partial:true}, max_segments:4,max_window_ms:10000,
        audio: {provider:'local_sherpa',config:structuredClone(speechConfig)}};
    const storage = new PosixStorage(join(root,'data'));
    return {root,config,storage};
}
async function appendAudio(service: Awaited<ReturnType<typeof configureMediaReplay>>['service'], waveform: Buffer,
    event = 'audio') {
    const end = waveform.length / 32;
    const archived = await service.append(raw(waveform,false,event),trusted,{track_id:'mic',stream_epoch:'new-epoch',seq:0,
        modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'new-epoch',start_ms:0,end_ms:end}});
    const request = {raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,time_range:span(end),
        clock_maps:[{modality:'audio' as const,track_id:'mic',stream_epoch:'new-epoch',source_timebase_id:'samples',
            target_timebase_id:'common',offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-clock'}]};
    return {archived,request};
}
const fetchVision = (calls: string[], unavailable = false) => (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const value = String(url);calls.push(value);
    if(value.endsWith('/health'))return new Response(JSON.stringify({status:'ok',loaded_model:vision.model,loading_model:null,last_error:''}),{status:unavailable?503:200});
    if(value===vision.base_url+'/models')return new Response(JSON.stringify({data:[{id:vision.model}]}));
    assert.ok(value.endsWith('/chat/completions'));assert.equal(init?.method,'POST');
    return new Response(JSON.stringify({model:vision.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:'Controlled visual source result.'}}]}));
}) as typeof fetch;
async function visionEvidence(root: string) {
    const path=join(root,'vision-proof.json');await fs.writeFile(path,JSON.stringify({model:vision.model,
        validation:{image_data_png_nonempty_correct:true,image_counterfactual_correct:true},source_fixture:true}));
    return {path,sha256:sha256(await fs.readFile(path))};
}

test('full config parsing is real, snapshots input, and rejects incompatible legacy before CLI resource/key allocation',async t=>{
    const f=await fixture(t);const parsed=parseMediaReplayConfiguration(f.config);
    f.config.audio!.config.asr.model.path='mutated';assert.equal(parsed.audio!.config.asr.model.path,fakeSpeechConfig().asr.model.path);
    assert.throws(()=>parseMediaReplayConfiguration({...parsed,healthy:true}),/MEDIA_CONFIG_FIELDS/);
    assert.throws(()=>parseMediaReplayConfiguration({...parsed,local_audio:{}}),/LEGACY_MEDIA_REPLAY_CONFIG_UNSUPPORTED/);
    assert.throws(()=>parseMediaReplayConfiguration({...parsed,processing:{...parsed.processing,allow_partial:'true'}}),/MEDIA_CONFIG_POLICY/);
    assert.throws(()=>parseMediaReplayConfiguration({...parsed,audio:{provider:'dedicated_moss',config:parsed.audio!.config}}),/MEDIA_AUDIO_PROVIDER_UNSUPPORTED/);
    assert.throws(()=>parseMediaReplayConfiguration({...parsed,audio:{...parsed.audio,transcription_evidence:{}}}),/MEDIA_CONFIG_FIELDS/);
    assert.throws(()=>parseMediaReplayConfiguration({...parsed,audio:{provider:'local_sherpa',config:{...parsed.audio!.config,num_threads:16}}}),/SPEECH_CONFIG_INVALID/);
    const bad=join(f.root,'legacy-config.json'),lock=join(f.root,'must-not-exist.lock');
    await fs.writeFile(bad,JSON.stringify({mode:'isolated_fixture',port:18899,lock_file:lock,
        hermes_key_file:join(f.root,'forbidden-unread-key'),media_replay:{local_audio:{}}}));
    const child=spawn(process.execPath,[join(import.meta.dirname,'../src/main.ts'),'--config',bad],{stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',v=>stderr+=v);
    const code=await new Promise<number|null>(resolve=>child.once('close',resolve));
    assert.equal(code,1);assert.match(stderr,/LEGACY_MEDIA_REPLAY_CONFIG_UNSUPPORTED/);
    assert.ok(!stderr.includes('forbidden-unread-key'));await assert.rejects(fs.stat(lock),{code:'ENOENT'});
});

test('ambient readiness loads the shared native engine; unavailable models refuse before capture',
  {skip:!realModelsPresent},async t=>{
    const f=await fixture(t,realSpeechConfig),source:MediaCompositionSource={
      withAppendAdmission:async(_raw,_trusted,_chunk,append)=>append(),authorizeClockMaps:async()=>{},clockEvidence:'synthetic',
      continuous:{budget:{max_streams:1,max_pending_chunks:8,max_pending_candidates:8,max_chunk_bytes:400000,block_samples:160000,overlap_samples:8000},onError:error=>{throw error;}}};
    const media=await configureMediaReplay(f.storage,f.config,400000,fetch,source);t.after(()=>media.service.close());
    const engine=await media.speech!();assert.equal(engine.available(),true);assert.equal(await media.speech!(),engine);
    const vad=await engine.openVad(new AbortController().signal);await vad.write(new Float32Array(512));await vad.close();
    f.config.audio!.config.vad.model.path=join(f.root,'missing-vad.onnx');
    await assert.rejects(configureMediaReplay(f.storage,f.config,400000,fetch,source),/SPEECH_MODEL_UNAVAILABLE/);
});

test('legal PCM runs real source selection, the local speech engine and D; silence yields no segment; Windows is never probed',real,async t=>{
    const f=await fixture(t,realSpeechConfig);const fetches:string[]=[];
    f.config.windows_vision={config:vision,verified_record:{path:join(f.root,'absent-unrelated-proof'),sha256:'c'.repeat(64)}};
    const {service,archive,speech:engine}=await configureMediaReplay(f.storage,f.config,400000,fetchVision(fetches));t.after(()=>service.close());
    const {archived,request}=await appendAudio(service,(await speech()).speech,'spoken');
    const started=performance.now(),result=await service.process(trusted.principal_id,request);
    t.diagnostic(`composition process ${(performance.now()-started).toFixed(0)} ms for ${((await speech()).speech.length/32000).toFixed(2)} s (includes model load)`);
    assert.equal(result.processed_events.length,1);
    const d=result.processed_events[0]!;assert.equal(d.raw_ref,archived.event.raw_ref);
    assert.equal(d.origin,'device_observation');assert.equal(d.user_identity,'unknown');
    assert.equal(d.continuation!.semantic_status,'open');assert.equal(d.quality.status,'partial');
    assert.match(String(d.content.transcript),/明天.*下雨/u);
    assert.ok(d.quality.warnings.includes('TRANSCRIPTION_ACCURACY_UNACCEPTED'));
    assert.equal((d.processing.models as {id:string}[])[0]!.id,'local-sherpa-audio');
    assert.equal((d.processing.models as {version:string}[])[0]!.version,(await engine!()).version);
    assert.equal(await archive.validateEvidence(d),true);
    const quiet=await appendAudio(service,silence(1),'silent');
    const none=await service.process(trusted.principal_id,quiet.request);
    assert.equal(none.status,'no_segments');assert.deepEqual(none.processed_events,[]);
    assert.deepEqual(fetches,[]);assert.equal((await f.storage.list('media-vad-selections')).length,2);
});

test('visual-only uses actual visual frames and fake transport without loading configured missing audio models',async t=>{
    const f=await fixture(t);const fetches:string[]=[];
    f.config.windows_vision={config:vision,verified_record:await visionEvidence(f.root)};
    const opened=LocalSpeechEngine.open;let opens=0;
    LocalSpeechEngine.open=(...args)=>{opens++;return opened.apply(LocalSpeechEngine,args);};t.after(()=>{LocalSpeechEngine.open=opened;});
    const {service}=await configureMediaReplay(f.storage,f.config,65536,fetchVision(fetches));t.after(()=>service.close());
    const b=await service.append(raw(png,true,'visual'),trusted,{track_id:'camera',stream_epoch:'cam-epoch',seq:0,modality:'visual',format:'png',
        source_range:{kind:'instant',timebase_id:'frame',stream_epoch:'cam-epoch',at_ms:0}});
    const result=await service.process(trusted.principal_id,{raw_ref:b.event.raw_ref,archive_revision:b.event.archive_revision,
        time_range:{kind:'instant',timebase_id:'common',at_ms:0},clock_maps:[{modality:'visual',track_id:'camera',stream_epoch:'cam-epoch',
            source_timebase_id:'frame',target_timebase_id:'common',offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-camera'}]});
    assert.equal(result.processed_events.length,1);assert.equal(result.processed_events[0]!.content.transcript,undefined);
    assert.equal(fetches.length,3);assert.equal(opens,0);
});

test('a pin mismatch or missing model refuses audio before durable acceptance and is never retried into another provider',async t=>{
    for(const reason of ['pin','missing'] as const){
        const f=await fixture(t);
        if(reason==='pin'){
            const files=[f.config.audio!.config.vad.model,f.config.audio!.config.asr.model,f.config.audio!.config.asr.tokens,f.config.audio!.config.speaker.model];
            for(const file of files){file.path=join(f.root,basename(file.path));await fs.writeFile(file.path,'not the pinned model');}
        }
        const {service}=await configureMediaReplay(f.storage,f.config,65536);t.after(()=>service.close());
        for(const event of ['first','second']){
            const {request}=await appendAudio(service,Buffer.alloc(1024),`${reason}-${event}`);
            await assert.rejects(service.process(trusted.principal_id,request),reason==='pin'?/SPEECH_MODEL_PIN_MISMATCH/:/SPEECH_MODEL_UNAVAILABLE/);
        }
        assert.deepEqual(await f.storage.list('media-vad-selections'),[]);assert.deepEqual(await f.storage.list('processed-media-inputs'),[]);
        await service.close();
    }
});

test('pins verify once per composition; later requests share the loaded engine',real,async t=>{
    const f=await fixture(t,realSpeechConfig);
    const opened=LocalSpeechEngine.open;let opens=0;
    LocalSpeechEngine.open=(...args)=>{opens++;return opened.apply(LocalSpeechEngine,args);};t.after(()=>{LocalSpeechEngine.open=opened;});
    const {service}=await configureMediaReplay(f.storage,f.config,400000);t.after(()=>service.close());
    for(const event of ['first','next']){
        const {request}=await appendAudio(service,(await speech()).speech,event);
        assert.equal((await service.process(trusted.principal_id,request)).processed_events.length,1);
    }
    assert.equal(opens,1);
});

test('missing visual proof, current unavailable transport and malformed health fail honestly without audio allocation',async t=>{
    for(const reason of ['proof','unavailable','malformed'] as const){
        const f=await fixture(t);const fetches:string[]=[];delete f.config.audio;
        f.config.windows_vision={config:vision,...(reason==='proof'?{}:{verified_record:await visionEvidence(f.root)})};
        const transport=reason==='malformed'?(async(url:Parameters<typeof fetch>[0])=>{
            fetches.push(String(url));return new Response(JSON.stringify(null));
        }) as typeof fetch:fetchVision(fetches,true);
        const {service,archive}=await configureMediaReplay(f.storage,f.config,65536,transport);
        const b=await service.append(raw(png,true,'visual-failure'),trusted,{track_id:'camera',stream_epoch:'cam-epoch',seq:0,
            modality:'visual',format:'png',source_range:{kind:'instant',timebase_id:'frame',stream_epoch:'cam-epoch',at_ms:0}});
        await assert.rejects(service.process(trusted.principal_id,{raw_ref:b.event.raw_ref,archive_revision:b.event.archive_revision,
            time_range:{kind:'instant',timebase_id:'common',at_ms:0},clock_maps:[{modality:'visual',track_id:'camera',stream_epoch:'cam-epoch',
                source_timebase_id:'frame',target_timebase_id:'common',offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-camera'}]}),
            /NO_COMPLIANT_MEDIA_CAPABILITY/);
        assert.equal(fetches.length,reason==='proof'?0:2);
        assert.equal((await archive.readRecord(b.event.raw_ref,trusted.principal_id,b.event.archive_revision)).kind,'stream');
        assert.equal((await f.storage.list('processed-media')).length,0);
        await service.close();
    }
});

test('mixed archive visual window uses unique alignment output; nonoverlap skips audio while overlap and missing maps remain enforced',async t=>{
    const f=await fixture(t);const fetches:string[]=[];const unavailable=join(f.root,'unavailable-audio');
    f.config.audio!.config=fakeSpeechConfig(unavailable);
    f.config.windows_vision={config:vision,verified_record:await visionEvidence(f.root)};
    const {service,archive}=await configureMediaReplay(f.storage,f.config,65536,fetchVision(fetches));t.after(()=>service.close());
    const event='mixed-archive-window';
    await service.append({...raw(Buffer.alloc(1024),false,event),media_type:'livekit_tracks'},trusted,{track_id:'mic',stream_epoch:'new-epoch',seq:0,
        modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'new-epoch',start_ms:0,end_ms:32}});
    await service.append({...raw(png,true,event),media_type:'livekit_tracks'},trusted,{track_id:'camera',stream_epoch:'cam-epoch',seq:0,
        modality:'visual',format:'png',source_range:{kind:'instant',timebase_id:'frame',stream_epoch:'cam-epoch',at_ms:10}});
    const b=await service.append({...raw(png,true,event),media_type:'livekit_tracks'},trusted,{track_id:'camera',stream_epoch:'cam-epoch',seq:1,
        modality:'visual',format:'png',source_range:{kind:'instant',timebase_id:'frame',stream_epoch:'cam-epoch',at_ms:100}});
    const maps=[{modality:'audio' as const,track_id:'mic',stream_epoch:'new-epoch',source_timebase_id:'samples',target_timebase_id:'common',
        offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-clock'},
        {modality:'visual' as const,track_id:'camera',stream_epoch:'cam-epoch',source_timebase_id:'frame',target_timebase_id:'common',
            offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-camera'}];
    const request={raw_ref:b.event.raw_ref,archive_revision:b.event.archive_revision,
        time_range:{kind:'interval' as const,timebase_id:'common',start_ms:90,end_ms:110},clock_maps:maps};
    for(const clock_maps of [[],maps.map(map=>({...map,target_timebase_id:'other'}))])
        await assert.rejects(service.process(trusted.principal_id,{...request,clock_maps}),/CLOCK_MAP_REQUIRED/);
    assert.deepEqual(fetches,[]);
    const result=await service.process(trusted.principal_id,request);const d=result.processed_events[0]!;
    assert.equal(d.segment_basis,'visual_window');assert.equal(d.content.transcript,undefined);
    assert.ok(Array.isArray(d.content.visual_observations)&&d.content.visual_observations.length>0);
    assert.equal(await archive.validateEvidence(d),true);assert.equal(fetches.length,3);
    await assert.rejects(fs.stat(unavailable),{code:'ENOENT'});
    await assert.rejects(service.process(trusted.principal_id,{...request,time_range:span()}),/SPEECH_MODEL_UNAVAILABLE/);
    assert.equal(fetches.length,3);
    const retained=await archive.readRecord(b.event.raw_ref,trusted.principal_id,b.event.archive_revision);
    assert.equal(retained.kind,'stream');assert.equal(retained.kind==='stream'?retained.manifest.chunks.length:0,3);
    assert.equal((await f.storage.list('processed-media')).length,1);await service.close();
});

test('allow_partial is respected for the local finalizer instead of upgrading pinned models to complete quality',real,async t=>{
    const f=await fixture(t,realSpeechConfig);f.config.processing.allow_partial=false;
    const {service}=await configureMediaReplay(f.storage,f.config,400000);t.after(()=>service.close());
    const {request}=await appendAudio(service,(await speech()).speech);
    await assert.rejects(service.process(trusted.principal_id,request),/MEDIA_PARTIAL_NOT_ACCEPTED/);
    assert.equal((await f.storage.list('media-vad-selections')).length,1);assert.equal((await f.storage.list('processed-media')).length,0);
});

test('close cancels in-flight audio processing without D, closes the engine, and refuses later requests',real,async t=>{
    const f=await fixture(t,realSpeechConfig);
    const {service,speech:engine}=await configureMediaReplay(f.storage,f.config,400000);const {request}=await appendAudio(service,(await speech()).speech);
    const loaded=await engine!();const operation=service.process(trusted.principal_id,request);
    const rejected=assert.rejects(operation,/MEDIA_CANCELLED|SPEECH_ENGINE_CLOSED|SPEECH_CANCELLED|SILERO_STREAM_CLOSED|LOCAL_AUDIO_CLOSED/);
    await service.close();await rejected;assert.equal(loaded.available(),false);
    await assert.rejects(loaded.transcribe(new Float32Array(16000)),/SPEECH_ENGINE_CLOSED/);
    await assert.rejects(service.process(trusted.principal_id,request),/MEDIA_SERVICE_CLOSED/);
    assert.equal((await f.storage.list('processed-media')).length,0);
});

test('capability source receives only authenticated prepared modalities and an isolated copy; cached D makes no callback',real,async t=>{
    const f=await fixture(t,realSpeechConfig);const {service}=await configureMediaReplay(f.storage,f.config,400000);t.after(()=>service.close());
    const {request}=await appendAudio(service,(await speech()).speech);const internal=service as unknown as {
        config:{capabilities:import('../src/media/processing.ts').CapabilitySource}};
    const source=internal.config.capabilities;let calls=0;
    internal.config.capabilities=async prepared=>{
        calls++;assert.equal(prepared.input_contract,'paios.media.selected-pcm.v1');
        assert.deepEqual([...new Set(prepared.views.map(v=>v.modality))],['audio']);
        const result=await source(prepared);prepared.views[0]!.bytes.fill(255);prepared.views.length=0;return result;
    };
    const first=await service.process(trusted.principal_id,request);const repeated=await service.process(trusted.principal_id,request);
    assert.deepEqual(first.processed_events,repeated.processed_events);assert.equal(calls,1);
    assert.equal((await f.storage.list('processed-media')).length,1);
});

test('composition defers Debian decoder and its runtime directory until an original needs decoding',async t=>{
    const f=await fixture(t);
    const {service}=await configureMediaReplay(f.storage,f.config,1000000);
    await assert.rejects(fs.stat(join(f.storage.root,'runtime')),{code:'ENOENT'});
    await service.close();
    await assert.rejects(fs.stat(join(f.storage.root,'runtime')),{code:'ENOENT'});
});
