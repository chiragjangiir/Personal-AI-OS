import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openTurnModel,whisperLogMel} from '../src/voice/turn-model.mjs';

test('Whisper frontend preserves input and produces finite fixed-size silence features',()=> {
  const samples=new Float32Array(16000),features=whisperLogMel(samples);
  assert.equal(features.length,80*800);
  assert.ok(features.every(value=>value===-1.5));
  assert.ok(samples.every(value=>value===0));
});

// Explicit local model fixture; no model download or provider call in the test suite.
const fixture=process.env.PAIOS_TEST_TURN_CONFIG;
test('CPU worker bounds admission, cancels stale work, preserves buffers and closes pending work',{skip:!fixture},async()=> {
  const config=JSON.parse(await readFile(fixture!,'utf8'));
  const model=await openTurnModel(config.voice_frontend.call.turn_manager.model);
  try {
    assert.equal(model.snapshot().state,'unloaded');
    assert.equal(model.snapshot().session_count,0);
    await assert.rejects(model.score(new Float32Array([NaN])),/TURN_AUDIO_INVALID/u);
    const samples=new Float32Array(16000),scores=await Promise.all([model.score(samples),model.score(samples)]);
    assert.equal(model.snapshot().session_count,1);
    assert.equal(model.snapshot().admitted_audio_bytes,0);
    assert.equal(scores[0],scores[1]);
    assert.ok(scores.every(value=>Number.isFinite(value)&&value>=0&&value<=1));
    assert.equal(samples.byteLength,64000);
    await assert.rejects(model.score(samples,AbortSignal.abort()),/TURN_MODEL_CANCELLED/u);
    const callers=Array.from({length:8},()=>new AbortController());
    const window=new Float32Array(128000);
    const stale=callers.map(call=>assert.rejects(model.score(window,call.signal),/TURN_MODEL_CANCELLED/u));
    assert.equal(model.snapshot().admitted_audio_bytes,model.snapshot().limits.audio_bytes);
    await assert.rejects(model.score(samples),/TURN_MODEL_BUSY/u);
    for(const call of callers)call.abort();await Promise.all(stale);
    assert.equal(await model.score(samples),scores[0],'cancelled calls leave admission available for the next call');
    const pending=assert.rejects(model.score(samples),/TURN_MODEL_CLOSED/u);
    await Promise.all([model.close(),model.close(),pending]);
    await assert.rejects(model.score(samples),/TURN_MODEL_CLOSED/u);
    assert.equal(model.snapshot().state,'closed');
    assert.equal(model.snapshot().session_count,0);
    assert.equal(model.snapshot().admitted_audio_bytes,0);
  }finally{await model.close();}
});

test('an unused turn model closes without starting its native worker',{skip:!fixture},async()=> {
  const config=JSON.parse(await readFile(fixture!,'utf8'));
  const model=await openTurnModel(config.voice_frontend.call.turn_manager.model);
  assert.equal(model.snapshot().state,'unloaded');
  await model.close();
  assert.equal(model.snapshot().state,'closed');
  assert.equal(model.snapshot().session_count,0);
});

test('closing during lazy load rejects admission and drains the worker',{skip:!fixture},async()=> {
  const config=JSON.parse(await readFile(fixture!,'utf8'));
  const model=await openTurnModel(config.voice_frontend.call.turn_manager.model);
  const pending=assert.rejects(model.score(new Float32Array(128000)),/TURN_MODEL_CLOSED/u);
  assert.equal(model.snapshot().state,'loading');
  await Promise.all([model.close(),pending]);
  assert.equal(model.snapshot().state,'closed');
  assert.equal(model.snapshot().session_count,0);
  assert.equal(model.snapshot().admitted_audio_bytes,0);
});
