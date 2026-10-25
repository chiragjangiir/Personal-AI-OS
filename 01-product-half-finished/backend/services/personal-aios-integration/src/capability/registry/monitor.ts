import type {CapabilityRegistry} from './registry.ts';
import type {PackageContext} from './interfaces.ts';

/** Connect to P1's admitted-receipt and existing host-health events; no second scheduler. */
export interface PackageMonitorSignals {
  subscribe(handlers: {
    outcome(context: PackageContext, name: string): Promise<unknown>;
    unhealthy(context: PackageContext, name: string, digest: string): Promise<unknown>;
  }): () => void;
}
export function connectPackageMonitor(registry: CapabilityRegistry, signals: PackageMonitorSignals) {
  return signals.subscribe({
    outcome: (context, name) => registry.monitor(context, name),
    unhealthy: (context, name, digest) => registry.rollback(context, name, 'health_failed', digest),
  });
}
