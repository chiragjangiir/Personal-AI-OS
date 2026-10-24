import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDashboard } from '../src/dashboard.ts';

test('renders a dark three-terminal projection with one cyan accent', () => {
  const html = renderDashboard('nonce-value');
  assert.match(html, /<style nonce="nonce-value">/);
  assert.match(html, /<script nonce="nonce-value">/);
  assert.match(html, /--accent: #31d5e7/);
  assert.match(html, /color-scheme: dark/);
  assert.match(html, /\['iphone', 'iPhone'\]/);
  assert.match(html, /\['apple_watch', 'Watch'\]/);
  assert.match(html, /\['rayneo', 'RayNeo'\]/);
  assert.match(html, /data-role="active-device"/);
  assert.match(html, /data-role="lease"/);
  assert.match(html, /data-role="suppressed"/);
  assert.equal(html.includes('> STOP <'), false);
  assert.equal(html.includes('linear-gradient'), false);
});

test('exposes required voice, location, workout, frame, result and latency surfaces', () => {
  const html = renderDashboard('n');
  for (const literal of [
    'data-role="signal"',
    'data-role="latency"',
    'data-role="model-result"',
    'data-role="model-latency"',
    '12-step run',
    'data-role="progress-value"',
    'location.observed',
    'workout.metric',
    'media.referenced',
    'model.result',
    'delivery.acknowledged',
    'device.telemetry',
  ]) assert.equal(html.includes(literal), true, literal);
  assert.match(html, /Array\.from\(\{ length: 12 \}/);
  assert.match(html, /\/phase0\/demo\/v1\/sessions\//);
});

test('preserves predecessor stop, health and SSE behavior with bounded responsive states', () => {
  const html = renderDashboard('n');
  assert.match(html, /fetch\('\/healthz'/);
  assert.match(html, /new EventSource\('\/phase0\/demo\/v1\/sessions\/'/);
  assert.match(html, /fetch\('\/sessions\/' \+ encodeURIComponent\(id\) \+ '\/stop'/);
  assert.match(html, /while \(list\.children\.length > 120\)/);
  assert.match(html, /@media \(max-width: 800px\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /button:focus-visible/);
  assert.match(html, /\.health\[data-state="unavailable"\]/);
});
