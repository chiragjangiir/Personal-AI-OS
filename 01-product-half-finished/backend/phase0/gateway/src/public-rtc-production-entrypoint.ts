import {
  startGateway,
  type DemoRoamingGatewayHandle,
  type GatewayStartupDependencies,
} from './main.ts';
import type { Phase0SharedSessionOwner } from './phase0-shared-session-owner.ts';
import {
  parseRealtimePublicControlFeatureFlag,
} from './realtime-public-control-controller.ts';
import type { RealtimePublicControlProduction } from './realtime-public-control-production.ts';

export interface PublicRtcProductionEntrypointOptions {
  readonly production: RealtimePublicControlProduction;
  readonly owner?: Phase0SharedSessionOwner;
  readonly environment?: NodeJS.ProcessEnv;
  /** A source/unit seam; the default is the existing main.ts starter. */
  readonly startGateway?: (
    owner?: Phase0SharedSessionOwner,
    dependencies?: GatewayStartupDependencies,
  ) => Promise<void | DemoRoamingGatewayHandle>;
}

/**
 * Start the existing Gateway only. This entrypoint owns no HTTP server,
 * socket, domain, tunnel, route, or Cloud connection of its own.
 */
export async function startPublicRtcProduction(
  options: PublicRtcProductionEntrypointOptions,
): Promise<void | DemoRoamingGatewayHandle> {
  let closeFlight: Promise<void> | undefined;
  const closeProduction = async (): Promise<void> => {
    try {
      closeFlight ??= options.production.close();
      await closeFlight;
    } catch {
      // Preserve the startup/mismatch error; close remains idempotent.
    }
  };
  try {
    const environment = options.environment ?? process.env;
    const enabled = parseRealtimePublicControlFeatureFlag(environment);
    if (enabled !== options.production.enabled) throw new Error('PUBLIC_RTC_FEATURE_FLAG_MISMATCH');
    if (enabled && options.production.controller === undefined) {
      throw new Error('PUBLIC_RTC_CONTROLLER_REQUIRED');
    }
    const starter = options.startGateway ?? startGateway;
    const dependencies: GatewayStartupDependencies = options.production.controller === undefined
      ? { environment }
      : { environment, publicRtcControl: options.production.controller };
    return await starter(options.owner, dependencies);
  } catch (error) {
    await closeProduction();
    throw error;
  }
}

export const startPublicRtcProductionEntrypoint = startPublicRtcProduction;
