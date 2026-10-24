import { DisconnectReason, RemoteParticipant, Room, type ByteStreamReader } from '@livekit/rtc-node';
import { FfiClient, FfiClientEvent, type FfiEvent } from '../node_modules/@livekit/rtc-node/dist/ffi_client.js';

// rtc-node 0.13.32 still rejects duplicate native joins. Keep this instance-only private
// seam tied to the pinned SDK until its participant lifecycle is fixed upstream.
export function createGatewayRoom(): Room {
  const room = new Room();
  const sdk = room as unknown as {
    ffiHandle?: { handle: bigint; dispose(): void }; processFfiEvent(event: FfiEvent): Promise<void>; onFfiEvent(event: FfiEvent): Promise<void>;
  };
  // connect() subscribes the room to native events every time, but only a client-initiated disconnect
  // unsubscribes it. After a server-side disconnect a reconnect on this room would handle every event
  // twice, and the second release of a data packet's native handle crashes the gateway.
  const connect = room.connect.bind(room);
  room.connect = async (...args: Parameters<Room['connect']>) => {
    FfiClient.instance.off(FfiClientEvent.FfiEvent, sdk.onFfiEvent);
    const previous = sdk.ffiHandle;
    try {
      return await connect(...args);
    } catch (error) {
      // FFI bindings 0.12.68 wait 15 s for ReadyForRoomEvent. A longer event-loop stall still closes the native room
      // and drops the handle that connect() wrapped before sending ready; its catch does not retire it. The wrapper's
      // finalizer would later repeat that drop and throw "trying to drop an invalid handle" with no JS stack, ending
      // the process. Retire it now: dispose() marks the wrapper disposed before the native drop is attempted.
      if (sdk.ffiHandle && sdk.ffiHandle !== previous) retireRoomHandle(sdk.ffiHandle);
      throw error;
    }
  };
  const processEvent = sdk.processFfiEvent.bind(room);
  sdk.processFfiEvent = async (event: FfiEvent) => {
    const envelope = event.message;
    const notification = envelope.case === 'roomEvent' ? envelope.value.message : undefined;
    if (envelope.case === 'roomEvent' && envelope.value.roomHandle === sdk.ffiHandle?.handle &&
        notification?.case === 'participantConnected') {
      const owned = notification.value.info!;
      const existing = room.remoteParticipants.get(owned.info!.identity!);
      if (existing && existing.sid === owned.info!.sid) {
        // Preserve publications and listener references. A different native handle
        // is newly owned by this event and must be released, never the active handle.
        if (owned.handle!.id !== existing.ffi_handle.handle) {
          new RemoteParticipant(owned).ffi_handle.dispose();
        }
        return;
      }
      if (existing) {
        // Run the SDK's teardown notifications before adopting the replacement SID.
        const notify = (kind: string, value: unknown) => processEvent({ ...event, message: {
          case: 'roomEvent', value: { ...envelope.value, message: { case: kind, value } },
        } } as typeof event);
        for (const publication of existing.trackPublications.values()) {
          if (publication.track) await notify('trackUnsubscribed', { participantIdentity: existing.identity, trackSid: publication.sid });
          await notify('trackUnpublished', { participantIdentity: existing.identity, publicationSid: publication.sid });
        }
        await notify('participantDisconnected', { participantIdentity: existing.identity, disconnectReason: DisconnectReason.UNKNOWN_REASON });
      }
    }
    // Other events retain the original SDK behavior.
    await processEvent(event);
  };
  return room;
}

function retireRoomHandle(handle: { dispose(): void }): void {
  try {
    handle.dispose();
  } catch (error) {
    // Expected only when the native side already dropped this handle; any other failure is a real fault.
    if ((error as { code?: unknown }).code !== 'GenericFailure' || (error as Error).message !== 'trying to drop an invalid handle') throw error;
  }
}

export type BoundedByteStreamFailure = 'size' | 'incomplete' | 'inactive' | 'deadline' | 'cancelled';
export interface BoundedByteStreamOptions<T> {
  room: unknown; reader: ByteStreamReader; maxBytes: number; current: () => boolean;
  authorize: (signal: AbortSignal) => Promise<T>; write: (chunk: Uint8Array) => void | Promise<void>;
  error: (kind: BoundedByteStreamFailure) => Error;
}
// rtc-node 0.13.32 iterator.return() still only unlocks: own cancellation and its private queue here.
export function consumeBoundedByteStream<T>(options: BoundedByteStreamOptions<T>): {done: Promise<T>; cancel: (reason?: unknown) => void} {
  const {reader, current, error} = options;
  const sdk = options.room as {byteStreamControllers: Map<string, {header:{totalLength?:bigint};controller: ReadableStreamDefaultController<{content: Uint8Array}>}>};
  const stream = (reader as unknown as {reader: ReadableStream<{content: Uint8Array}>}).reader;
  const transfer = sdk.byteStreamControllers.get(reader.info.streamId)!, cursor = stream.getReader(), abort = new AbortController();
  if(transfer.header.totalLength===0n)reader.info.totalSize=0; // The pinned SDK's truthiness conversion loses an explicit zero.
  const total=reader.info.totalSize;
  let incoming = 0, size = 0, inactivity: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const remove = () => {if (sdk.byteStreamControllers.get(reader.info.streamId) === transfer) sdk.byteStreamControllers.delete(reader.info.streamId);};
  const cancel = (reason: unknown = error('cancelled')) => {remove(); abort.abort(reason);};
  const activity = () => {clearTimeout(inactivity); inactivity = setTimeout(() => cancel(error('inactive')), 5000).unref();};
  const enqueue = transfer.controller.enqueue.bind(transfer.controller);
  transfer.controller.enqueue = chunk => {
    incoming += chunk.content.byteLength;
    if (!Number.isSafeInteger(total) || incoming > total! || incoming > options.maxBytes) {cancel(error('size')); return;}
    if (!current()) {cancel(); return;}
    if (chunk.content.byteLength) activity();
    enqueue(chunk);
  };
  const done = (async () => {
    try {
      if (!current()) throw error('cancelled');
      if (!Number.isSafeInteger(total) || total! < 0 || total! > options.maxBytes) throw error('size');
      const interrupted = new Promise<never>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), {once: true}));
      activity(); deadline = setTimeout(() => cancel(error('deadline')), 30000).unref();
      const source = await Promise.race([options.authorize(abort.signal), interrupted]);
      while (true) {
        abort.signal.throwIfAborted();
        const chunk = await Promise.race([cursor.read(), interrupted]);
        if (!current()) throw error('cancelled');
        if (chunk.done) break;
        size += chunk.value.content.byteLength;
        if (size > total!) throw error('size');
        await Promise.race([Promise.resolve(options.write(chunk.value.content)), interrupted]);
      }
      if (size !== total) throw error('incomplete');
      return source;
    } finally {
      clearTimeout(inactivity); clearTimeout(deadline); remove();
      try {await cursor.cancel(abort.signal.reason);} finally {cursor.releaseLock();}
    }
  })();
  return {done, cancel};
}
