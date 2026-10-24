import { assertLeaseUsable } from '../../../services/realtime-core/src/device-lease-state-machine.ts';
import {
  assertCanonicalTimestamp, snapshotOpaqueOwnerValue,
  type CurrentBindingLookup, type RealtimeCurrentBindingProjection, type OpaqueCanonicalRef,
} from '../../../services/realtime-core/src/types.ts';
import type { OpaqueEqualityPort } from '../../../services/realtime-core/src/ports.ts';
import type { CredentialFencePort, CredentialFenceTuple, CredentialFenceAdmissionClient } from '../../../services/platform-data/src/realtime-credential-fence.ts';

export type SourceMediaModality = 'audio' | 'video' | 'data';

/** Trusted capture binding. Never obtain this identity from an untrusted A payload. */
export interface SourceMediaCaptureBinding {
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: CredentialFenceTuple['deviceLeaseRef'];
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly purpose: string;
}

/** Short-lived transport issuance evidence; deliberately not a media grant or L5 session. */
export interface IssuedTransportCredential {
  readonly credentialExpiresAt: string;
  readonly credentialGeneration: string;
}

export interface SourceMediaPermissionSnapshot {
  readonly schema: 'paios.source-media-permission.v1';
  readonly binding: SourceMediaCaptureBinding;
  readonly credentialFenceTuple: CredentialFenceTuple;
  readonly sessionRevision: string;
  readonly authorizedMediaUntil: string;
  readonly modalities: readonly SourceMediaModality[];
  readonly checkedAt: string;
}

export interface SourceMediaPermissionPort {
  /** Advisory snapshot; fresh admission must use withPermission to serialize against Stop. */
  readonly read: (binding: SourceMediaCaptureBinding) => Promise<SourceMediaPermissionSnapshot>;
  /** Commit a bounded capture admission before calling consume outside the database transaction.
   * Stop prevents subsequent admissions. Already admitted original bytes may finish durable archival.
   * The snapshot is limited to this callback, not a reusable capture grant or durable receipt.
   * The existing archive owns idempotency; the existing media owner owns draining and closing.
   */
  readonly withPermission: <T>(binding: SourceMediaCaptureBinding, modality: SourceMediaModality,
    consume: (permission: SourceMediaPermissionSnapshot) => Promise<T>,
    inspect?: (client: CredentialFenceAdmissionClient | undefined, permission: SourceMediaPermissionSnapshot) => Promise<void>) => Promise<T>;
}

export class SourceMediaPermissionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SourceMediaPermissionError'; this.code = code; }
}

export function createSourceMediaPermission(options: {
  readonly readCurrentBinding: (lookup: CurrentBindingLookup) => Promise<RealtimeCurrentBindingProjection | undefined>;
  readonly readCurrentBindingInAdmission?: (client: CredentialFenceAdmissionClient, lookup: CurrentBindingLookup) => Promise<RealtimeCurrentBindingProjection | undefined>;
  readonly equality: OpaqueEqualityPort;
  readonly credentialFence: Pick<CredentialFencePort, 'verify' | 'withAdmission'>;
  readonly now: () => string;
}): SourceMediaPermissionPort {
  const fail = (code: string): never => { throw new SourceMediaPermissionError(code); };
  const project = async (expected: SourceMediaCaptureBinding, client?: CredentialFenceAdmissionClient): Promise<SourceMediaPermissionSnapshot> => {
    if (expected.realtimeSessionRef === undefined) fail('MEDIA_SESSION_REQUIRED');
    const lookup = { realtimeSessionRef: expected.realtimeSessionRef! };
    if (client && !options.readCurrentBindingInAdmission) fail('MEDIA_ADMISSION_READER_REQUIRED');
    const current = client ? await options.readCurrentBindingInAdmission!(client, lookup)
      : await options.readCurrentBinding(lookup);
    if (current === undefined) fail('MEDIA_CURRENT_BINDING_MISSING');
    const { session, lease } = current!;
    const same = (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => options.equality.same(left, right);
    if (!same(session.realtimeSessionRef, expected.realtimeSessionRef) ||
        !same(session.activeDeviceLeaseRef, expected.deviceLeaseRef) ||
        !same(lease.deviceLeaseRef, expected.deviceLeaseRef) ||
        !same(lease.realtimeSessionRef, session.realtimeSessionRef) ||
        lease.userId !== session.userId || lease.continuityId !== session.continuityId ||
        lease.deviceId !== session.activeDeviceId || session.userId !== expected.userId ||
        session.activeDeviceId !== expected.deviceId || lease.purpose !== expected.purpose ||
        session.continuityId !== expected.continuityId || session.connectionEpoch !== expected.connectionEpoch ||
        !same(session.binding.realtimeSessionRef, session.realtimeSessionRef) ||
        !same(session.binding.deviceLeaseRef, lease.deviceLeaseRef) ||
        session.binding.continuityId !== session.continuityId ||
        session.binding.deviceId !== session.activeDeviceId ||
        session.binding.connectionEpoch !== session.connectionEpoch) fail('MEDIA_CURRENT_BINDING_MISMATCH');
    if (session.state !== 'active' || session.continuityState !== 'active' ||
        session.binding.state !== 'connected') fail('MEDIA_CAPTURE_NOT_CONNECTED');
    const checkedAt = assertCanonicalTimestamp(options.now());
    assertLeaseUsable({ lease, now: checkedAt, expectedLeaseVersion: lease.leaseVersion,
      expectedDeviceId: expected.deviceId, expectedSessionRef: session.realtimeSessionRef,
      sameRef: same });
    const continuityAt = Date.parse(assertCanonicalTimestamp(session.continuityExpiresAt));
    if (Date.parse(checkedAt) >= continuityAt) fail('MEDIA_CONTINUITY_EXPIRED');
    const authorizedMediaUntil = new Date(Math.min(continuityAt, Date.parse(lease.expiresAt))).toISOString();
    // The explicit modality capability is the same source consumed by cloud media grant projection.
    // A generic realtime.media capability does not silently grant microphone or camera access.
    const modalities = (['audio', 'video', 'data'] as const).filter((media) => lease.capabilities.includes(media));
    const tuple = snapshotOpaqueOwnerValue({ realtimeSessionRef: session.realtimeSessionRef,
      deviceLeaseRef: lease.deviceLeaseRef, continuityId: session.continuityId,
      connectionEpoch: session.connectionEpoch, credentialGeneration: lease.leaseVersion }) as CredentialFenceTuple;
    return Object.freeze({ schema: 'paios.source-media-permission.v1',
      binding: snapshotOpaqueOwnerValue(expected) as unknown as SourceMediaCaptureBinding,
      credentialFenceTuple: tuple, sessionRevision: session.revision, authorizedMediaUntil,
      modalities: Object.freeze(modalities), checkedAt });
  };
  return Object.freeze({
    read: async (binding: SourceMediaCaptureBinding) => {
      const permission = await project(binding);
      const fence = await options.credentialFence.verify(permission.credentialFenceTuple);
      if (fence.active) fail('MEDIA_CREDENTIAL_REVOKED');
      return permission;
    },
    withPermission: async <T>(binding: SourceMediaCaptureBinding, modality: SourceMediaModality,
      consume: (permission: SourceMediaPermissionSnapshot) => Promise<T>,
      inspect?: (client: CredentialFenceAdmissionClient | undefined, permission: SourceMediaPermissionSnapshot) => Promise<void>): Promise<T> => {
      const initial = await project(binding);
      const committed = await options.credentialFence.withAdmission(initial.credentialFenceTuple, async (client) => {
        // Read again under the existing fence lock, so a changed lease cannot use the old tuple.
        const permission = await project(binding, client);
        if (!options.equality.same(initial.credentialFenceTuple as unknown as OpaqueCanonicalRef,
            permission.credentialFenceTuple as unknown as OpaqueCanonicalRef)) {
          fail('MEDIA_PERMISSION_CHANGED');
        }
        if (!permission.modalities.includes(modality)) fail('MEDIA_MODALITY_NOT_AUTHORIZED');
        await inspect?.(client,permission);
        return permission;
      });
      // A failed COMMIT or release never reaches original-byte publication.
      return consume(committed);
    },
  });
}
