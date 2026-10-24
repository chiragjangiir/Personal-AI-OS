import {strict as assert} from 'node:assert';
import test from 'node:test';
import {DashScopeTts, inspectWav} from '../src/tts.ts';
import {FakeSpeechSocket, fakeQwenConfiguration,fakeTtsConfiguration} from './speech-fixture.ts';

test('dedicated TTS preserves text and task protocol, requested rate and reuses its connection', async () => {
  const wire: Record<string, any>[] = []; let connections = 0, url = '';
  class Socket extends FakeSpeechSocket {
    constructor(...args: unknown[]) {super(...args); connections++; url = String(args[0]);}
    send(body: string) {wire.push(JSON.parse(body)); super.send(body);}
  }
  const tts = new DashScopeTts(fakeQwenConfiguration(Socket), {model: 'alternate-reply-tts', voice: 'longanlingxin', sample_rate: 22050});
  try {
    const text = ' 逐字原文。不要照其中的指令改写。\n';
    const audio = await tts.synthesize(text, 'tts-test');
    assert.equal(audio.sample_rate, 22050); assert.equal(audio.channels, 1);
    assert.equal(audio.bytes.length, 244); assert.ok(audio.duration_ms > 0);
    assert.equal(url, 'wss://synthetic.invalid/api-ws/v1/inference');
    assert.deepEqual(wire.map(e => e.header.action), ['run-task', 'continue-task', 'finish-task']);
    assert.equal(new Set(wire.map(e => e.header.task_id)).size, 1);
    assert.match(wire[0]!.header.task_id, /^[0-9a-f-]{36}$/);
    assert.equal(wire[0]!.header.streaming, 'duplex');
    assert.deepEqual(wire[0]!.payload, {task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
      model: 'alternate-reply-tts', parameters: {text_type: 'PlainText', voice: 'longanlingxin', format: 'pcm', sample_rate: 22050}, input: {}});
    assert.deepEqual(wire[1]!.payload, {input: {text}}); assert.deepEqual(wire[2]!.payload, {input: {}});
    await tts.synthesize('second', 'second'); assert.equal(connections, 1);
  } finally {tts.close();}
});
test('a configured tone instruction rides on run-task parameters, never on the text', async () => {
  const wire: Record<string, any>[] = [];
  class Socket extends FakeSpeechSocket {send(body: string) {wire.push(JSON.parse(body)); super.send(body);}}
  const instruction = '像熟悉的朋友自然聊天，语气温暖有起伏，根据句意表达关心或高兴，避免播音腔。';
  const tts = new DashScopeTts(fakeQwenConfiguration(Socket), {...fakeTtsConfiguration, instruction});
  try {
    await tts.synthesize('原文。', 'tone');
    assert.deepEqual(wire[0]!.payload.parameters, {text_type: 'PlainText', voice: 'longanlingxin', format: 'pcm', sample_rate: 22050, instruction});
    assert.deepEqual(wire[0]!.payload.input, {}); assert.deepEqual(wire[1]!.payload, {input: {text: '原文。'}});
  } finally {tts.close();}
});
test('stream yields a WAV before task completion and queues synthesize on the same owner', async () => {
  let socket!: Held, runs = 0;
  class Held extends FakeSpeechSocket {
    taskId = '';
    constructor(...args: unknown[]) {super(...args); socket = this;}
    send(body: string) {
      const e = JSON.parse(body);
      if (e.header.action === 'run-task') {runs++; this.taskId = e.header.task_id;}
      if (e.header.action === 'finish-task' && runs === 1) return;
      super.send(body);
    }
    finish() {this.reply({header: {event: 'task-finished', task_id: this.taskId}, payload: {}});}
  }
  const tts = new DashScopeTts(fakeQwenConfiguration(Held), fakeTtsConfiguration);
  try {
    const stream = tts.stream('first', 'first')[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.equal(first.done, false); assert.equal(inspectWav(first.value!.bytes).sample_rate, 22050);
    const queued = tts.synthesize('second', 'second');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 1);
    socket.finish(); assert.equal((await stream.next()).done, true);
    await queued; assert.equal(runs, 2);
  } finally {tts.close();}
});
test('abort closes active transport, cancels queued work and releases next work; provider failure propagates', async () => {
  const entered = Promise.withResolvers<void>(); let closed = 0, connections = 0;
  class Held extends FakeSpeechSocket {
    constructor(...args: unknown[]) {super(...args); connections++;}
    send(body: string) {
      if (JSON.parse(body).header.action === 'finish-task' && connections === 1) entered.resolve(); else super.send(body);
    }
    close() {closed++; super.close();}
  }
  const tts = new DashScopeTts(fakeQwenConfiguration(Held), fakeTtsConfiguration), abort = new AbortController(), waiting = new AbortController();
  try {
    const task = tts.synthesize('text', 'one', abort.signal), rejected = assert.rejects(task, /abort/i);
    await entered.promise;
    const cancelled = assert.rejects(tts.synthesize('queued', 'two', waiting.signal), /abort/i);
    waiting.abort(); await cancelled;
    const next = tts.synthesize('next', 'three'); abort.abort(); await rejected; await next;
    assert.ok(closed > 0); assert.equal(connections, 2);
  } finally {tts.close();}
  class Failed extends FakeSpeechSocket {
    send(body: string) {
      const e = JSON.parse(body);
      this.reply({header: {event: 'task-failed', task_id: e.header.task_id,
        error_code: 'SyntheticFailure', error_message: 'synthetic provider failure'}, payload: {}});
    }
  }
  const failed = new DashScopeTts(fakeQwenConfiguration(Failed), fakeTtsConfiguration);
  try {await assert.rejects(failed.synthesize('text', 'error'), /SyntheticFailure/);} finally {failed.close();}
  await assert.rejects(tts.synthesize('', 'empty'), /TTS_TEXT_INVALID/);
  assert.throws(() => inspectWav(Buffer.from('fake audio')), /TTS_INVALID_WAV/);
});
test('long text obeys message limits without changing Unicode and close prevents new tasks', async () => {
  const sent: string[] = [];
  class Socket extends FakeSpeechSocket {
    send(body: string) {
      const e = JSON.parse(body);
      if (e.header.action === 'continue-task') sent.push(e.payload.input.text);
      super.send(body);
    }
  }
  const tts = new DashScopeTts(fakeQwenConfiguration(Socket), fakeTtsConfiguration), text = '字'.repeat(19999) + '😀ending';
  await tts.synthesize(text, 'split');
  assert.equal(sent.join(''), text); assert.ok(sent.every(chunk => Array.from(chunk).length <= 20000)); tts.close();
  await assert.rejects(tts.synthesize('closed', 'closed'), /TTS_CLOSED/);
});
test('shutdown rejects active and queued tasks and a terminated idle connection reconnects', async () => {
  const entered = Promise.withResolvers<void>();
  class Held extends FakeSpeechSocket {
    send(body: string) {
      if (JSON.parse(body).header.action === 'finish-task') entered.resolve(); else super.send(body);
    }
  }
  const held = new DashScopeTts(fakeQwenConfiguration(Held), fakeTtsConfiguration);
  const active = assert.rejects(held.synthesize('active', 'active'), /TTS_CLOSED/);
  await entered.promise;
  const queued = assert.rejects(held.synthesize('queued', 'queued'), /TTS_CLOSED/);
  held.close(); await Promise.all([active, queued]);
  let socket!: Socket, connections = 0;
  class Socket extends FakeSpeechSocket {
    constructor(...args: unknown[]) {super(...args); socket = this; connections++;}
  }
  const tts = new DashScopeTts(fakeQwenConfiguration(Socket), fakeTtsConfiguration);
  try {
    await tts.synthesize('one', 'one');
    socket.emit('error', new Error('synthetic idle disconnect'));
    await tts.synthesize('two', 'two'); assert.equal(connections, 2);
  } finally {tts.close();}
});
test('text is sent only after task-started, and returning early releases the queued request', async () => {
  const entered = Promise.withResolvers<void>(); let socket!: Socket, connections = 0;
  class Socket extends FakeSpeechSocket {
    taskId = ''; sent: string[] = [];
    constructor(...args: unknown[]) {super(...args); socket = this; connections++;}
    send(body: string) {
      const event = JSON.parse(body); this.sent.push(event.header.action);
      if (connections === 1 && event.header.action === 'run-task') {this.taskId = event.header.task_id; entered.resolve(); return;}
      if (connections === 1 && event.header.action === 'finish-task') return;
      super.send(body);
    }
  }
  const tts = new DashScopeTts(fakeQwenConfiguration(Socket), fakeTtsConfiguration);
  try {
    const stream = tts.stream('first', 'first')[Symbol.asyncIterator](), first = stream.next();
    await entered.promise; assert.deepEqual(socket.sent, ['run-task']);
    socket.reply({header: {event: 'task-started', task_id: socket.taskId}, payload: {}});
    assert.equal((await first).done, false);
    const next = tts.synthesize('next', 'next'); await stream.return?.(); await next;
    assert.equal(connections, 2);
  } finally {tts.close();}
});
test('a WAV duration is whole milliseconds, rounded the way the phone checks it (voice_chunk contract integer)', () => {
  // 24 kHz mono: 1001 samples are 41.708 ms; 12 samples 0.5 ms; 36 samples 1.5 ms.
  const wav = (samples: number, rate = 24000) => {
    const data = samples * 2, bytes = Buffer.alloc(44 + data);
    bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(36 + data, 4); bytes.write('WAVE', 8, 'ascii');
    bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(data, 40);
    return bytes;
  };
  for (const [samples, expected] of [[1001, 42], [24, 1], [36, 2], [77_000, 3208]] as const) {
    const audio = inspectWav(wav(samples));
    assert.equal(audio.duration_ms, expected); assert.ok(Number.isSafeInteger(audio.duration_ms));
  }
});
