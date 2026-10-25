import {desktopPackageResult, type DesktopResult} from './receipt.ts';

/** Supplied by the platform's single enabled-package catalog (capability/packages.ts). */
export interface PackageCatalogPort {has(identity: string): boolean}

export function desktopPackage(catalog?: PackageCatalogPort) {
  const enabled = () => catalog?.has('mcp__desktop__list_allowed_directories') === true;
  return {
    enabled,
    tools<T extends {inputSchema: {properties?: object}}>(tools: T[]): T[] {
      return enabled() ? tools.map(tool => ({...tool, inputSchema: {...tool.inputSchema,
        properties: {...tool.inputSchema.properties, owner_requested: {type: 'boolean', description: 'Whether the owner explicitly requested this operation.'}}}})) : tools;
    },
    // owner_requested is gateway input, never a field on the Apple wire.
    arguments(args: Record<string, unknown>) {
      if (!enabled()) return args;
      const {owner_requested: _ownerRequested, ...wire} = args;
      return wire;
    },
    result<T extends DesktopResult>(name: string, args: Record<string, unknown>, raw: T) {
      return enabled() ? desktopPackageResult(name, args, raw) : raw;
    },
  };
}
