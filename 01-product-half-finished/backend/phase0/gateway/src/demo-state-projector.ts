import { createHash } from 'node:crypto';

export type ProjectedDeviceClass = 'iphone' | 'apple_watch' | 'rayneo';
export type ProjectedDeviceStatus = 'offline' | 'online' | 'reconnecting' | 'stopped';

export interface AcceptedDemoEvent {
  readonly schema_version: 'phase0-demo/0.4';
  readonly event_type: string;
  readonly event_id: string;
  readonly session_id: string;
  readonly occurred_at: string;
  readonly origin: Readonly<{
    device_id: string;
    device_class: string;
    relay?: Readonly<{ device_id: string; device_class: 'iphone'; transport: 'watch_connectivity' }>;
  }>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DemoDeviceProjection {
  readonly deviceId: string;
  readonly deviceClass: ProjectedDeviceClass;
  readonly status: ProjectedDeviceStatus;
  readonly lastEventType?: string;
  readonly lastEventAt?: string;
  readonly voiceState?: string;
  readonly locationActivity?: string;
  readonly locationAccuracyBand?: string;
  readonly shareKind?: string;
  readonly workoutMetric?: string;
  readonly confirmation?: string;
  readonly frameReference?: string;
  readonly modelResult?: string;
  readonly modelLatencyMs?: number;
  readonly renderReceipt?: string;
  readonly telemetry?: readonly string[];
}

export interface DemoSessionProjection {
  readonly sessionId: string;
  readonly state: 'waiting' | 'live' | 'ended' | 'cleaned';
  readonly activeDeviceId?: string;
  readonly activeDeviceLeaseVersion?: number;
  readonly suppressedDeviceId?: string;
  readonly latestModelResult?: string;
  readonly latestModelLatencyMs?: number;
  readonly devices: readonly DemoDeviceProjection[];
  readonly acceptedEventCount: number;
}

interface MutableDeviceProjection {
  deviceId: string;
  deviceClass: ProjectedDeviceClass;
  status: ProjectedDeviceStatus;
  lastEventType?: string | undefined;
  lastEventAt?: string | undefined;
  voiceState?: string | undefined;
  locationActivity?: string | undefined;
  locationAccuracyBand?: string | undefined;
  shareKind?: string | undefined;
  workoutMetric?: string | undefined;
  confirmation?: string | undefined;
  frameReference?: string | undefined;
  modelResult?: string | undefined;
  modelLatencyMs?: number | undefined;
  renderReceipt?: string | undefined;
  telemetry?: readonly string[] | undefined;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function fingerprint(event: AcceptedDemoEvent): string {
  return createHash('sha256').update(stable(event)).digest('hex');
}

function text(value: unknown, maximum = 160): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function accuracyBand(value: unknown): string | undefined {
  const meters = number(value);
  if (meters === undefined) return undefined;
  if (meters <= 25) return 'nearby';
  if (meters <= 250) return 'area';
  return 'coarse';
}

function deviceClass(value: string): ProjectedDeviceClass | undefined {
  if (value === 'iphone' || value === 'apple_watch' || value === 'rayneo') return value;
  return undefined;
}

function metricSummary(metrics: unknown): string | undefined {
  if (!Array.isArray(metrics)) return undefined;
  const parts = metrics.slice(0, 8).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const metric = candidate as Record<string, unknown>;
    const name = text(metric.name, 40);
    const value = number(metric.value);
    const unit = text(metric.unit, 16);
    return name && value !== undefined && unit ? [`${name} ${value} ${unit}`] : [];
  });
  return parts.length === 0 ? undefined : parts.join(', ');
}

function telemetrySummary(metrics: unknown): readonly string[] | undefined {
  const summary = metricSummary(metrics);
  return summary?.split(', ');
}

/** Display-only projection of already accepted v0.4 events. */
export class DemoStateProjector {
  readonly #sessionId: string;
  readonly #devices = new Map<string, MutableDeviceProjection>();
  readonly #fingerprints = new Map<string, string>();
  readonly #resultByEventId = new Map<string, { text: string | undefined; latencyMs: number | undefined }>();
  #state: DemoSessionProjection['state'] = 'waiting';
  #activeDeviceId: string | undefined;
  #activeDeviceLeaseVersion: number | undefined;
  #suppressedDeviceId: string | undefined;
  #latestModelResult: string | undefined;
  #latestModelLatencyMs: number | undefined;

  constructor(sessionId: string, devices: readonly Readonly<{
    deviceId: string;
    deviceClass: ProjectedDeviceClass;
  }>[]) {
    if (!/^[a-z][a-z0-9_-]{2,63}$/.test(sessionId)) throw new Error('SESSION_ID_INVALID');
    const classes = new Set(devices.map((item) => item.deviceClass));
    const sharedHandoff = devices.length === 3 && classes.size === 3;
    const rayneoStandalone = devices.length === 1 && devices[0]?.deviceClass === 'rayneo';
    if (!sharedHandoff && !rayneoStandalone) {
      throw new Error('TERMINAL_SET_INVALID');
    }
    this.#sessionId = sessionId;
    for (const registration of devices) {
      if (this.#devices.has(registration.deviceId)) throw new Error('TERMINAL_SET_INVALID');
      this.#devices.set(registration.deviceId, {
        deviceId: registration.deviceId,
        deviceClass: registration.deviceClass,
        status: 'offline',
      });
    }
  }

  project(event: AcceptedDemoEvent): Readonly<{ duplicate: boolean; snapshot: DemoSessionProjection }> {
    if (event.schema_version !== 'phase0-demo/0.4' || event.session_id !== this.#sessionId) {
      throw new Error('PROJECTION_EVENT_OUT_OF_SCOPE');
    }
    const digest = fingerprint(event);
    const prior = this.#fingerprints.get(event.event_id);
    if (prior) {
      if (prior !== digest) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
      return { duplicate: true, snapshot: this.snapshot() };
    }
    const payload = event.payload;
    const originClass = deviceClass(event.origin.device_class);
    const originDevice = originClass ? this.#devices.get(event.origin.device_id) : undefined;
    if (originClass && (!originDevice || originDevice.deviceClass !== originClass)) {
      throw new Error('PROJECTION_DEVICE_MISMATCH');
    }
    if (this.#fingerprints.size >= 512) throw new Error('PROJECTION_EVENT_LIMIT');
    this.#fingerprints.set(event.event_id, digest);
    if (originDevice) {
      originDevice.lastEventType = event.event_type;
      originDevice.lastEventAt = event.occurred_at;
      if (originDevice.status !== 'stopped') originDevice.status = 'online';
    }

    switch (event.event_type) {
      case 'paios.phase0.demo.session.started':
        this.#state = 'live';
        this.#activeDeviceId = text(payload.active_device_id, 64);
        this.#activeDeviceLeaseVersion = number(payload.active_device_lease_version);
        break;
      case 'paios.phase0.demo.device.status': {
        const target = this.#devices.get(String(payload.device_id ?? ''));
        const status = payload.status;
        if (target && (status === 'online' || status === 'offline' || status === 'blocked')) {
          target.status = status === 'online' ? 'online' : 'offline';
        }
        break;
      }
      case 'paios.phase0.demo.capture.status':
        if (originDevice) {
          const kind = text(payload.capture_kind, 20);
          const status = text(payload.status, 20);
          if (kind === 'audio') originDevice.voiceState = status;
          if (kind === 'workout') originDevice.workoutMetric = `workout ${status}`;
          if (kind === 'camera') originDevice.frameReference = `camera ${status}`;
        }
        break;
      case 'paios.phase0.demo.transcript.final':
        if (originDevice) originDevice.voiceState = text(payload.text, 120) ?? 'final transcript';
        break;
      case 'paios.phase0.demo.location.observed':
        if (originDevice) {
          originDevice.locationActivity = text(payload.activity, 32);
          originDevice.locationAccuracyBand = accuracyBand(payload.accuracy_m);
        }
        break;
      case 'paios.phase0.demo.share.received':
        if (originDevice) originDevice.shareKind = text(payload.share_kind, 16);
        break;
      case 'paios.phase0.demo.workout.metric':
        if (originDevice) originDevice.workoutMetric = metricSummary(payload.metrics);
        break;
      case 'paios.phase0.demo.confirmation.responded':
        if (originDevice) originDevice.confirmation = text(payload.choice, 32);
        break;
      case 'paios.phase0.demo.media.referenced':
        if (originDevice && payload.media_ref && typeof payload.media_ref === 'object') {
          const media = payload.media_ref as Record<string, unknown>;
          if (media.kind === 'image') originDevice.frameReference = text(media.media_id, 67);
        }
        break;
      case 'paios.phase0.demo.device.telemetry':
        if (originDevice) originDevice.telemetry = telemetrySummary(payload.metrics);
        break;
      case 'paios.phase0.demo.model.result': {
        const latency = number(payload.latency_ms);
        let resultText: string | undefined;
        if (Array.isArray(payload.outputs)) {
          const output = payload.outputs.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).modality === 'text') as Record<string, unknown> | undefined;
          resultText = text(output?.text, 240);
        }
        this.#latestModelResult = resultText ?? text(payload.status, 24);
        this.#latestModelLatencyMs = latency;
        this.#resultByEventId.set(event.event_id, { text: this.#latestModelResult, latencyMs: latency });
        break;
      }
      case 'paios.phase0.demo.delivery.requested': {
        const target = this.#devices.get(String(payload.target_device_id ?? ''));
        const result = this.#resultByEventId.get(String(payload.result_event_id ?? ''));
        if (target && result) {
          target.modelResult = result.text;
          target.modelLatencyMs = result.latencyMs;
        }
        break;
      }
      case 'paios.phase0.demo.delivery.acknowledged': {
        const target = this.#devices.get(String(payload.target_device_id ?? ''));
        if (target) target.renderReceipt = text(payload.disposition, 32);
        break;
      }
      case 'paios.phase0.demo.handoff.completed':
        this.#suppressedDeviceId = text(payload.from_device_id, 64);
        this.#activeDeviceId = text(payload.active_device_id, 64);
        this.#activeDeviceLeaseVersion = number(payload.active_device_lease_version);
        break;
      case 'paios.phase0.demo.connection.reconnected':
        if (originDevice) originDevice.status = 'reconnecting';
        break;
      case 'paios.phase0.demo.session.ended':
        this.#state = 'ended';
        for (const device of this.#devices.values()) device.status = 'stopped';
        break;
      case 'paios.phase0.demo.session.cleanup.completed':
        this.#state = 'cleaned';
        for (const device of this.#devices.values()) device.status = 'stopped';
        break;
    }
    return { duplicate: false, snapshot: this.snapshot() };
  }

  snapshot(): DemoSessionProjection {
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      ...(this.#activeDeviceId === undefined ? {} : { activeDeviceId: this.#activeDeviceId }),
      ...(this.#activeDeviceLeaseVersion === undefined ? {} : { activeDeviceLeaseVersion: this.#activeDeviceLeaseVersion }),
      ...(this.#suppressedDeviceId === undefined ? {} : { suppressedDeviceId: this.#suppressedDeviceId }),
      ...(this.#latestModelResult === undefined ? {} : { latestModelResult: this.#latestModelResult }),
      ...(this.#latestModelLatencyMs === undefined ? {} : { latestModelLatencyMs: this.#latestModelLatencyMs }),
      devices: [...this.#devices.values()].map((device): DemoDeviceProjection => ({
        deviceId: device.deviceId,
        deviceClass: device.deviceClass,
        status: device.status,
        ...(device.lastEventType === undefined ? {} : { lastEventType: device.lastEventType }),
        ...(device.lastEventAt === undefined ? {} : { lastEventAt: device.lastEventAt }),
        ...(device.voiceState === undefined ? {} : { voiceState: device.voiceState }),
        ...(device.locationActivity === undefined ? {} : { locationActivity: device.locationActivity }),
        ...(device.locationAccuracyBand === undefined ? {} : { locationAccuracyBand: device.locationAccuracyBand }),
        ...(device.shareKind === undefined ? {} : { shareKind: device.shareKind }),
        ...(device.workoutMetric === undefined ? {} : { workoutMetric: device.workoutMetric }),
        ...(device.confirmation === undefined ? {} : { confirmation: device.confirmation }),
        ...(device.frameReference === undefined ? {} : { frameReference: device.frameReference }),
        ...(device.modelResult === undefined ? {} : { modelResult: device.modelResult }),
        ...(device.modelLatencyMs === undefined ? {} : { modelLatencyMs: device.modelLatencyMs }),
        ...(device.renderReceipt === undefined ? {} : { renderReceipt: device.renderReceipt }),
        ...(device.telemetry === undefined ? {} : { telemetry: [...device.telemetry] }),
      })),
      acceptedEventCount: this.#fingerprints.size,
    };
  }
}
