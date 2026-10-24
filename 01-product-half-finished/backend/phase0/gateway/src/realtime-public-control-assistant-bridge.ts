import { DataPacketKind, RoomEvent } from '@livekit/rtc-node';

import type {
  Qwen38ChatRequest,
  Qwen38StreamEvent,
} from './qwen38-provider-adapter.ts';
import type {
  RealtimeBootstrapConnectedInput,
} from './realtime-public-control-runtime.ts';
import type {
  LiveKitCloudParticipantPort,
  LiveKitCloudRoomPort,
} from './livekit-cloud-participant.ts';
import type { RayneoRealtimeAudioSession } from './rayneo-realtime-audio-controller.ts';

export const REALTIME_ASSISTANT_PROMPT_TOPIC = 'paios.assistant.prompt.local.v1' as const;
export const REALTIME_ASSISTANT_RESULT_TOPIC = 'paios.assistant.result.local.v1' as const;
export const REALTIME_ASSISTANT_MAX_PACKET_BYTES = 12_288 as const;
export const REALTIME_ASSISTANT_MAX_PROMPT_BYTES = 8_192 as const;
export const REALTIME_ASSISTANT_MAX_TOKENS = 512 as const;

type AssistantErrorCode = 'MODEL_UNAVAILABLE' | 'MODEL_FAILED' | 'BUSY';

export interface RealtimePublicControlAssistantProvider {
  readonly stream: (
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
  ) => AsyncIterable<Qwen38StreamEvent>;
  readonly complete?: (
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
  ) => Promise<Readonly<{ readonly text: string }>>;
  readonly close?: () => void | Promise<void>;
}

/**
 * Optional same-room media seam.  The factory receives the already connected
 * Public room and the exact provider instance used by typed DataReceived; it
 * must not connect another LiveKit participant or construct a second model
 * adapter behind the bridge.
 */
export interface RealtimePublicControlAssistantSession {
  readonly streamTypedReply: (
    input: Readonly<{ readonly promptId: string; readonly text: string }>,
    signal: AbortSignal,
  ) => AsyncIterable<Qwen38StreamEvent>;
  readonly completeConversationTurn?: (inputId: string, assistantText: string) => Promise<void>;
  readonly markIndeterminateConversationTurn?: (inputId: string, assistantText: string) => Promise<void>;
  readonly releaseConversationTurn?: (inputId: string) => Promise<void>;
  readonly audioSession?: RayneoRealtimeAudioSession;
  readonly cleanup: () => Promise<void>;
}

export interface RealtimePublicControlAssistantAudioFactory {
  readonly create: (
    input: RealtimeBootstrapConnectedInput,
    room: LiveKitCloudRoomPort,
    provider: RealtimePublicControlAssistantProvider,
  ) => Promise<RealtimePublicControlAssistantSession>;
}

export interface RealtimePublicControlAssistantBridgeOptions {
  readonly participant: LiveKitCloudParticipantPort;
  readonly provider: RealtimePublicControlAssistantProvider;
  readonly audio?: RealtimePublicControlAssistantAudioFactory;
  readonly recordUserAction?: (input: Readonly<{
    readonly action: 'button_submit' | 'explicit_voice_command';
    readonly activityId: string;
  }>) => Promise<void>;
}

export interface RealtimePublicControlAssistantBridge {
  readonly onBootstrapConnected: (input: RealtimeBootstrapConnectedInput) => Promise<void>;
  readonly close: () => Promise<void>;
}

type Binding = Readonly<{
  readonly key: string;
  readonly credentialRoom: string;
  readonly credentialIdentity: string;
}>;

type ActiveRequest = Readonly<{
  readonly binding: Binding;
  readonly generation: number;
  readonly room: LiveKitCloudRoomPort;
  readonly promptId: string;
  readonly abort: AbortController;
  readonly telemetry: RequestTelemetry;
}>;

type DataListener = (...args: readonly unknown[]) => void;

type AssistantTerminalStatus = 'final' | 'error' | 'cancelled' | 'busy';

interface RequestTelemetry {
  readonly startedAt: number;
  firstDeltaMs?: number;
  deltaCount: number;
  terminalReported: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function fail(code: string): never {
  throw new Error(code);
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && typeof (error as Error & { readonly code?: unknown }).code === 'string') {
    return (error as Error & { readonly code: string }).code;
  }
  return undefined;
}

function modelErrorCode(error: unknown): AssistantErrorCode {
  const code = errorCode(error) ?? (error instanceof Error ? error.message : '');
  if (code === 'QWEN38_PROVIDER_BUSY' || code === 'PROVIDER_BUSY') return 'BUSY';
  if (code.includes('NOT_READY') || code.includes('UNAVAILABLE') || code.includes('MODEL_UNAVAILABLE')) {
    return 'MODEL_UNAVAILABLE';
  }
  return 'MODEL_FAILED';
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof DOMException && error.name === 'AbortError';
}

function asBinding(input: RealtimeBootstrapConnectedInput): Binding {
  const current = input.currentBinding;
  const credentialRoom = current.credentialRoom;
  const credentialIdentity = current.credentialIdentity;
  const continuityId = current.continuityId;
  const connectionEpoch = current.connectionEpoch;
  if (typeof credentialRoom !== 'string' || credentialRoom.length === 0 ||
      typeof credentialIdentity !== 'string' || credentialIdentity.length === 0 ||
      typeof continuityId !== 'string' || continuityId.length === 0 ||
      typeof connectionEpoch !== 'string' || connectionEpoch.length === 0 ||
      current.realtimeSessionRef === undefined || current.deviceLeaseRef === undefined) {
    fail('ASSISTANT_BINDING_INVALID');
  }
  let refs: string;
  try {
    refs = JSON.stringify({
      realtimeSessionRef: current.realtimeSessionRef,
      deviceLeaseRef: current.deviceLeaseRef,
    });
  } catch {
    fail('ASSISTANT_BINDING_INVALID');
  }
  return Object.freeze({
    credentialRoom,
    credentialIdentity,
    key: `${credentialRoom}\u0000${credentialIdentity}\u0000${continuityId}\u0000${connectionEpoch}\u0000${refs}`,
  });
}

function parsePrompt(payload: unknown): Readonly<{ promptId: string; text: string }> | undefined {
  if (!(payload instanceof Uint8Array) || payload.byteLength > REALTIME_ASSISTANT_MAX_PACKET_BYTES) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(payload)); } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('prompt_id') || !keys.includes('text')) return undefined;
  const promptId = value.prompt_id;
  const text = value.text;
  if (typeof promptId !== 'string' || promptId.length > 64 || !UUID.test(promptId) ||
      typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0 || encoder.encode(trimmed).byteLength > REALTIME_ASSISTANT_MAX_PROMPT_BYTES) {
    return undefined;
  }
  try {
    if (encoder.encode(JSON.stringify(value)).byteLength > REALTIME_ASSISTANT_MAX_PACKET_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return Object.freeze({ promptId, text: trimmed });
}

function jsonBytes(value: unknown): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(value));
  if (encoded.byteLength > REALTIME_ASSISTANT_MAX_PACKET_BYTES) throw new Error('ASSISTANT_RESULT_TOO_LARGE');
  return encoded;
}

function metricLine(kind: 'start' | 'terminal', fields: Readonly<Record<string, string | number>>): void {
  const payload = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`).join(' ');
  try { process.stderr.write(`PAIOS_ASSISTANT_${kind} ${payload}\n`); } catch { /* diagnostics never affect delivery */ }
}

export function createRealtimePublicControlAssistantBridge(
  options: RealtimePublicControlAssistantBridgeOptions,
): RealtimePublicControlAssistantBridge {
  if (options.participant === null || typeof options.participant !== 'object' ||
      typeof options.provider?.stream !== 'function' ||
      options.audio !== undefined && typeof options.audio.create !== 'function') {
    fail('ASSISTANT_BRIDGE_OPTIONS_INVALID');
  }
  let closed = false;
  let generation = 0;
  let currentBinding: Binding | undefined;
  let currentRoom: LiveKitCloudRoomPort | undefined;
  let dataListener: DataListener | undefined;
  let disconnectListener: DataListener | undefined;
  let activeRequest: ActiveRequest | undefined;
  let assistantSession: RealtimePublicControlAssistantSession | undefined;
  let sessionCleanupFlight: Promise<void> | undefined;
  let currentDataEnabled = false;
  let currentAudioEnabled = false;
  let currentVideoEnabled = false;
  let closeFlight: Promise<void> | undefined;
  const seenPromptIds = new Set<string>();
  let startCount = 0;
  let terminalCount = 0;

  const reportTerminal = (
    request: ActiveRequest,
    status: Exclude<AssistantTerminalStatus, 'busy'>,
    error?: AssistantErrorCode,
  ): void => {
    if (request.telemetry.terminalReported) return;
    request.telemetry.terminalReported = true;
    terminalCount += 1;
    metricLine('terminal', {
      prompt_id: request.promptId,
      start_count: startCount,
      terminal_count: terminalCount,
      elapsed_ms: Math.max(0, Date.now() - request.telemetry.startedAt),
      first_delta_ms: request.telemetry.firstDeltaMs ?? -1,
      delta_count: request.telemetry.deltaCount,
      status,
      ...(error === undefined ? {} : { error_code: error }),
    });
  };

  const reportBusy = (promptId: string): void => {
    terminalCount += 1;
    metricLine('terminal', {
      prompt_id: promptId,
      start_count: startCount,
      terminal_count: terminalCount,
      elapsed_ms: 0,
      first_delta_ms: -1,
      delta_count: 0,
      status: 'busy',
    });
  };

  const isCurrent = (binding: Binding, room: LiveKitCloudRoomPort, expectedGeneration: number): boolean =>
    !closed && currentBinding?.key === binding.key && currentRoom === room && generation === expectedGeneration;

  const detach = (): void => {
    generation += 1;
    if (activeRequest !== undefined) reportTerminal(activeRequest, 'cancelled');
    activeRequest?.abort.abort();
    activeRequest = undefined;
    const currentSession = assistantSession;
    assistantSession = undefined;
    if (currentSession !== undefined) {
      sessionCleanupFlight ??= currentSession.cleanup().then(() => undefined, () => undefined);
    }
    const room = currentRoom;
    if (room !== undefined) {
      if (dataListener !== undefined) {
        try {
          if (typeof room.off === 'function') room.off(RoomEvent.DataReceived, dataListener);
          else room.removeListener?.(RoomEvent.DataReceived, dataListener);
        } catch { /* cleanup is best effort; generation still fences the handler */ }
      }
      if (disconnectListener !== undefined) {
        try {
          if (typeof room.off === 'function') room.off(RoomEvent.Disconnected, disconnectListener);
          else room.removeListener?.(RoomEvent.Disconnected, disconnectListener);
        } catch { /* cleanup is best effort; generation still fences the handler */ }
      }
    }
    dataListener = undefined;
    disconnectListener = undefined;
    currentRoom = undefined;
    currentBinding = undefined;
    currentDataEnabled = false;
    currentAudioEnabled = false;
    currentVideoEnabled = false;
    seenPromptIds.clear();
  };

  const publish = async (
    binding: Binding,
    room: LiveKitCloudRoomPort,
    expectedGeneration: number,
    value: Readonly<Record<string, unknown>>,
  ): Promise<boolean> => {
    if (!isCurrent(binding, room, expectedGeneration)) return false;
    const local = room.localParticipant;
    if (local === undefined || typeof local.publishData !== 'function') {
      throw new Error('ASSISTANT_LOCAL_PARTICIPANT_PUBLISH_UNAVAILABLE');
    }
    await local.publishData(jsonBytes(value), {
      reliable: true,
      destination_identities: [binding.credentialIdentity],
      topic: REALTIME_ASSISTANT_RESULT_TOPIC,
    });
    return isCurrent(binding, room, expectedGeneration);
  };

  const sendError = async (
    request: ActiveRequest | Readonly<{ binding: Binding; generation: number; room: LiveKitCloudRoomPort; promptId: string }>,
    code: AssistantErrorCode,
    sequence = 1,
  ): Promise<void> => {
    try {
      await publish(request.binding, request.room, request.generation, {
        stream_id: request.promptId,
        sequence,
        text: '',
        is_final: true,
        error_code: code,
      });
    } catch { /* transport failure cannot produce a second useful result */ }
  };

  const runPrompt = async (
    request: ActiveRequest,
    text: string,
  ): Promise<void> => {
    let sequence = 1;
    let accumulated = '';
    let finalSent = false;
    let published = false;
    try {
      if (assistantSession === undefined) throw new Error('ASSISTANT_TYPED_SESSION_UNAVAILABLE');
      await options.recordUserAction?.({ action: 'button_submit', activityId: request.promptId });
      for await (const event of assistantSession.streamTypedReply({
        promptId: request.promptId,
        text,
      }, request.abort.signal)) {
        if (!isCurrent(request.binding, request.room, request.generation) || request.abort.signal.aborted) return;
        if (event.kind === 'delta') {
          if (typeof event.text !== 'string' || event.text.length === 0) throw new Error('MODEL_FAILED');
          request.telemetry.firstDeltaMs ??= Math.max(0, Date.now() - request.telemetry.startedAt);
          request.telemetry.deltaCount += 1;
          accumulated += event.text;
          const sent = await publish(request.binding, request.room, request.generation, {
            stream_id: request.promptId,
            sequence,
            text: accumulated,
            is_final: false,
          });
          if (!sent) return;
          published = true;
          sequence += 1;
        } else if (event.kind === 'final') {
          if (typeof event.text !== 'string' || event.text.length === 0) throw new Error('MODEL_FAILED');
          accumulated = event.text;
          const sent = await publish(request.binding, request.room, request.generation, {
            stream_id: request.promptId,
            sequence,
            text: accumulated,
            is_final: true,
          });
          if (!sent) return;
          published = true;
          await assistantSession.completeConversationTurn?.(request.promptId, accumulated);
          finalSent = true;
          break;
        } else {
          throw new Error('MODEL_FAILED');
        }
      }
      if (!finalSent) throw new Error('MODEL_FAILED');
      reportTerminal(request, 'final');
    } catch (error) {
      if (!isCurrent(request.binding, request.room, request.generation) || isAbort(error, request.abort.signal)) return;
      request.abort.abort();
      if (published) {
        await assistantSession?.markIndeterminateConversationTurn?.(
          request.promptId, accumulated || '模型输出未完成。',
        ).catch(() => undefined);
      } else {
        await assistantSession?.releaseConversationTurn?.(request.promptId).catch(() => undefined);
      }
      const code = modelErrorCode(error);
      await sendError(request, code, sequence);
      reportTerminal(request, 'error', code);
    } finally {
      if (activeRequest === request) activeRequest = undefined;
    }
  };

  const onData = (...args: readonly unknown[]): void => {
    const payload = args[0];
    const participant = args[1];
    const kind = args[2];
    const topic = args[3];
    if (topic !== REALTIME_ASSISTANT_PROMPT_TOPIC || kind !== DataPacketKind.KIND_RELIABLE ||
        participant === null || typeof participant !== 'object' ||
        (participant as { readonly identity?: unknown }).identity !== currentBinding?.credentialIdentity ||
        currentBinding === undefined || currentRoom === undefined) return;
    const prompt = parsePrompt(payload);
    if (prompt === undefined || seenPromptIds.has(prompt.promptId)) return;
    seenPromptIds.add(prompt.promptId);
    const binding = currentBinding;
    const room = currentRoom;
    const expectedGeneration = generation;
    if (activeRequest !== undefined) {
      void sendError({ binding, room, generation: expectedGeneration, promptId: prompt.promptId }, 'BUSY');
      reportBusy(prompt.promptId);
      return;
    }
    startCount += 1;
    const telemetry: RequestTelemetry = {
      startedAt: Date.now(),
      deltaCount: 0,
      terminalReported: false,
    };
    metricLine('start', {
      prompt_id: prompt.promptId,
      start_count: startCount,
      terminal_count: terminalCount,
      elapsed_ms: 0,
      first_delta_ms: -1,
      delta_count: 0,
      status: 'streaming',
    });
    const request: ActiveRequest = Object.freeze({
      binding,
      generation: expectedGeneration,
      room,
      promptId: prompt.promptId,
      abort: new AbortController(),
      telemetry,
    });
    activeRequest = request;
    void runPrompt(request, prompt.text);
  };

  const onDisconnected = (): void => { detach(); };

  const onBootstrapConnected = async (input: RealtimeBootstrapConnectedInput): Promise<void> => {
    if (closed) fail('ASSISTANT_BRIDGE_CLOSED');
    const dataEnabled = input.enabledMedia.data === true;
    const audioEnabled = input.enabledMedia.audio === true;
    const videoEnabled = input.enabledMedia.video === true;
    if (!dataEnabled && !audioEnabled && !videoEnabled) {
      detach();
      return;
    }
    if ((audioEnabled || videoEnabled) && options.audio === undefined) fail('ASSISTANT_AUDIO_FACTORY_REQUIRED');
    const binding = asBinding(input);
    const room = options.participant.roomPort;
    if (room === undefined || typeof room.on !== 'function' || room.localParticipant === undefined ||
        room.isConnected === false || dataEnabled && typeof room.localParticipant.publishData !== 'function') {
      fail('ASSISTANT_ROOM_PORT_UNAVAILABLE');
    }
    if (currentBinding?.key === binding.key && currentRoom === room &&
        currentDataEnabled === dataEnabled && currentAudioEnabled === audioEnabled &&
        currentVideoEnabled === videoEnabled) return;
    detach();
    currentBinding = binding;
    currentRoom = room;
    dataListener = dataEnabled ? onData : undefined;
    disconnectListener = onDisconnected;
    currentDataEnabled = dataEnabled;
    currentAudioEnabled = audioEnabled;
    currentVideoEnabled = videoEnabled;
    try {
      if (dataListener !== undefined) room.on(RoomEvent.DataReceived, dataListener);
      room.on(RoomEvent.Disconnected, disconnectListener);
      if (options.audio === undefined) fail('ASSISTANT_TYPED_SESSION_FACTORY_REQUIRED');
      await sessionCleanupFlight;
      sessionCleanupFlight = undefined;
      assistantSession = await options.audio.create(input, room, options.provider);
      if (audioEnabled && assistantSession.audioSession === undefined) fail('ASSISTANT_AUDIO_SESSION_REQUIRED');
    } catch (error) {
      detach();
      throw error;
    }
  };

  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    detach();
    closeFlight = Promise.resolve(sessionCleanupFlight)
      .then(() => options.provider.close?.())
      .then(() => undefined);
    return closeFlight;
  };

  return Object.freeze({ onBootstrapConnected, close });
}
