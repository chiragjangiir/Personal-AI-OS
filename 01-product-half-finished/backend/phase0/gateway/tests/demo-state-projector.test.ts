import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoStateProjector, type AcceptedDemoEvent } from '../src/demo-state-projector.ts';

const SESSION = 'phase0_session_aaaaaaaaaaaaaaaaaaaa';
const IPHONE = 'iphone_device_bbbbbbbbbbbbbbbbbbbb';
const WATCH = 'watch_device_cccccccccccccccccccc';
const RAYNEO = 'rayneo_device_dddddddddddddddddddd';
let eventSequence = 1;

function event(
  type: string,
  deviceId: string,
  deviceClass: string,
  payload: Record<string, unknown>,
): AcceptedDemoEvent {
  return {
    schema_version: 'phase0-demo/0.4',
    event_type: type,
    event_id: `10000000-0000-4000-8000-${String(eventSequence++).padStart(12, '0')}`,
    session_id: SESSION,
    occurred_at: new Date(Date.parse('2026-08-12T02:00:00.000Z') + eventSequence * 100).toISOString(),
    origin: { device_id: deviceId, device_class: deviceClass },
    payload,
  };
}

function projector(): DemoStateProjector {
  return new DemoStateProjector(SESSION, [
    { deviceId: IPHONE, deviceClass: 'iphone' },
    { deviceId: WATCH, deviceClass: 'apple_watch' },
    { deviceId: RAYNEO, deviceClass: 'rayneo' },
  ]);
}

test('projects the three terminals and redacts location precision', () => {
  const view = projector();
  view.project(event('paios.phase0.demo.session.started', 'windows_gateway_01', 'windows_gateway', {
    active_device_id: IPHONE, active_device_lease_version: 1,
  }));
  view.project(event('paios.phase0.demo.capture.status', IPHONE, 'iphone', {
    device_id: IPHONE, capture_kind: 'audio', status: 'started',
  }));
  view.project(event('paios.phase0.demo.location.observed', IPHONE, 'iphone', {
    latitude: 31.234567, longitude: 121.456789, accuracy_m: 34, activity: 'walking',
  }));
  view.project(event('paios.phase0.demo.share.received', IPHONE, 'iphone', {
    share_kind: 'text', text: 'private input is not projected',
  }));
  view.project(event('paios.phase0.demo.workout.metric', WATCH, 'apple_watch', {
    metrics: [{ name: 'heart_rate', value: 88, unit: 'bpm' }],
  }));
  view.project(event('paios.phase0.demo.confirmation.responded', WATCH, 'apple_watch', {
    choice: 'confirm',
  }));

  const snapshot = view.snapshot();
  assert.equal(snapshot.state, 'live');
  assert.equal(snapshot.activeDeviceId, IPHONE);
  assert.equal(snapshot.devices.length, 3);
  const iphone = snapshot.devices.find((device) => device.deviceClass === 'iphone');
  const watch = snapshot.devices.find((device) => device.deviceClass === 'apple_watch');
  assert.equal(iphone?.voiceState, 'started');
  assert.equal(iphone?.locationActivity, 'walking');
  assert.equal(iphone?.locationAccuracyBand, 'area');
  assert.equal(iphone?.shareKind, 'text');
  assert.equal(watch?.workoutMetric, 'heart_rate 88 bpm');
  assert.equal(watch?.confirmation, 'confirm');
  assert.equal(JSON.stringify(snapshot).includes('31.234567'), false);
  assert.equal(JSON.stringify(snapshot).includes('121.456789'), false);
  assert.equal(JSON.stringify(snapshot).includes('private input'), false);
});

test('projects frame, model result, delivery, receipt and active lease', () => {
  const view = projector();
  view.project(event('paios.phase0.demo.session.started', 'windows_gateway_01', 'windows_gateway', {
    active_device_id: IPHONE, active_device_lease_version: 1,
  }));
  view.project(event('paios.phase0.demo.media.referenced', RAYNEO, 'rayneo', {
    media_ref: { media_id: 'rayneo_frame_eeeeeeeeeeeeeeeeeeee', kind: 'image' },
  }));
  const result = event('paios.phase0.demo.model.result', 'windows_gateway_01', 'windows_gateway', {
    status: 'success', latency_ms: 812,
    outputs: [{ modality: 'text', text: 'A bounded synthetic result.' }],
  });
  view.project(result);
  view.project(event('paios.phase0.demo.delivery.requested', 'windows_gateway_01', 'windows_gateway', {
    result_event_id: result.event_id, target_device_id: RAYNEO,
  }));
  view.project(event('paios.phase0.demo.delivery.acknowledged', RAYNEO, 'rayneo', {
    target_device_id: RAYNEO, disposition: 'rendered',
  }));
  view.project(event('paios.phase0.demo.handoff.completed', 'windows_gateway_01', 'windows_gateway', {
    from_device_id: WATCH, active_device_id: RAYNEO, active_device_lease_version: 3,
  }));
  const snapshot = view.snapshot();
  const rayneo = snapshot.devices.find((device) => device.deviceClass === 'rayneo');
  assert.equal(rayneo?.frameReference, 'rayneo_frame_eeeeeeeeeeeeeeeeeeee');
  assert.equal(rayneo?.modelResult, 'A bounded synthetic result.');
  assert.equal(rayneo?.modelLatencyMs, 812);
  assert.equal(rayneo?.renderReceipt, 'rendered');
  assert.equal(snapshot.activeDeviceId, RAYNEO);
  assert.equal(snapshot.activeDeviceLeaseVersion, 3);
  assert.equal(snapshot.suppressedDeviceId, WATCH);
});

test('exact retry is a no-op and event-id drift conflicts', () => {
  const view = projector();
  const accepted = event('paios.phase0.demo.device.status', IPHONE, 'iphone', {
    device_id: IPHONE, status: 'online',
  });
  assert.equal(view.project(accepted).duplicate, false);
  assert.equal(view.project(accepted).duplicate, true);
  assert.equal(view.snapshot().acceptedEventCount, 1);
  assert.throws(() => view.project({ ...accepted, payload: { ...accepted.payload, status: 'offline' } }), /PROJECTION_EVENT_ID_CONFLICT/);
});

test('display projection accepts one standalone RayNeo without inventing other terminals', () => {
  const view = new DemoStateProjector(SESSION, [{ deviceId: RAYNEO, deviceClass: 'rayneo' }]);
  const snapshot = view.snapshot();
  assert.deepEqual(snapshot.devices.map((device) => device.deviceClass), ['rayneo']);
  assert.throws(() => new DemoStateProjector(SESSION, [{ deviceId: IPHONE, deviceClass: 'iphone' }]), /TERMINAL_SET_INVALID/u);
});
