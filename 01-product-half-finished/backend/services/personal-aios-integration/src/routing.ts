import { canonical, check, digest, id, validateProcessed, type DeviceType, type ProcessedEvent } from './contracts.ts';
import type { StoragePort } from './storage.ts';
import type { OutputContext } from './output.ts';
export type OutputTarget = OutputContext['target'];
export interface RouteSource {
  principal_id: string; device_id: string; device_type: DeviceType; channel: string;
  output_target?: {device_id:string;device_type:'phone'}; relay_device_id?: string; route_version: string; output_modes: string[];
}
export interface OutputTargetSnapshot {
  schema_version: 'paios.output-target.v1'; principal_id: string; processed_event_id: string;
  event_id: string; d_sha256: string; raw_ref: string; source: ProcessedEvent['source']; target: OutputTarget;
}
// Source route owner: a finalized D retains the trusted route that first admitted it.
export class OutputTargetAuthority {
  private readonly storage: StoragePort;
  constructor(storage: StoragePort) {this.storage = storage;}
  private key(d: ProcessedEvent): string {return digest({principal_id:d.principal_id,processed_event_id:d.processed_event_id});}
  private validate(d: ProcessedEvent, saved: OutputTargetSnapshot): void {
    validateProcessed(d);
    check(saved.schema_version === 'paios.output-target.v1' && saved.principal_id === d.principal_id &&
      saved.processed_event_id === d.processed_event_id && saved.event_id === d.event_id && saved.d_sha256 === digest(d) &&
      saved.raw_ref === d.raw_ref && canonical(saved.source) === canonical(d.source) &&
      (saved.target.device_id === d.device_id && saved.target.device_type === d.device_type ||
        d.device_type==='watch' && saved.target.device_type==='phone' && saved.target.device_id===d.source.relay_device_id),
      'OUTPUT_TARGET_SCOPE_CONFLICT', 409);
    id(saved.target.route_version);
    check(Array.isArray(saved.target.output_modes) && saved.target.output_modes.length <= 3 && saved.target.output_modes.every(mode => ['text','voice','text_and_voice'].includes(mode)) &&
      new Set(saved.target.output_modes).size === saved.target.output_modes.length, 'OUTPUT_TARGET_INVALID_MODES');
  }
  async find(d: ProcessedEvent): Promise<OutputTargetSnapshot | undefined> {
    validateProcessed(d);
    let bytes: Uint8Array;
    try {bytes = await this.storage.read('output-targets',this.key(d));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
    const saved = JSON.parse(Buffer.from(bytes).toString('utf8')) as OutputTargetSnapshot;
    this.validate(d,saved); return saved;
  }
  async read(d: ProcessedEvent): Promise<OutputTarget> {
    const saved = await this.find(d);
    check(saved, 'LEGACY_OUTPUT_TARGET_REQUIRED', 409);
    return saved.target;
  }
  async capture(d: ProcessedEvent, source: RouteSource): Promise<OutputTargetSnapshot> {
    check(source.principal_id === d.principal_id && source.device_id === d.device_id && source.device_type === d.device_type &&
      source.channel === d.source.channel && source.relay_device_id === d.source.relay_device_id, 'OUTPUT_TARGET_SOURCE_DENIED', 403);
    const existing = await this.find(d); if (existing) return existing;
    const snapshot: OutputTargetSnapshot = {schema_version:'paios.output-target.v1',principal_id:d.principal_id,
      processed_event_id:d.processed_event_id,event_id:d.event_id,d_sha256:digest(d),raw_ref:d.raw_ref,source:d.source,
      target:{device_id:source.output_target?.device_id ?? source.device_id,device_type:source.output_target?.device_type ?? source.device_type,route_version:source.route_version,output_modes:[...source.output_modes]}};
    this.validate(d,snapshot);
    const saved = JSON.parse(Buffer.from(await this.storage.publish('output-targets',this.key(d),Buffer.from(canonical(snapshot)))).toString('utf8')) as OutputTargetSnapshot;
    this.validate(d,saved); return saved;
  }
}
