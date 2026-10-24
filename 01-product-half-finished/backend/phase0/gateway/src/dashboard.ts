export function renderDashboard(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Phase 0 Terminal Loop</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #070b0e;
      color: #eef4f5;
      --surface: #0c1216;
      --surface-raised: #10181d;
      --line: #263137;
      --line-quiet: #182126;
      --text: #eef4f5;
      --muted: #91a0a7;
      --quiet: #64727a;
      --accent: #31d5e7;
      --danger: #ff8c92;
      --radius: 14px;
      font-variant-numeric: tabular-nums;
    }
    * { box-sizing: border-box; }
    ::selection { background: rgba(49, 213, 231, .24); color: var(--text); }
    body { margin: 0; min-width: 320px; background: #070b0e; }
    button, input, select { font: inherit; }
    button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .shell { width: min(1440px, 100%); margin: 0 auto; padding: 24px clamp(16px, 3vw, 44px) 48px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 1.35rem; line-height: 1.2; letter-spacing: -.025em; }
    .subtitle { margin: 6px 0 0; color: var(--muted); font-size: .875rem; }
    .health { min-width: 88px; border: 1px solid var(--line); border-radius: 999px; padding: 7px 11px; color: var(--muted); text-align: center; font-size: .78rem; }
    .health[data-state="ready"] { border-color: var(--accent); color: var(--accent); }
    .health[data-state="unavailable"] { color: var(--danger); }
    .empty { margin: 48px 0; color: var(--muted); text-align: center; }
    .session { padding: 22px 0 0; }
    .session + .session { margin-top: 28px; border-top: 1px solid var(--line); }
    .session.cleaned { opacity: .68; }
    .session-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; }
    .identity { min-width: 0; }
    .identity code { display: block; overflow: hidden; color: var(--text); font-size: .92rem; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 8px; color: var(--muted); font-size: .78rem; }
    .session-meta strong { color: var(--text); font-weight: 600; }
    .stop { border: 1px solid var(--line); border-radius: 10px; background: transparent; color: var(--text); padding: 9px 13px; cursor: pointer; transition: border-color 150ms ease, color 150ms ease, transform 150ms ease; }
    .stop:hover { border-color: var(--accent); color: var(--accent); }
    .stop:active { transform: translateY(1px); }
    .stop:disabled { cursor: not-allowed; color: var(--quiet); border-color: var(--line-quiet); transform: none; }
    .device-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .device { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 14px; }
    .device[data-active="true"] { border-color: var(--accent); background: #0c171b; }
    .device[data-status="offline"], .device[data-status="stopped"] { opacity: .56; }
    .device-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .device h2 { margin: 0; font-size: .95rem; letter-spacing: -.015em; }
    .device-state { color: var(--muted); font-size: .75rem; }
    .device[data-active="true"] .device-state { color: var(--accent); }
    dl { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 8px 10px; margin: 15px 0 0; font-size: .78rem; }
    dt { color: var(--quiet); }
    dd { min-width: 0; margin: 0; color: var(--muted); overflow-wrap: anywhere; }
    .progress-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, .42fr); gap: 12px; margin-top: 12px; }
    .progress, .result { border-radius: var(--radius); background: var(--surface-raised); padding: 14px; }
    .panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .panel-head h3 { margin: 0; font-size: .84rem; }
    .panel-value { color: var(--accent); font-size: .78rem; }
    .steps { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 4px; margin-top: 13px; }
    .step { height: 6px; border-radius: 999px; background: #263137; }
    .step[data-complete="true"] { background: var(--accent); }
    .result-copy { margin: 12px 0 0; color: var(--muted); font-size: .82rem; line-height: 1.5; overflow-wrap: anywhere; }
    .timeline-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-top: 18px; }
    .timeline-head h3 { margin: 0; font-size: .84rem; }
    .timeline-head span { color: var(--quiet); font-size: .74rem; }
    ol { max-height: 38vh; margin: 8px 0 0; padding: 0; overflow: auto; list-style: none; scrollbar-color: #34434a transparent; }
    li { display: grid; grid-template-columns: 180px 118px minmax(0, 1fr); gap: 12px; padding: 9px 0; border-top: 1px solid var(--line-quiet); font-size: .77rem; }
    time, .event-kind { color: var(--quiet); }
    .accepted { color: var(--text); } .rejected { color: var(--danger); } .lifecycle { color: var(--muted); }
    @media (max-width: 800px) {
      .shell { padding-top: 18px; }
      header { align-items: center; }
      .device-grid, .progress-panel { grid-template-columns: 1fr; }
      li { grid-template-columns: 1fr; gap: 4px; }
      .session-head { grid-template-columns: 1fr; }
      .stop { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition-duration: 0ms !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div><h1>Phase 0 terminal loop</h1><p class="subtitle">One temporary session. Three physical terminals. Accepted events only.</p></div>
      <span class="health" id="health" data-state="checking" role="status">Checking</span>
    </header>
    <section id="sessions" aria-live="polite"><p class="empty">No active shared session.</p></section>
  </main>
  <script nonce="${nonce}">
    const root = document.getElementById('sessions');
    const health = document.getElementById('health');
    const streams = new Map();
    const deviceOrder = [
      ['iphone', 'iPhone'],
      ['apple_watch', 'Watch'],
      ['rayneo', 'RayNeo']
    ];
    function text(node, value) { if (node) node.textContent = String(value); }
    function deviceMarkup(kind, label) {
      return '<article class="device" data-device-class="' + kind + '" data-status="offline" data-active="false">' +
        '<div class="device-head"><h2>' + label + '</h2><span class="device-state" data-role="device-state">offline</span></div>' +
        '<dl><dt>Last event</dt><dd data-role="last-event">Waiting</dd>' +
        '<dt>Signal</dt><dd data-role="signal">No accepted signal</dd>' +
        '<dt>Latency</dt><dd data-role="latency">Not measured</dd></dl></article>';
    }
    function sessionCard(id) {
      let card = document.getElementById('session-' + id);
      if (card) return card;
      const wrapper = document.createElement('article');
      wrapper.className = 'session'; wrapper.id = 'session-' + id; wrapper.dataset.state = 'active';
      wrapper.innerHTML = '<div class="session-head"><div class="identity"><code></code><div class="session-meta">' +
        '<span>State <strong data-role="state">active</strong></span><span>Active <strong data-role="active-device">iPhone</strong></span>' +
        '<span>Lease <strong data-role="lease">1</strong></span><span>Suppressed <strong data-role="suppressed">none</strong></span></div></div>' +
        '<button class="stop" type="button">Stop and clean</button></div>' +
        '<div class="device-grid">' + deviceOrder.map(([kind, label]) => deviceMarkup(kind, label)).join('') + '</div>' +
        '<div class="progress-panel"><section class="progress"><div class="panel-head"><h3>12-step run</h3><span class="panel-value" data-role="progress-value">0 / 12</span></div>' +
        '<div class="steps" aria-label="12-step progress">' + Array.from({ length: 12 }, (_, i) => '<span class="step" data-step="' + (i + 1) + '" data-complete="false"></span>').join('') + '</div></section>' +
        '<section class="result"><div class="panel-head"><h3>Latest model result</h3><span class="panel-value" data-role="model-latency">Not measured</span></div>' +
        '<p class="result-copy" data-role="model-result">Waiting for an accepted model result.</p></section></div>' +
        '<div class="timeline-head"><h3>Accepted timeline</h3><span>Newest first</span></div><ol></ol>';
      text(wrapper.querySelector('code'), id);
      const stop = wrapper.querySelector('button');
      stop.onclick = async () => {
        stop.disabled = true; text(wrapper.querySelector('[data-role="state"]'), 'cleaning');
        try {
          const response = await fetch('/sessions/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
          const result = await response.json();
          if (!response.ok || result.status !== 'cleanup_complete') throw new Error(result.error || 'CLEANUP_FAILED');
          markCleaned(id);
        } catch (error) {
          text(wrapper.querySelector('[data-role="state"]'), 'cleanup failed'); stop.disabled = false;
          append(id, { kind: 'rejected', occurredAt: new Date().toISOString(), errors: [error instanceof Error ? error.message : 'CLEANUP_FAILED'] });
        }
      };
      root.querySelector('.empty')?.remove(); root.append(wrapper); return wrapper;
    }
    function deviceFor(card, deviceClass) { return card.querySelector('[data-device-class="' + deviceClass + '"]'); }
    function classFor(item) {
      if (item.deviceClass) return item.deviceClass;
      const id = String(item.originDeviceId || '').toLowerCase();
      if (id.includes('watch')) return 'apple_watch';
      if (id.includes('rayneo')) return 'rayneo';
      if (id.includes('iphone')) return 'iphone';
      return null;
    }
    function signalFor(item, eventType) {
      if (eventType.endsWith('transcript.final')) return item.displayText || 'Final voice transcript accepted';
      if (eventType.endsWith('location.observed')) return item.locationActivity || item.displayText || 'Foreground location or activity accepted';
      if (eventType.endsWith('share.received')) return item.shareKind || item.displayText || 'Explicit share accepted';
      if (eventType.endsWith('workout.metric')) return item.workoutMetric || item.displayText || 'Workout metric accepted';
      if (eventType.endsWith('confirmation.responded')) return item.confirmation || item.displayText || 'Watch confirmation accepted';
      if (eventType.endsWith('media.referenced')) return item.frameReference || item.displayText || 'Frame reference accepted';
      if (eventType.endsWith('delivery.acknowledged')) return item.renderReceipt || item.displayText || 'Delivery receipt accepted';
      if (eventType.endsWith('device.telemetry')) return item.telemetry || item.displayText || 'Low-rate telemetry bucket accepted';
      return item.displayText;
    }
    function updateProgress(card, item) {
      const step = Number(item.demoStep || item.step || 0);
      if (step >= 1 && step <= 12) {
        for (const node of card.querySelectorAll('.step')) node.dataset.complete = Number(node.dataset.step) <= step ? 'true' : 'false';
        text(card.querySelector('[data-role="progress-value"]'), step + ' / 12');
      }
    }
    function project(id, item) {
      const card = sessionCard(id); const deviceClass = classFor(item); const eventType = String(item.eventType || '');
      const device = deviceClass ? deviceFor(card, deviceClass) : null;
      if (device) {
        device.dataset.status = item.deviceStatus || (eventType.endsWith('session.ended') ? 'stopped' : 'online');
        text(device.querySelector('[data-role="device-state"]'), device.dataset.status);
        text(device.querySelector('[data-role="last-event"]'), eventType ? eventType.replace('paios.phase0.demo.', '') : 'lifecycle');
        const signal = signalFor(item, eventType); if (signal) text(device.querySelector('[data-role="signal"]'), signal);
        if (Number.isFinite(item.latencyMs)) text(device.querySelector('[data-role="latency"]'), item.latencyMs + ' ms');
      }
      if (item.activeDeviceId) {
        text(card.querySelector('[data-role="active-device"]'), item.activeDeviceId);
        for (const node of card.querySelectorAll('.device')) node.dataset.active = classFor({ originDeviceId: item.activeDeviceId }) === node.dataset.deviceClass ? 'true' : 'false';
      }
      if (Number.isInteger(item.activeDeviceLeaseVersion)) text(card.querySelector('[data-role="lease"]'), item.activeDeviceLeaseVersion);
      if (item.suppressedDeviceId) text(card.querySelector('[data-role="suppressed"]'), item.suppressedDeviceId);
      if (eventType.endsWith('model.result')) {
        text(card.querySelector('[data-role="model-result"]'), item.displayText || 'Accepted model result');
        if (Number.isFinite(item.latencyMs)) text(card.querySelector('[data-role="model-latency"]'), item.latencyMs + ' ms');
      }
      if (item.lowRate) {
        const rayneo = deviceFor(card, 'rayneo');
        if (rayneo) {
          rayneo.dataset.status = item.lowRate.failed ? 'stopped' : 'online';
          text(rayneo.querySelector('[data-role="device-state"]'), rayneo.dataset.status);
          text(rayneo.querySelector('[data-role="last-event"]'), item.lowRate.pendingReceipt ? 'display receipt pending' : 'low-rate product');
          if (item.lowRate.lastModelText) text(rayneo.querySelector('[data-role="signal"]'), item.lowRate.lastModelText);
        }
        if (item.lowRate.lastModelText) text(card.querySelector('[data-role="model-result"]'), item.lowRate.lastModelText);
      }
      updateProgress(card, item);
    }
    function append(id, item) {
      const card = sessionCard(id); project(id, item);
      const list = card.querySelector('ol'); const row = document.createElement('li');
      const stamp = document.createElement('time'); stamp.textContent = item.occurredAt || new Date().toISOString();
      const kind = document.createElement('span'); kind.className = 'event-kind'; kind.textContent = item.kind || 'lifecycle';
      const message = document.createElement('span'); message.className = item.kind || 'lifecycle';
      message.textContent = [item.eventType, item.originDeviceId, item.displayText, ...(item.errors || [])].filter(Boolean).join(' / ');
      row.append(stamp, kind, message); list.prepend(row); while (list.children.length > 120) list.lastChild.remove();
    }
    function markCleaned(id, detail = 'cleaned') {
      const card = document.getElementById('session-' + id); streams.get(id)?.close(); streams.delete(id); if (!card) return;
      card.classList.add('cleaned'); card.dataset.state = 'cleaned'; text(card.querySelector('[data-role="state"]'), detail);
      const stop = card.querySelector('button'); stop.disabled = true; stop.textContent = 'Cleaned';
      for (const device of card.querySelectorAll('.device')) { device.dataset.status = 'stopped'; text(device.querySelector('[data-role="device-state"]'), 'stopped'); }
    }
    function markUnavailable(id) {
      const card = document.getElementById('session-' + id); streams.get(id)?.close(); streams.delete(id); if (!card) return;
      card.dataset.state = 'unavailable'; text(card.querySelector('[data-role="state"]'), 'cleanup unverified');
      const stop = card.querySelector('button'); stop.disabled = true; stop.textContent = 'Unavailable';
    }
    function markActive(id) {
      const card = sessionCard(id); if (card.classList.contains('cleaned')) return;
      card.dataset.state = 'active'; text(card.querySelector('[data-role="state"]'), 'active');
      const stop = card.querySelector('button'); stop.disabled = false; stop.textContent = 'Stop and clean';
    }
    async function loadSnapshot(id) {
      try {
        const response = await fetch('/phase0/demo/v1/sessions/' + encodeURIComponent(id) + '/snapshot', { cache: 'no-store' });
        if (!response.ok) return;
        const snapshot = await response.json();
        project(id, snapshot);
        for (const device of snapshot.devices || []) {
          const signal = device.modelResult || device.renderReceipt || device.workoutMetric || device.confirmation ||
            device.locationActivity || device.shareKind || device.frameReference || device.voiceState;
          project(id, {
            ...device,
            originDeviceId: device.deviceId,
            eventType: device.lastEventType,
            occurredAt: device.lastEventAt,
            deviceStatus: device.status,
            displayText: signal,
            latencyMs: device.modelLatencyMs
          });
        }
      } catch { /* Predecessor runtime has no umbrella projection route yet. */ }
    }
    function watch(id) {
      if (streams.has(id)) return;
      const source = new EventSource('/phase0/demo/v1/sessions/' + encodeURIComponent(id) + '/events');
      source.onmessage = (event) => {
        const item = JSON.parse(event.data); append(id, item);
        if (item.eventType === 'paios.phase0.demo.session.cleanup.completed' && item.verifiedCleanup === true) markCleaned(id);
      };
      source.onerror = () => {
        source.close(); streams.delete(id); const card = document.getElementById('session-' + id);
        if (card?.dataset.state !== 'cleaned') text(card?.querySelector('[data-role="state"]'), 'reconnecting');
      };
      streams.set(id, source);
    }
    async function refresh() {
      try {
        const response = await fetch('/healthz', { cache: 'no-store' }); const state = await response.json();
        if (!response.ok) throw new Error('HEALTH_FAILED');
        health.textContent = state.status; health.dataset.state = state.status === 'ready' ? 'ready' : 'checking';
        const active = new Set(state.activeSessions || []);
        for (const id of active) { markActive(id); watch(id); void loadSnapshot(id); }
        for (const card of root.querySelectorAll('.session:not(.cleaned)')) { const id = card.id.slice(8); if (!active.has(id)) markUnavailable(id); }
      } catch { health.textContent = 'Unavailable'; health.dataset.state = 'unavailable'; }
    }
    refresh(); setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}
