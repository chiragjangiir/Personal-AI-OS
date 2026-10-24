import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectGatewayStartupMode,
  startGateway,
} from '../src/main.ts';
import {
  isRealtimePublicControlRoute,
  parseRealtimePublicControlFeatureFlag,
  type RealtimePublicControlController,
} from '../src/realtime-public-control-controller.ts';

test('V2 route matcher owns the supported exact POST paths', () => {
  assert.deepEqual([
    '/v1/realtime/bootstrap',
    '/v1/realtime/e2ee/key/resolve',
    '/v1/realtime/credentials/refresh',
    '/v1/realtime/media/stop',
    '/v1/realtime/end-continuity',
  ].map((path) => isRealtimePublicControlRoute('POST', path)), [true, true, true, true, true]);
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/handoff'), false);
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/bootstrap?x=1'), false);
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/bootstrap/'), false);
});

test('feature flag is closed by default and rejects malformed values', () => {
  assert.equal(parseRealtimePublicControlFeatureFlag({}), false);
  assert.equal(parseRealtimePublicControlFeatureFlag({ PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '0' }), false);
  assert.equal(parseRealtimePublicControlFeatureFlag({ PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '1' }), true);
  assert.throws(() => parseRealtimePublicControlFeatureFlag({ PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: 'true' }), /PUBLIC_RTC_FEATURE_FLAG_INVALID/);
});

test('enabled V2 flag fails closed before listener when no injected controller exists', async () => {
  await assert.rejects(
    startGateway(undefined, { environment: { PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '1' } }),
    /PUBLIC_RTC_CONTROLLER_REQUIRED/,
  );
});

test('enabled V2 flag cannot silently activate an old demo or persistent mode', () => {
  assert.equal(selectGatewayStartupMode({ PAIOS_DEMO_ROAMING: '1' }), 'demo-roaming');
  assert.equal(selectGatewayStartupMode({ PAIOS_ROAMING_PERSISTENT_RUNTIME: '1' }), 'persistent-roaming');
});

test('flag OFF preserves persistent startup without successor injection', async () => {
  let received: RealtimePublicControlController | undefined;
  let argumentCount = 0;
  await startGateway(undefined, {
    environment: { PAIOS_ROAMING_PERSISTENT_RUNTIME: '1' },
    startPersistentGateway: async (...args) => { argumentCount = args.length; received = args[1]; },
  });
  assert.equal(received, undefined);
  assert.equal(argumentCount, 1);
});

test('flag ON passes the same successor controller into persistent startup without opening a test listener', async () => {
  const controller = {} as RealtimePublicControlController;
  let received: RealtimePublicControlController | undefined;
  let argumentCount = 0;
  await startGateway(undefined, {
    environment: { PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '1', PAIOS_ROAMING_PERSISTENT_RUNTIME: '1' },
    publicRtcControl: controller,
    startPersistentGateway: async (...args) => { argumentCount = args.length; received = args[1]; },
  });
  assert.equal(received, controller);
  assert.equal(argumentCount, 2);
});
