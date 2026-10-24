import {
  LocalVideoTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  VideoStream,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import { deflateSync } from 'node:zlib';

const VIDEO_WIDTH = 64;
const VIDEO_HEIGHT = 48;
const VIDEO_INTERVAL_MS = 500;
const VIDEO_SAMPLE_INTERVAL_MS = 2_000;
const VIDEO_SAMPLE_MAX_EDGE = 640;
const VIDEO_SAMPLE_MAX_BYTES = 2_000_000;
const VIDEO_SAMPLE_RING_SIZE = 8;

export const RAYNEO_REALTIME_VIDEO_DIAGNOSTIC_STAGES = Object.freeze([
  'REMOTE_CAMERA_TRACK_SUBSCRIBED',
  'FRAME_OBSERVED',
  'VIDEO_TRACK_PUBLISHED',
  'VIDEO_STOPPED',
  'VIDEO_BRIDGE_FAILED',
] as const);

export type RayneoRealtimeVideoDiagnosticStage =
  typeof RAYNEO_REALTIME_VIDEO_DIAGNOSTIC_STAGES[number];

export interface RayneoRealtimeVideoBinding {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  /** Public Control observes the borrowed room without issuing a local track. */
  readonly mode?: 'rayneo' | 'public-assistant';
  readonly participantIdentity?: string;
}

export interface RayneoRealtimeVideoBridge {
  readSamples(windowStartMs: number, windowEndMs: number, maxSamples?: number): readonly RayneoRealtimeVideoSample[];
  stop(): Promise<void>;
}

export interface RayneoRealtimeVideoSample {
  readonly observedAtMs: number;
  readonly mimeType: 'image/png';
  readonly width: number;
  readonly height: number;
  /** Caller-owned copy. The caller must clear it after request serialization. */
  readonly bytes: Uint8Array;
}

export interface RayneoRealtimeEncodedVideoFrame {
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export interface RayneoRealtimeVideoPublication {
  readonly sid: string | undefined;
}

export interface RayneoRealtimeVideoTrack {
  readonly sid: string | undefined;
  close(closeSource?: boolean): Promise<void>;
}

export interface RayneoRealtimeVideoSource {
  captureFrame(frame: unknown): void;
  close(): Promise<void>;
}

export interface RayneoRealtimeVideoParticipant {
  publishTrack(
    track: RayneoRealtimeVideoTrack,
    options: unknown,
  ): Promise<RayneoRealtimeVideoPublication>;
  unpublishTrack(trackSid: string, stopOnUnpublish?: boolean): Promise<void>;
}

export interface RayneoRealtimeVideoRoom {
  readonly localParticipant?: RayneoRealtimeVideoParticipant;
  readonly remoteParticipants?: ReadonlyMap<string, RemoteParticipant>;
  on(event: string, handler: (...args: never[]) => void): this;
  off?(event: string, handler: (...args: never[]) => void): this;
  removeListener?(event: string, handler: (...args: never[]) => void): this;
}

export interface RayneoRealtimeVideoFrameEvent {
  readonly frame: unknown;
}

export interface RayneoRealtimeVideoRuntime {
  createSource(width: number, height: number): RayneoRealtimeVideoSource;
  createTrack(name: string, source: RayneoRealtimeVideoSource): RayneoRealtimeVideoTrack;
  createFrame(data: Uint8Array, width: number, height: number): unknown;
  createStream(track: RayneoRealtimeVideoTrack): AsyncIterable<RayneoRealtimeVideoFrameEvent>;
  createPublishOptions(): unknown;
  encodeSample(frame: unknown): RayneoRealtimeEncodedVideoFrame;
  releaseFrame(frame: unknown): void;
}

function defaultObserveFixedStage(stage: RayneoRealtimeVideoDiagnosticStage): void {
  console.info(`rayneo_realtime_video_stage=${stage}`);
}

const NATIVE_RUNTIME: RayneoRealtimeVideoRuntime = Object.freeze({
  createSource: (width: number, height: number): RayneoRealtimeVideoSource =>
    new VideoSource(width, height),
  createTrack: (
    name: string,
    source: RayneoRealtimeVideoSource,
  ): RayneoRealtimeVideoTrack =>
    LocalVideoTrack.createVideoTrack(name, source as VideoSource) as unknown as RayneoRealtimeVideoTrack,
  createFrame: (data: Uint8Array, width: number, height: number): unknown =>
    new VideoFrame(data, width, height, VideoBufferType.RGBA),
  createStream: (track: RayneoRealtimeVideoTrack): AsyncIterable<RayneoRealtimeVideoFrameEvent> =>
    new VideoStream(track as unknown as RemoteTrack),
  createPublishOptions: () => {
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_CAMERA;
    return options;
  },
  encodeSample: (frame: unknown): RayneoRealtimeEncodedVideoFrame => {
    if (!(frame instanceof VideoFrame)) throw new Error('RAYNEO_VIDEO_FRAME_INVALID');
    const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
    try {
      return encodeRayneoRealtimeVideoRgbaPng(rgba.data, rgba.width, rgba.height);
    } finally {
      if (rgba !== frame) rgba.data.fill(0);
    }
  },
  releaseFrame: (frame: unknown): void => {
    if (frame instanceof VideoFrame) frame.data.fill(0);
  },
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function resizeRgba(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
): Readonly<{ data: Uint8Array; width: number; height: number }> {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) ||
      sourceWidth <= 0 || sourceHeight <= 0 || sourceWidth > 4_096 || sourceHeight > 4_096 ||
      source.byteLength !== sourceWidth * sourceHeight * 4) {
    throw new Error('RAYNEO_VIDEO_FRAME_INVALID');
  }
  const scale = Math.min(1, VIDEO_SAMPLE_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (width === sourceWidth && height === sourceHeight) {
    return Object.freeze({ data: source.slice(), width, height });
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      data.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return Object.freeze({ data, width, height });
}

export function encodeRayneoRealtimeVideoRgbaPng(
  rgba: Uint8Array,
  width: number,
  height: number,
): RayneoRealtimeEncodedVideoFrame {
  const resized = resizeRgba(rgba, width, height);
  try {
    const rows = new Uint8Array((resized.width * 4 + 1) * resized.height);
    for (let y = 0; y < resized.height; y += 1) {
      const rowOffset = y * (resized.width * 4 + 1);
      rows[rowOffset] = 0;
      rows.set(
        resized.data.subarray(y * resized.width * 4, (y + 1) * resized.width * 4),
        rowOffset + 1,
      );
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(resized.width, 0);
    header.writeUInt32BE(resized.height, 4);
    header[8] = 8;
    header[9] = 6;
    const compressed = deflateSync(rows, { level: 3 });
    rows.fill(0);
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', compressed),
      pngChunk('IEND', new Uint8Array()),
    ]);
    compressed.fill(0);
    if (bytes.byteLength === 0 || bytes.byteLength > VIDEO_SAMPLE_MAX_BYTES) {
      bytes.fill(0);
      throw new Error('RAYNEO_VIDEO_SAMPLE_BYTES_INVALID');
    }
    return Object.freeze({ width: resized.width, height: resized.height, bytes });
  } finally {
    resized.data.fill(0);
  }
}

function syntheticRgbaFrame(): Uint8Array {
  const data = new Uint8Array(VIDEO_WIDTH * VIDEO_HEIGHT * 4);
  for (let y = 0; y < VIDEO_HEIGHT; y += 1) {
    for (let x = 0; x < VIDEO_WIDTH; x += 1) {
      const offset = (y * VIDEO_WIDTH + x) * 4;
      const cyan = ((x >> 3) + (y >> 3)) % 2 === 0;
      data[offset] = cyan ? 0 : 32;
      data[offset + 1] = cyan ? 220 : 32;
      data[offset + 2] = cyan ? 255 : 32;
      data[offset + 3] = 255;
    }
  }
  return data;
}

function isBoundCameraTrack(
  binding: RayneoRealtimeVideoBinding,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
): boolean {
  if (publication.kind !== TrackKind.KIND_VIDEO || publication.source !== TrackSource.SOURCE_CAMERA) return false;
  if (binding.mode === 'public-assistant') {
    return typeof binding.participantIdentity === 'string' &&
      participant.identity === binding.participantIdentity;
  }
  return participant.identity === binding.deviceId &&
    participant.attributes?.device_id === binding.deviceId &&
    participant.attributes?.device_class === 'rayneo' &&
    participant.attributes?.client_instance_id === binding.clientInstanceId &&
    participant.attributes?.session_id === binding.sessionId;
}

export async function createRayneoRealtimeVideoBridge(
  room: RayneoRealtimeVideoRoom,
  binding: RayneoRealtimeVideoBinding,
  observeFixedStage: (stage: RayneoRealtimeVideoDiagnosticStage) => void =
    defaultObserveFixedStage,
  runtime: RayneoRealtimeVideoRuntime = NATIVE_RUNTIME,
  now: () => number = Date.now,
  onSample: (sample: RayneoRealtimeVideoSample) => void | Promise<void> = () => undefined,
): Promise<RayneoRealtimeVideoBridge> {
  const publicAssistant = binding.mode === 'public-assistant';
  if (publicAssistant && (typeof binding.participantIdentity !== 'string' || binding.participantIdentity.length === 0)) {
    throw new Error('RAYNEO_VIDEO_PUBLIC_PARTICIPANT_IDENTITY_INVALID');
  }
  const localParticipant = room.localParticipant;
  if (!publicAssistant && localParticipant === undefined) throw new Error('RAYNEO_VIDEO_LOCAL_PARTICIPANT_MISSING');

  const source = publicAssistant ? undefined : runtime.createSource(VIDEO_WIDTH, VIDEO_HEIGHT);
  let track: RayneoRealtimeVideoTrack | undefined;
  let publicationSid: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeIterator: AsyncIterator<RayneoRealtimeVideoFrameEvent> | undefined;
  let activeCompletion: Promise<void> | undefined;
  let stopped = false;
  let stopCompletion: Promise<void> | undefined;
  let onTrackSubscribed: ((
    remoteTrack: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => void) | undefined;
  let onTrackUnsubscribed: ((
    remoteTrack: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => void) | undefined;
  const seenTracks = new WeakSet<object>();
  const frameData = publicAssistant ? undefined : syntheticRgbaFrame();
  const frame = publicAssistant || frameData === undefined
    ? undefined
    : runtime.createFrame(frameData, VIDEO_WIDTH, VIDEO_HEIGHT);
  let stoppedStageEmitted = false;
  let nextSampleAtMs = 0;
  const samples: Array<{
    observedAtMs: number;
    width: number;
    height: number;
    bytes: Uint8Array;
  }> = [];

  const emit = (stage: RayneoRealtimeVideoDiagnosticStage): void => {
    try { observeFixedStage(stage); } catch { /* diagnostics never alter media */ }
  };

  const cancelRemoteStream = async (): Promise<void> => {
    const iterator = activeIterator;
    if (iterator?.return) {
      try { await iterator.return(); } catch { /* best effort */ }
    }
    activeIterator = undefined;
    const completion = activeCompletion;
    if (completion) await completion.catch(() => undefined);
    activeCompletion = undefined;
  };

  const stopBridge = async (): Promise<void> => {
    if (stopCompletion) return stopCompletion;
    stopCompletion = (async () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await cancelRemoteStream();
      if (publicationSid !== undefined && localParticipant !== undefined) {
        await localParticipant.unpublishTrack(publicationSid, true).catch(() => undefined);
      }
      if (track !== undefined) {
        try {
          await track.close(true);
        } catch {
          await source?.close().catch(() => undefined);
        }
      } else if (source !== undefined) {
        await source.close().catch(() => undefined);
      }
      if (onTrackSubscribed !== undefined) {
        try {
          if (typeof room.off === 'function') room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
          else room.removeListener?.(RoomEvent.TrackSubscribed, onTrackSubscribed);
        } catch { /* cleanup */ }
      }
      if (onTrackUnsubscribed !== undefined) {
        try {
          if (typeof room.off === 'function') room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
          else room.removeListener?.(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
        } catch { /* cleanup */ }
      }
      onTrackSubscribed = undefined;
      onTrackUnsubscribed = undefined;
      frameData?.fill(0);
      for (const sample of samples) sample.bytes.fill(0);
      samples.length = 0;
      if (!stoppedStageEmitted) {
        stoppedStageEmitted = true;
        emit('VIDEO_STOPPED');
      }
    })();
    return stopCompletion;
  };

  const consumeRemoteTrack = (remoteTrack: RemoteTrack): void => {
    if (stopped) return;
    const completion = (async () => {
      const stream = runtime.createStream(remoteTrack as unknown as RayneoRealtimeVideoTrack);
      const iterator = stream[Symbol.asyncIterator]();
      activeIterator = iterator;
      try {
        while (!stopped) {
          const item = await iterator.next();
          if (item.done) break;
          const observedAtMs = now();
          try {
            if (Number.isSafeInteger(observedAtMs) && observedAtMs >= nextSampleAtMs) {
              const encoded = runtime.encodeSample(item.value.frame);
              if (!Number.isSafeInteger(encoded.width) || !Number.isSafeInteger(encoded.height) ||
                  encoded.width <= 0 || encoded.height <= 0 || encoded.width > VIDEO_SAMPLE_MAX_EDGE ||
                  encoded.height > VIDEO_SAMPLE_MAX_EDGE || encoded.bytes.byteLength === 0 ||
                  encoded.bytes.byteLength > VIDEO_SAMPLE_MAX_BYTES) {
                encoded.bytes.fill(0);
                throw new Error('RAYNEO_VIDEO_SAMPLE_INVALID');
              }
              const sample = Object.freeze({
                observedAtMs,
                width: encoded.width,
                height: encoded.height,
                bytes: Uint8Array.from(encoded.bytes),
              });
              samples.push(sample);
              try {
                void Promise.resolve(onSample(Object.freeze({
                  observedAtMs: sample.observedAtMs,
                  mimeType: 'image/png' as const,
                  width: sample.width,
                  height: sample.height,
                  bytes: Uint8Array.from(sample.bytes),
                }))).catch(() => undefined);
              } catch { /* visual delivery never breaks frame sampling */ }
              encoded.bytes.fill(0);
              while (samples.length > VIDEO_SAMPLE_RING_SIZE) samples.shift()!.bytes.fill(0);
              nextSampleAtMs = observedAtMs + VIDEO_SAMPLE_INTERVAL_MS;
              emit('FRAME_OBSERVED');
            }
          } catch {
            if (!stopped) emit('VIDEO_BRIDGE_FAILED');
          } finally {
            try { runtime.releaseFrame(item.value.frame); } catch { /* owned frame best effort */ }
          }
        }
      } catch {
        if (!stopped) emit('VIDEO_BRIDGE_FAILED');
      } finally {
        if (activeIterator === iterator) activeIterator = undefined;
        if (iterator.return) {
          try { await iterator.return(); } catch { /* terminal cleanup */ }
        }
      }
    })();
    activeCompletion = completion;
    void completion.catch(() => undefined);
  };

  onTrackSubscribed = ((
    remoteTrack: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    if (stopped || !isBoundCameraTrack(binding, publication, participant)) return;
    if (seenTracks.has(remoteTrack as object)) return;
    seenTracks.add(remoteTrack as object);
    void (async () => {
      await cancelRemoteStream();
      if (stopped) return;
      emit('REMOTE_CAMERA_TRACK_SUBSCRIBED');
      consumeRemoteTrack(remoteTrack);
    })().catch(() => {
      if (!stopped) emit('VIDEO_BRIDGE_FAILED');
    });
  }) as never;
  onTrackUnsubscribed = ((
    remoteTrack: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    if (isBoundCameraTrack(binding, publication, participant)) {
      void cancelRemoteStream().catch(() => undefined);
      if (activeCompletion === undefined) activeIterator = undefined;
      void remoteTrack;
    }
  }) as never;

  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed as never);
  room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed as never);

  try {
    if (!publicAssistant) {
      track = runtime.createTrack('rayneo-gateway-video', source!);
      const publication = await localParticipant!.publishTrack(track, runtime.createPublishOptions());
      publicationSid = publication.sid ?? track.sid;
      if (publicationSid === undefined) throw new Error('RAYNEO_VIDEO_PUBLICATION_INVALID');
      emit('VIDEO_TRACK_PUBLISHED');
      const capture = (): void => {
        if (stopped) return;
        try {
          source!.captureFrame(frame);
        } catch {
          emit('VIDEO_BRIDGE_FAILED');
          void stopBridge().catch(() => undefined);
        }
      };
      capture();
      timer = setInterval(capture, VIDEO_INTERVAL_MS);
      timer.unref?.();
    }

    const subscribedHandler = onTrackSubscribed as unknown as (
      remoteTrack: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => void;
    for (const participant of room.remoteParticipants?.values() ?? []) {
      for (const publication of participant.trackPublications.values()) {
        if (
          publication.subscribed && publication.track !== undefined &&
          isBoundCameraTrack(binding, publication, participant)
        ) {
          subscribedHandler(publication.track, publication, participant);
        }
      }
    }
    return {
      readSamples: (windowStartMs: number, windowEndMs: number, maxSamples = 2) => {
        if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(windowEndMs) ||
            windowStartMs < 0 || windowEndMs < windowStartMs ||
            !Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 3 || stopped) {
          return Object.freeze([]);
        }
        const candidates = samples.filter((sample) =>
          sample.observedAtMs >= windowStartMs - VIDEO_SAMPLE_INTERVAL_MS &&
          sample.observedAtMs <= windowEndMs + VIDEO_SAMPLE_INTERVAL_MS);
        if (candidates.length === 0) return Object.freeze([]);
        const selected = candidates.length <= maxSamples
          ? candidates
          : maxSamples === 1
            ? [candidates.at(-1)!]
            : Array.from({ length: maxSamples }, (_, index) =>
              candidates[Math.round(index * (candidates.length - 1) / (maxSamples - 1))]!);
        return Object.freeze(selected.map((sample) => Object.freeze({
          observedAtMs: sample.observedAtMs,
          mimeType: 'image/png' as const,
          width: sample.width,
          height: sample.height,
          bytes: Uint8Array.from(sample.bytes),
        })));
      },
      stop: stopBridge,
    };
  } catch (error) {
    emit('VIDEO_BRIDGE_FAILED');
    await stopBridge();
    throw error;
  }
}

export const RAYNEO_REALTIME_VIDEO_FRAME_SIZE = Object.freeze({
  width: VIDEO_WIDTH, height: VIDEO_HEIGHT, intervalMs: VIDEO_INTERVAL_MS,
  sampleIntervalMs: VIDEO_SAMPLE_INTERVAL_MS, sampleMaxEdge: VIDEO_SAMPLE_MAX_EDGE,
  sampleRingSize: VIDEO_SAMPLE_RING_SIZE,
});
