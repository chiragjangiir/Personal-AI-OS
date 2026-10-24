import type { RealtimeSessionService } from "./realtime-session-service.ts";
import { snapshotOpaqueOwnerValue } from "./types.ts";
import type {
  BootstrapRequest,
  BootstrapResult,
  ConnectedRefreshRequest,
  OpaqueCanonicalRef,
  RefreshResult,
  StopRequest,
  TerminalReceipt,
} from "./types.ts";

/**
 * T01/Public consume this projection as an opaque typed seam.  It defines no
 * HTTP, OpenAPI, event, or canonical wire schema.
 */
export interface PublicBindingProjection {
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly transportSessionAlias: unknown;
  readonly roomAlias: unknown;
  readonly deviceAlias: unknown;
  readonly provider: unknown;
  readonly connectionId: string;
}

export interface PublicBootstrapProjection {
  readonly operation: "bootstrap";
  readonly binding: PublicBindingProjection;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
  readonly receipt: TerminalReceipt;
}

export interface PublicRefreshProjection {
  readonly operation: "connected_credential_refresh";
  readonly binding: PublicBindingProjection;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
  readonly receipt: TerminalReceipt;
}

export interface PublicControlProjectionPort {
  bootstrap(request: BootstrapRequest): Promise<PublicBootstrapProjection>;
  connectedRefresh(request: ConnectedRefreshRequest): Promise<PublicRefreshProjection>;
  fullyDisconnectedRefresh(request: BootstrapRequest): Promise<PublicBootstrapProjection>;
  mediaStop(request: StopRequest): Promise<TerminalReceipt>;
  endContinuity(request: StopRequest): Promise<TerminalReceipt>;
}

export class PublicControlProjection implements PublicControlProjectionPort {
  private readonly service: RealtimeSessionService;

  public constructor(service: RealtimeSessionService) {
    this.service = service;
  }

  public async bootstrap(request: BootstrapRequest): Promise<PublicBootstrapProjection> {
    const result = await this.service.bootstrap({ ...request, mode: "initial" });
    return projectBootstrap(result);
  }

  public async connectedRefresh(request: ConnectedRefreshRequest): Promise<PublicRefreshProjection> {
    return projectRefresh(await this.service.refresh(request));
  }

  public async fullyDisconnectedRefresh(request: BootstrapRequest): Promise<PublicBootstrapProjection> {
    const result = await this.service.bootstrap({ ...request, mode: "fully_disconnected" });
    return projectBootstrap(result);
  }

  public async mediaStop(request: StopRequest): Promise<TerminalReceipt> {
    return this.service.stop({ ...request, operation: "media_stop" });
  }

  public async endContinuity(request: StopRequest): Promise<TerminalReceipt> {
    return this.service.stop({ ...request, operation: "end_continuity" });
  }
}

export function projectBootstrap(result: BootstrapResult): PublicBootstrapProjection {
  assertBinding(result.binding);
  return Object.freeze({
    operation: "bootstrap",
    binding: projectBinding(result.binding),
    continuityExpiresAt: result.continuityExpiresAt,
    leaseExpiresAt: result.leaseExpiresAt,
    receipt: snapshotReceipt(result.receipt),
  });
}

export function projectRefresh(result: RefreshResult): PublicRefreshProjection {
  assertBinding(result.binding);
  return Object.freeze({
    operation: result.operation,
    binding: projectBinding(result.binding),
    continuityExpiresAt: result.continuityExpiresAt,
    leaseExpiresAt: result.leaseExpiresAt,
    receipt: snapshotReceipt(result.receipt),
  });
}

function projectBinding(binding: BootstrapResult["binding"]): PublicBindingProjection {
  return Object.freeze({
    realtimeSessionRef: snapshotOpaqueOwnerValue(binding.realtimeSessionRef),
    deviceLeaseRef: snapshotOpaqueOwnerValue(binding.deviceLeaseRef),
    continuityId: binding.continuityId,
    connectionEpoch: binding.connectionEpoch,
    transportSessionAlias: snapshotOpaqueOwnerValue(binding.transportSessionAlias),
    roomAlias: snapshotOpaqueOwnerValue(binding.roomAlias),
    deviceAlias: snapshotOpaqueOwnerValue(binding.deviceAlias),
    provider: snapshotOpaqueOwnerValue(binding.provider),
    connectionId: binding.connectionId,
  });
}

function snapshotReceipt(receipt: TerminalReceipt): TerminalReceipt {
  const snapshot = snapshotOpaqueOwnerValue(receipt);
  if (typeof snapshot === "string" || Array.isArray(snapshot)) {
    throw new Error("PUBLIC_RECEIPT_INVALID");
  }
  return Object.freeze(snapshot as unknown as TerminalReceipt);
}

function assertBinding(binding: BootstrapResult["binding"]): void {
  if (binding.realtimeSessionRef === undefined || binding.deviceLeaseRef === undefined ||
      binding.continuityId.trim() === "" ||
      binding.connectionEpoch.trim() === "" || binding.connectionId.trim() === "") {
    throw new Error("PUBLIC_BINDING_INCOMPLETE");
  }
}
