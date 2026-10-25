import {readPackage} from './registry.ts';
import type {ContractEvidence, PackageVersion, RegistrationRunner} from './interfaces.ts';

/** Bind to the existing pinned-TLS workshop bridge and P1's host health authority. */
export function workshopRegistrationRunner(
  request: (path: '/capability-check', files: Record<string, string>) => Promise<ContractEvidence>,
  healthy: (version: PackageVersion) => Promise<boolean>,
): RegistrationRunner {
  return {check: async root => request('/capability-check', await readPackage(root)), health: healthy};
}
