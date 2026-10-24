import endpoints from '../../../../apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/client-endpoints.json' with { type: 'json' };
/** Rehearse a configured legacy origin in staging; this is not deployment acceptance. */
/** Optional persistent origin migration for the staging sim. Credentials remain in the original pairing file. */
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {request} from 'node:https';
import {canonical} from '../../../services/personal-aios-integration/src/contracts.ts';

type Json = Record<string, any>;
const LEGACY = endpoints.legacyOrigin;
const DIRECT = endpoints.canonicalOrigin;

export class SimOriginMigration {
  private state: Json;
  private readonly connect: Record<string, string>;
  private readonly pairing: Json;
  private readonly file: string;
  readonly events: Json[] = [];
  constructor(pairing: Json, file: string, connectFile?: string) {
    this.pairing = pairing; this.file = file;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
      device_id: pairing.device_id, paired_at: pairing.paired_at, origin: pairing.origin, anchor_origin: pairing.origin};
    if (this.state.device_id !== pairing.device_id || this.state.paired_at !== pairing.paired_at ||
        ![LEGACY, DIRECT].includes(this.state.origin) || this.state.anchor_origin !== pairing.origin ||
        this.state.fallback_origin !== undefined && this.state.fallback_origin !== LEGACY) throw new Error('SIM_ORIGIN_STATE_INVALID');
    this.connect = connectFile ? JSON.parse(readFileSync(connectFile, 'utf8')) : {};
    for (const [origin, endpoint] of Object.entries(this.connect)) {
      const url = new URL(endpoint);
      if (![LEGACY, DIRECT].includes(origin) || url.protocol !== 'https:' || url.hostname !== '127.0.0.1' ||
          url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('SIM_CONNECT_MAP_INVALID');
    }
    this.save();
  }
  private save() {
    writeFileSync(this.file + '.next', JSON.stringify(this.state) + '\n', {mode: 0o600});
    renameSync(this.file + '.next', this.file);
  }
  private async raw(origin: string, path: string, body: Json): Promise<Response> {
    const headers = {Authorization: `Bearer ${this.pairing.token}`, 'Content-Type': 'application/json'};
    const endpoint = this.connect[origin];
    if (!endpoint) return fetch(origin + path, {method: 'POST', redirect: 'error', headers, body: JSON.stringify(body)});
    // Test-only connection mapping keeps TLS/SNI and Host verification for the real logical origins.
    // It changes no DNS, host routes, VPN settings or production endpoint.
    const target = new URL(origin), connection = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const req = request({hostname: connection.hostname, port: connection.port, servername: target.hostname,
        path, method: 'POST', headers: {...headers, Host: target.host}, timeout: 10000}, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: response.statusCode!,
          headers: {'content-type': String(response.headers['content-type'] ?? '')}})));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SIM_ORIGIN_TIMEOUT')));
      req.end(JSON.stringify(body));
    });
  }
  async post(path: string, body: Json): Promise<Response> {
    let response: Response;
    try {
      response = await this.raw(this.state.origin, path, body);
      if (response.status < 500 || !this.state.fallback_origin || this.state.origin === LEGACY) return this.accept(response);
    } catch (error) {
      if (!this.state.fallback_origin || this.state.origin === LEGACY) throw error;
    }
    this.state.origin = this.state.fallback_origin;
    this.state.confirmed = false;
    this.save(); this.events.push({step: 'origin_fallback', origin: this.state.origin});
    return this.raw(this.state.origin, path, body);
  }
  private accept(response: Response): Response {
    if (response.ok && this.state.origin === DIRECT && !this.state.confirmed) {
      this.state.confirmed = true; this.save();
      this.events.push({step: 'origin_confirmed', origin: DIRECT, fallback_retained: true});
    }
    return response;
  }
  async bootstrap(accepted: Json, body: Json) {
    if (accepted.status !== 'bootstrap_accepted' || accepted.canonical_api_origin !== DIRECT || this.state.origin !== LEGACY) return;
    let proof: Response;
    try { proof = await this.raw(DIRECT, '/v1/realtime/bootstrap/reconcile', body); }
    catch { this.events.push({step: 'origin_probe', status: 'unreachable', retained: LEGACY}); return; }
    if (!proof.ok) { this.events.push({step: 'origin_probe', http: proof.status, retained: LEGACY}); return; }
    const read = await proof.json() as Json;
    const fields = ['realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch',
      'transport_aliases', 'e2ee_key_envelope', 'recipient_device_credential_ref'];
    if (read.status !== 'committed' ||
        !fields.every(key => canonical(read[key]) === canonical(accepted[key]))) throw new Error('SIM_ORIGIN_PROOF_MISMATCH');
    this.state = {...this.state, origin: DIRECT, fallback_origin: LEGACY, confirmed: false};
    this.save();
    this.events.push({step: 'origin_migrated', http: proof.status, origin: DIRECT,
      same_device: this.state.device_id === this.pairing.device_id, anchor_unchanged: this.state.anchor_origin === this.pairing.origin});
  }
  summary() { return {origin: this.state.origin, anchor_origin: this.state.anchor_origin,
    fallback_origin: this.state.fallback_origin, confirmed: this.state.confirmed ?? false}; }
}
