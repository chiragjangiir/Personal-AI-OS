export type PackageFiles = Record<string, string>;
export interface PackageVersion {
  name: string; version: string; digest: string; root: string;
  manifest: Record<string, any>;
}
export interface PackageContext {principal_id: string; run_id: string; scope: string; tool_call_id?: string}
/** P1 owns capability_packages, persistence, CAS and live host replacement. No registry copy.
 * replace preloads the checked version, keeps the old host on failure, then commits the one
 * enabled selection, unloads the old version and emits notifications/tools/list_changed.
 * The catalog/skills projection and notification retry stay with that same authority.
 */
export interface EnabledPackageAuthority {
  installed(principal: string): Promise<PackageVersion[]>;
  enabled(principal: string): Promise<PackageVersion[]>;
  replace(context: PackageContext, change: {
    name: string; expected: string | null; next: PackageVersion | null;
  }): Promise<void>;
}
/** P1 ledger projection; counts must be bounded to these version digests, never lifetime totals. */
export interface PackageLedger {
  outcomes(principal: string, name: string, digest: string): Promise<{
    total: number; failed: number; unknown: number;
  }>;
}
/** P3 owns the fixed gateway Decision union, owner_requested and frozen-call resumption. */
export interface PackageDecide {
  decide(context: PackageContext, call: {package: PackageVersion; tool: string; args: Record<string, unknown>}):
    Promise<{action: 'allow'} | {action: 'modify'; args: Record<string, unknown>} |
      {action: 'block'; message: string} | {action: 'approve'; message: string; rule_key: string}>;
}
export interface ContractEvidence {
  success: boolean;
  cases: Array<{implementation: string; tool: string; args: Record<string, unknown>; result: unknown; writes: string[]; network: string[]}>;
  errors: string[];
}
export interface RegistrationRunner {
  check(root: string): Promise<ContractEvidence>;
  health(version: PackageVersion): Promise<boolean>;
}
export interface DiscoverySources {
  hub(query: string): Promise<unknown>;
  mcp(query: string): Promise<unknown>;
}
