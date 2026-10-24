import { canonical, check, id, sha256, type TrustedContext } from './contracts.ts';

export const TERMINAL_CAPABILITIES = ['display','speaker','microphone','continuous_audio','camera','notifications','health','contacts','location','owner_unlock','chat_ui','wear_state','local_wake','desktop_tools'] as const;
export type TerminalCapability = typeof TERMINAL_CAPABILITIES[number];
// A phone camera supports calls and owner-requested capture; first-person capture requires wear_state.
export const PHONE_CAPABILITIES: readonly TerminalCapability[] = Object.freeze(TERMINAL_CAPABILITIES.filter(value=>value!=='wear_state'&&value!=='local_wake'&&value!=='desktop_tools'));
export const GLASSES_CAPABILITIES: readonly TerminalCapability[] = Object.freeze(['display','speaker','microphone','continuous_audio','camera','notifications','wear_state']);
export const MAC_CAPABILITIES: readonly TerminalCapability[] = Object.freeze(['display','speaker','microphone','camera','notifications','chat_ui','desktop_tools']);
export const WATCH_CAPABILITIES: readonly TerminalCapability[] = Object.freeze(['display','speaker','microphone','notifications','health','location']);
/** Declarations are authoritative; legacy phone and the bound Watch relay retain their established defaults. */
export function terminalCapabilities(device: {device_type: string; capabilities?: readonly TerminalCapability[]|undefined}): readonly TerminalCapability[] {
  const declared = device.capabilities === undefined ? (device.device_type === 'phone' ? PHONE_CAPABILITIES : device.device_type === 'watch' ? WATCH_CAPABILITIES : []) : device.capabilities;
  check(Array.isArray(declared) && declared.every(value => TERMINAL_CAPABILITIES.includes(value)) &&
    new Set(declared).size === declared.length, device.device_type === 'mac' ? 'TERMINAL_CAPABILITY_DENIED' : 'INVALID_TERMINAL_CAPABILITIES');
  check(device.device_type === 'phone' || device.device_type === 'mac' || !declared.includes('owner_unlock'), 'TERMINAL_CAPABILITY_DENIED');
  check(!declared.includes('desktop_tools') || device.device_type === 'mac', 'TERMINAL_CAPABILITY_DENIED');
  check(device.device_type !== 'mac' || declared.every(value => value==='owner_unlock'||MAC_CAPABILITIES.includes(value)), 'TERMINAL_CAPABILITY_DENIED');
  check(device.device_type !== 'glasses' || !declared.some(value => value === 'health' || value === 'contacts'), 'TERMINAL_CAPABILITY_DENIED');
  check(!declared.includes('continuous_audio') || declared.includes('microphone'), 'TERMINAL_CAPABILITY_DENIED');
  return Object.freeze([...declared]);
}
export function hasTerminalCapability(device: {device_type: string; capabilities?: readonly TerminalCapability[]|undefined}, capability: TerminalCapability): boolean {
  return terminalCapabilities(device).includes(capability);
}
/** First-person capture (visual memory policy, frames, capture targets) needs a worn camera, never a phone's call camera. */
export function hasFirstPersonCamera(device: {device_type: string; capabilities?: readonly TerminalCapability[]|undefined}): boolean {
  const capabilities = terminalCapabilities(device);
  return capabilities.includes('camera') && capabilities.includes('wear_state');
}

// Product identity has no HTTP credential requirement. Only the explicit fixture owns token hashes.
export interface RegisteredDevice extends Omit<TrustedContext, 'submission'> {
  capabilities?: readonly TerminalCapability[]; route_version: string; output_modes: string[]; output_target?: {device_id:string;device_type:'phone'};
}
export interface FixtureRegisteredDevice extends RegisteredDevice {token_sha256: string}
export interface SourceDeviceAuthority {
  scheduled?(principal:string,device:string):Promise<RegisteredDevice>;
  withVoiceAction?<T>(source:RegisteredDevice,modality:'audio'|'data',consume:()=>Promise<T>):Promise<T>;
  verifyRunController?(source:RegisteredDevice,d:import('./contracts.ts').ProcessedEvent,sourceRouteVersion:string):Promise<void>;
  verifyOutputRecipient?(source:RegisteredDevice,d:import('./contracts.ts').ProcessedEvent,routeVersion:string):Promise<void>;
  authenticate(credential: unknown): Promise<RegisteredDevice>;
  revalidate(source: RegisteredDevice): Promise<RegisteredDevice>;
}
export function sourceSnapshot(device: RegisteredDevice): RegisteredDevice {
  id(device.device_id); id(device.principal_id); id(device.route_version); id(device.consent_ref);
  check(['mac','phone','watch','glasses'].includes(device.device_type) && typeof device.channel === 'string' && device.channel.length > 0,
    'INVALID_SOURCE_DEVICE');
  check(Array.isArray(device.output_modes) && device.output_modes.length <= 3 &&
    device.output_modes.every(mode => ['text','voice','text_and_voice'].includes(mode)) && new Set(device.output_modes).size === device.output_modes.length, 'INVALID_SOURCE_ROUTE');
  check(!device.output_target || device.device_type==='watch' && device.relay_device_id===device.output_target.device_id &&
    device.output_target.device_type==='phone' && device.output_target.device_id!==device.device_id,'INVALID_SOURCE_OUTPUT_TARGET');
  return Object.freeze({...device,capabilities:terminalCapabilities(device),...(device.output_target?{output_target:Object.freeze({...device.output_target})}:{}), output_modes: Object.freeze([...device.output_modes])}) as unknown as RegisteredDevice;
}
export class StaticFixtureDeviceAuthority implements SourceDeviceAuthority {
  private readonly devices: {hash: string; source: RegisteredDevice}[];
  private readonly issued = new WeakMap<RegisteredDevice, RegisteredDevice>();
  constructor(devices: FixtureRegisteredDevice[]) {
    this.devices = devices.map(({token_sha256, ...device}) => {
      check(/^[a-f0-9]{64}$/u.test(token_sha256), 'INVALID_DEVICE_CREDENTIAL');
      return {hash: token_sha256, source: sourceSnapshot(device)};
    });
    check(new Set(this.devices.map(device => device.hash)).size === this.devices.length, 'DUPLICATE_DEVICE_CREDENTIAL');
  }
  async authenticate(credential: unknown): Promise<RegisteredDevice> {
    check(typeof credential === 'string', 'DEVICE_AUTHENTICATION_REQUIRED', 401);
    const registered = this.devices.find(device => device.hash === sha256(credential));
    check(registered, 'DEVICE_AUTHENTICATION_REQUIRED', 401);
    const source = sourceSnapshot(registered.source); this.issued.set(source, registered.source); return source;
  }
  async revalidate(source: RegisteredDevice): Promise<RegisteredDevice> {
    const registered = this.issued.get(source);
    check(registered && canonical(source) === canonical(registered), 'DEVICE_REGISTRY_BINDING_REQUIRED', 403);
    return source;
  }
}
