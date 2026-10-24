import type { CurrentBindingLookup, RealtimeCurrentBindingProjection } from "./types.ts";
import { PublicControlProjection, type PublicControlProjectionPort } from "./public-control-projection.ts";
import { RealtimeSessionService } from "./realtime-session-service.ts";
import {
  createProductionOwnerPorts,
  type ProductionOwnerPorts,
  type ProductionOwnerPortsInput,
  type ProductionReadiness,
} from "./production-owner-ports.ts";

export interface ProductionAuthorityFactoryOptions extends ProductionOwnerPortsInput {}

export interface ProductionAuthorityFactoryResult {
  /** Guarded T11B service; every method fails closed while an owner is not ready. */
  readonly service: RealtimeSessionService;
  /** Public projection over the same T11B service and owner port set. */
  readonly projection: PublicControlProjection;
  /** Alias used by Gateway composition code. */
  readonly controller: PublicControlProjectionPort;
  /** Authoritative current-binding read, never resolved from a transport alias. */
  readonly readCurrentBinding: (
    lookup: CurrentBindingLookup,
  ) => Promise<RealtimeCurrentBindingProjection | undefined>;
  readonly ports: ProductionOwnerPorts;
  readonly ownerPorts: ProductionOwnerPorts;
  readonly readiness: ProductionReadiness;
  readonly assertReady: () => void;
  readonly close: () => Promise<void>;
}

/**
 * Compose the storage-neutral T11B lifecycle with explicit production owner
 * ports.  This factory does not create a pool, listener, provider credential,
 * canonical reference, or in-process authority store; those remain injected
 * owner responsibilities.
 */
export function createProductionAuthorityFactory(
  options: ProductionAuthorityFactoryOptions,
): ProductionAuthorityFactoryResult {
  const ports = createProductionOwnerPorts(options);
  const service = new RealtimeSessionService(ports);
  const projection = new PublicControlProjection(service);
  const readCurrentBinding = (lookup: CurrentBindingLookup) => {
    ports.assertReady();
    return service.readCurrentBinding(lookup);
  };
  return Object.freeze({
    service,
    projection,
    controller: projection,
    readCurrentBinding,
    ports,
    ownerPorts: ports,
    readiness: ports.readiness,
    assertReady: ports.readiness.assertReady,
    close: ports.close,
  });
}

/** Short alias for callers that name the result by its T11B authority role. */
export const createProductionAuthority = createProductionAuthorityFactory;

