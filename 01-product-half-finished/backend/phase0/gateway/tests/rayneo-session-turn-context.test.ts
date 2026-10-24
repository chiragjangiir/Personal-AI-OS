import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RayneoConversationRegistry,
  RayneoSessionTurnContext,
  RAYNEO_CONVERSATION_LIMITS,
  RAYNEO_SESSION_TURN_CONTEXT_LIMITS,
} from '../src/rayneo-session-turn-context.ts';

test('session turn context stays bounded, evicts oldest turns, and deduplicates keys', () => {
  const context = new RayneoSessionTurnContext();
  for (let index = 0; index < 9; index += 1) {
    assert.equal(context.appendRealtime(
      `segment-${index}`,
      'speaker_window_local',
      '多人声转写内容'.repeat(80),
      `回复${index}`,
    ), true);
  }
  assert.ok(context.turnCount <= RAYNEO_SESSION_TURN_CONTEXT_LIMITS.maxTurns);
  assert.ok(context.renderedBytes <= RAYNEO_SESSION_TURN_CONTEXT_LIMITS.maxRenderedBytes);
  assert.equal(context.hasRealtimeTurn(), true);
  assert.equal(context.snapshot().includes('回复0'), false);
  assert.equal(context.appendVisual('segment-8', '重复键不应重复追加。'), false);
  for (const rendered of context.snapshot().split('\n')) {
    assert.ok(Buffer.byteLength(rendered, 'utf8') <= RAYNEO_SESSION_TURN_CONTEXT_LIMITS.maxTurnBytes);
  }
});

test('visual and realtime turns render into one isolated session snapshot', () => {
  const first = new RayneoSessionTurnContext();
  const second = new RayneoSessionTurnContext();
  assert.equal(first.appendRealtime('one', 'speaker_window_local', '先前转写。', '先前回复。'), true);
  assert.equal(first.appendVisual('two', '当前图片回复。'), true);
  assert.equal(first.hasRealtimeTurn(), true);
  assert.match(first.snapshot(), /先前转写。/u);
  assert.match(first.snapshot(), /当前图片回复。/u);
  assert.equal(second.snapshot(), '');
  assert.equal(second.hasRealtimeTurn(), false);
  first.close();
  first.close();
  assert.equal(first.closed, true);
  assert.equal(first.appendVisual('three', '关闭后不能追加。'), false);
  assert.equal(first.snapshot(), '');
  assert.equal(second.appendVisual('only', '另一个会话。'), true);
  assert.match(second.snapshot(), /另一个会话。/u);
});

test('retained media context survives close and is only cleared by disposal', () => {
  const context = new RayneoSessionTurnContext({ retainOnClose: true });
  assert.equal(context.appendVisual('photo-1', '当天的图片回复。'), true);
  assert.equal(context.hasRealtimeTurn(), false);
  context.close();
  assert.equal(context.closed, false);
  assert.match(context.snapshot(), /当天的图片回复。/u);
  context.dispose();
  assert.equal(context.closed, true);
  assert.equal(context.snapshot(), '');
});

test('conversation registry slides on accepted turns, expires, isolates devices, and evicts oldest bounded entry', () => {
  let now = 0;
  const registry = new RayneoConversationRegistry({ now: () => now, ttlMs: 100, maxEntries: 2 });
  const first = registry.acquire('device-a');
  assert.equal(first.appendVisual('photo-1', '首个设备的历史。'), true);
  now = 50;
  assert.equal(first.appendRealtime('audio-1', 'speaker_window_local', '同一设备转写。', '同一设备回复。'), true);
  now = 149;
  assert.equal(registry.acquire('device-a'), first);
  now = 250;
  const expired = registry.acquire('device-a');
  assert.notEqual(expired, first);
  assert.equal(first.closed, true);
  assert.equal(expired.snapshot(), '');

  const second = registry.acquire('device-b');
  assert.equal(second.snapshot(), '');
  assert.notEqual(expired, second);
  assert.equal(registry.has('device-b'), true);

  let boundedNow = 0;
  const bounded = new RayneoConversationRegistry({ now: () => boundedNow, ttlMs: 1_000, maxEntries: 2 });
  const oldest = bounded.acquire('device-oldest');
  boundedNow = 1;
  const retained = bounded.acquire('device-retained');
  boundedNow = 2;
  const newest = bounded.acquire('device-newest');
  assert.equal(bounded.size, 2);
  assert.equal(oldest.closed, true);
  assert.equal(bounded.has('device-oldest'), false);
  assert.equal(bounded.has('device-retained'), true);
  assert.equal(bounded.has('device-newest'), true);
  assert.equal(retained.closed, false);
  assert.equal(newest.closed, false);
  assert.equal(RAYNEO_CONVERSATION_LIMITS.ttlMs, 86_400_000);
  assert.equal(RAYNEO_CONVERSATION_LIMITS.maxEntries, 32);
});
