import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import {isAppearanceImageRoute,type createAppearanceImages} from './avatar-appearance-images.ts';
import Ajv2020Module, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createGlassesEnrollment } from './paired-device-registration.ts';
import type {ViduRetrieval} from './vidu-call-session.ts';
import {utc} from '../../../services/personal-aios-integration/src/contracts.ts';
import {handleWatchHttp,isWatchHttpRoute,type WatchHttpOwner} from './watch-http.ts';
import {
  type JsonRecord,
  type RealtimeBearerContext,
  type RealtimeOperation,
  type RealtimePublicControlRuntime,
} from './realtime-public-control-runtime.ts';

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const FEATURE_FLAG = 'PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED';
const DEFAULT_BODY_BYTES = 128 * 1024;
const ENROLLMENT = /^\/v1\/devices\/(glasses|mac)\/enrollment(?:\/exchange)?$/;
const MAC_PAIRING = /^\/v1\/devices\/mac\/pairing\/(request|preview|approve|exchange)$/;
const MAC_SSH = /^\/v1\/mac\/ssh\/(provision|pause|revoke)$/;
const VIDU_RETRIEVAL=/^\/v1\/vidu\/retrieval\/(memory|knowledge)$/;
const REALTIME_FILES = Object.freeze([
  'realtime-place-upload-request.v1.schema.json',
  'realtime-place-upload-response.v1.schema.json',
  'realtime-watch-binding-request.v1.schema.json',
  'realtime-watch-binding-response.v1.schema.json',
  'realtime-watch-binding-read-request.v1.schema.json',
  'realtime-watch-binding-read-response.v1.schema.json',
  'realtime-bootstrap-request.v1.schema.json',
  'realtime-bootstrap-response.v1.schema.json',
  'realtime-bootstrap-read-response.v1.schema.json',
  'realtime-credential-refresh-request.v1.schema.json',
  'realtime-credential-refresh-response.v1.schema.json',
  'realtime-media-stop-request.v1.schema.json',
  'realtime-end-continuity-request.v1.schema.json',
  'realtime-e2ee-key-envelope.v1.schema.json',
  'realtime-e2ee-key-resolve-request.v1.schema.json',
  'realtime-e2ee-key-resolve-response.v1.schema.json',
  'realtime-handoff-request.v1.schema.json',
  'realtime-terminal-result.v1.schema.json',
] as const);
const ROUTES = Object.freeze({
  '/v1/place/upload': {operation:'place_upload',requestSchema:'realtime-place-upload-request.v1.schema.json',responseSchema:'realtime-place-upload-response.v1.schema.json'},
  '/v1/realtime/watch-binding': { operation: 'watch_binding', requestSchema: 'realtime-watch-binding-request.v1.schema.json', responseSchema: 'realtime-watch-binding-response.v1.schema.json' },
  '/v1/realtime/watch-binding/read': { operation: 'watch_binding', requestSchema: 'realtime-watch-binding-read-request.v1.schema.json', responseSchema: 'realtime-watch-binding-read-response.v1.schema.json' },
  '/v1/realtime/bootstrap': {
    operation: 'bootstrap',
    requestSchema: 'realtime-bootstrap-request.v1.schema.json',
    responseSchema: 'realtime-bootstrap-response.v1.schema.json',
  },
  '/v1/realtime/bootstrap/reconcile': {
    operation: 'bootstrap',
    requestSchema: 'realtime-bootstrap-request.v1.schema.json',
    responseSchema: 'realtime-bootstrap-read-response.v1.schema.json',
  },
  '/v1/realtime/e2ee/key/resolve': {
    operation: 'realtime_e2ee_key_resolve',
    requestSchema: 'realtime-e2ee-key-resolve-request.v1.schema.json',
    responseSchema: 'realtime-e2ee-key-resolve-response.v1.schema.json',
  },
  '/v1/realtime/credentials/refresh': {
    operation: 'connected_credential_refresh',
    requestSchema: 'realtime-credential-refresh-request.v1.schema.json',
    responseSchema: 'realtime-credential-refresh-response.v1.schema.json',
  },
  '/v1/realtime/media/stop': {
    operation: 'media_stop',
    requestSchema: 'realtime-media-stop-request.v1.schema.json',
    responseSchema: 'realtime-terminal-result.v1.schema.json',
  },
  '/v1/realtime/end-continuity': {
    operation: 'end_continuity',
    requestSchema: 'realtime-end-continuity-request.v1.schema.json',
    responseSchema: 'realtime-terminal-result.v1.schema.json',
  },
} as const);

type PublicOperation = RealtimeOperation | 'watch_binding';

type RoutePath = keyof typeof ROUTES;

export interface RealtimePublicControlEdgePort {
  authorize(input: {
    readonly method: string;
    readonly url: string;
    readonly remoteAddress: string | undefined;
    readonly rawHeaders: readonly string[];
    readonly controlHost: string;
  }): Promise<void>;
}

export interface RealtimePublicControlBearerPort {
  authorize(input: {
    readonly token: string;
    readonly operation: RealtimeOperation;
    readonly request: JsonRecord;
  }): Promise<RealtimeBearerContext>;
}

export interface RealtimeSchemaRegistry {
  validateRequest(operation: PublicOperation, value: unknown, requestSchema?: string): boolean;
  validateResponse(operation: PublicOperation, value: unknown, responseSchema?: string): boolean;
  validateTerminal(value: unknown): boolean;
}

export interface RealtimePublicControlControllerOptions {
  readonly canonicalApiOrigin?: string;
  readonly enabled: boolean;
  readonly controlHost: string;
  readonly edge: RealtimePublicControlEdgePort;
  readonly bearer: RealtimePublicControlBearerPort;
  readonly runtime: RealtimePublicControlRuntime;
  readonly schemaRegistry?: RealtimeSchemaRegistry;
  readonly maxBodyBytes?: number;
  readonly appearanceImages?:ReturnType<typeof createAppearanceImages>;
  readonly glassesEnrollment?: ReturnType<typeof createGlassesEnrollment>;
  readonly capabilityUpgrade?: Pick<ReturnType<typeof import('./paired-device-capabilities.ts').createPairedDeviceCapabilities>,'declare'>;
  readonly wechatPreviews?: (bearer:RealtimeBearerContext,value:JsonRecord)=>Promise<unknown>;
  readonly ownerMac?: ReturnType<typeof import('./owner-mac-ssh.ts').createOwnerMacSsh>;
  readonly viduRetrieval?:ViduRetrieval;
  readonly place?: {upload(token:string,batch:JsonRecord):Promise<unknown>;credential(token:string,input:{device_id:string;action:'issue'|'rotate'|'revoke'}):Promise<unknown>};
  readonly watch?: WatchHttpOwner;
}

export class RealtimePublicControlControllerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'RealtimePublicControlControllerError';
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, status: number): never {
  throw new RealtimePublicControlControllerError(code, status);
}

function jsonRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', 400);
  return value as JsonRecord;
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): readonly string[] {
  if (rawHeaders.length % 2 !== 0) fail('PUBLIC_CONTROL_HEADERS_INVALID', 400);
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === lower) values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function exactContentType(request: IncomingMessage): void {
  const values = rawHeaderValues(request.rawHeaders, 'content-type');
  if (values.length !== 1 || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(values[0]!)) {
    fail('CONTENT_TYPE_INVALID', 400);
  }
}

function bearerValue(request: IncomingMessage): string {
  const values = rawHeaderValues(request.rawHeaders, 'authorization');
  if (values.length !== 1 || values[0]!.includes(',')) fail('CONTROL_CAPABILITY_INVALID', 401);
  const match = /^Bearer ([^\s\u0000-\u001f\u007f]{16,8192})$/u.exec(values[0]!);
  if (!match) fail('CONTROL_CAPABILITY_INVALID', 401);
  return match[1]!;
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const lengths = rawHeaderValues(request.rawHeaders, 'content-length');
  if (lengths.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(lengths[0]!)) fail('BODY_LENGTH_INVALID', 400);
  const expected = Number(lengths[0]);
  if (!Number.isSafeInteger(expected) || expected < 2 || expected > maximumBytes) fail('BODY_TOO_LARGE', 413);
  if (rawHeaderValues(request.rawHeaders, 'transfer-encoding').length !== 0) fail('TRANSFER_ENCODING_INVALID', 400);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumBytes) fail('BODY_TOO_LARGE', 413);
    chunks.push(bytes);
  }
  if (length !== expected) fail('BODY_INCOMPLETE', 400);
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
  });
  response.end(encoded);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RealtimePublicControlControllerError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message)) return error.message;
  return 'PUBLIC_CONTROL_UNAVAILABLE';
}

function safeErrorStatus(error: unknown): number {
  if (error instanceof RealtimePublicControlControllerError) return error.status;
  const status = (error as { readonly status?: unknown } | undefined)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 503;
}

function routeFor(rawTarget: string, method: string | undefined): { readonly path: RoutePath; readonly route: typeof ROUTES[RoutePath] } | undefined {
  if (method !== 'POST') return undefined;
  const route = ROUTES[rawTarget as RoutePath];
  return route === undefined ? undefined : { path: rawTarget as RoutePath, route };
}

function schemaRoot(): string {
  return fileURLToPath(new URL('../../../contracts/json-schema/', import.meta.url));
}

function readJson(path: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return jsonRecord(parsed);
}

export function createRealtimeSchemaRegistry(root = schemaRoot()): RealtimeSchemaRegistry {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  // The source contract uses only the shared draft-07/2020 keywords in this descriptor.
  // Keep its single $id/definition; omit the draft-07 root meta declaration for this Ajv2020 registry.
  const {$schema: _formalMeta, ...formalContract} = readJson(fileURLToPath(new URL('../../../../../integrations/contracts/formal-message.v1.json', import.meta.url)));
  ajv.addSchema(formalContract);
  ajv.addFormat('paios-utc',{type:'string',validate:(value:string)=>{try{utc(value);return true;}catch{return false;}}});
  const common = join(root, 'common');
  for (const name of readdirSync(common).filter((item) => item.endsWith('.json')).sort()) {
    ajv.addSchema(readJson(join(common, name)));
  }
  const realtime = join(root, 'realtime');
  for (const name of REALTIME_FILES) ajv.addSchema(readJson(join(realtime, name)));

  const requestValidators = new Map<string, ValidateFunction>();
  const responseValidators = new Map<string, ValidateFunction>();
  const terminalId = 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json';
  const terminalValidator = ajv.getSchema(terminalId);
  if (terminalValidator === undefined) throw new Error('REALTIME_TERMINAL_SCHEMA_UNRESOLVED');
  for (const entry of Object.values(ROUTES)) {
    const requestId = `https://personal-ai-os.local/contracts/realtime/${entry.requestSchema}`;
    const responseId = `https://personal-ai-os.local/contracts/realtime/${entry.responseSchema}`;
    const requestValidator = ajv.getSchema(requestId);
    const responseValidator = ajv.getSchema(responseId);
    if (requestValidator === undefined || responseValidator === undefined) throw new Error('REALTIME_SCHEMA_UNRESOLVED');
    requestValidators.set(entry.requestSchema, requestValidator);
    responseValidators.set(entry.responseSchema, responseValidator);
  }
  return Object.freeze({
    validateRequest(operation: PublicOperation, value: unknown, requestSchema?: string) {
      const schema = requestSchema ?? Object.values(ROUTES).find(entry => entry.operation === operation)?.requestSchema;
      return schema !== undefined && requestValidators.get(schema)?.(value) === true;
    },
    validateResponse(operation: PublicOperation, value: unknown, responseSchema?: string) {
      const schema = responseSchema ?? Object.values(ROUTES).find(entry => entry.operation === operation)?.responseSchema;
      const validator = schema === undefined ? undefined : responseValidators.get(schema);
      const valid = validator?.(value) === true;
      return valid;
    },
    validateTerminal(value: unknown) {
      return terminalValidator(value) === true;
    },
  });
}

export function parseRealtimePublicControlFeatureFlag(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[FEATURE_FLAG];
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error('PUBLIC_RTC_FEATURE_FLAG_INVALID');
}

export function isRealtimePublicControlRoute(method: string | undefined, rawTarget: string): boolean {
  return isAppearanceImageRoute(method,rawTarget)||isWatchHttpRoute(method,rawTarget)||routeFor(rawTarget, method) !== undefined || method === 'POST' && (rawTarget === '/v1/mac/wechat/previews'||MAC_SSH.test(rawTarget)||VIDU_RETRIEVAL.test(rawTarget)||rawTarget === '/v1/terminals/capabilities'||rawTarget === '/v1/place/credential' || ENROLLMENT.test(rawTarget)||MAC_PAIRING.test(rawTarget));
}

export class RealtimePublicControlController {
  readonly #canonicalApiOrigin: string | undefined;
  readonly #enabled: boolean;
  readonly #controlHost: string;
  readonly #edge: RealtimePublicControlEdgePort;
  readonly #bearer: RealtimePublicControlBearerPort;
  readonly #runtime: RealtimePublicControlRuntime;
  readonly #schemas: RealtimeSchemaRegistry;
  readonly #maxBodyBytes: number;
  readonly #glassesEnrollment: ReturnType<typeof createGlassesEnrollment> | undefined;
  readonly #capabilityUpgrade: RealtimePublicControlControllerOptions['capabilityUpgrade'];
  readonly #viduRetrieval:ViduRetrieval|undefined;
  readonly #appearanceImages:RealtimePublicControlControllerOptions['appearanceImages'];
  readonly #place:RealtimePublicControlControllerOptions['place'];
  readonly #watch:WatchHttpOwner|undefined;
  readonly #wechatPreviews:RealtimePublicControlControllerOptions['wechatPreviews'];
  readonly #ownerMac:RealtimePublicControlControllerOptions['ownerMac'];
  #closed = false;

  constructor(options: RealtimePublicControlControllerOptions) {
    if (typeof options.controlHost !== 'string' || options.controlHost.length === 0) throw new Error('PUBLIC_CONTROL_HOST_REQUIRED');
    if (typeof options.edge?.authorize !== 'function') throw new Error('PUBLIC_CONTROL_EDGE_PORT_REQUIRED');
    if (typeof options.bearer?.authorize !== 'function') throw new Error('PUBLIC_CONTROL_BEARER_PORT_REQUIRED');
    if (
      typeof options.runtime?.bootstrap !== 'function' ||
      typeof options.runtime?.resolveE2eeKey !== 'function' ||
      typeof options.runtime?.refresh !== 'function' ||
      typeof options.runtime?.stop !== 'function' ||
      typeof options.runtime?.endContinuity !== 'function' ||
      typeof options.runtime?.close !== 'function'
    ) {
      throw new Error('PUBLIC_CONTROL_RUNTIME_PORT_REQUIRED');
    }
    this.#canonicalApiOrigin = options.canonicalApiOrigin;
    this.#enabled = options.enabled;
    this.#controlHost = options.controlHost;
    this.#edge = options.edge;
    this.#bearer = options.bearer;
    this.#runtime = options.runtime;
    this.#schemas = options.schemaRegistry ?? createRealtimeSchemaRegistry();
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES;
    this.#glassesEnrollment = options.glassesEnrollment;
    this.#capabilityUpgrade = options.capabilityUpgrade;
    this.#viduRetrieval=options.viduRetrieval;
    this.#appearanceImages=options.appearanceImages;
    this.#place=options.place;
    this.#watch=options.watch;
    this.#ownerMac=options.ownerMac;
    this.#wechatPreviews=options.wechatPreviews;
    if (!Number.isSafeInteger(this.#maxBodyBytes) || this.#maxBodyBytes < 1024 || this.#maxBodyBytes > 4 * 1024 * 1024) {
      throw new Error('PUBLIC_CONTROL_BODY_LIMIT_INVALID');
    }
  }

  matches(method: string | undefined, rawTarget: string): boolean {
    return !this.#closed && this.#enabled && isRealtimePublicControlRoute(method, rawTarget) &&
      (routeFor(rawTarget,method)?.route.operation !== 'watch_binding' || this.#runtime.watchBindingAvailable);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!this.matches(request.method,request.url ?? '/')) return false;
    if(isAppearanceImageRoute(request.method,request.url)){
      try {
        await this.#edge.authorize({method:request.method!,url:request.url!,remoteAddress:request.socket.remoteAddress,
          rawHeaders:request.rawHeaders,controlHost:this.#controlHost});
        if(!this.#appearanceImages){sendJson(response,503,{error:'AVATAR_IMAGE_UPLOAD_UNAVAILABLE'});return true;}
        return await this.#appearanceImages.handle(request,response);
      } catch(error) {
        sendJson(response,error instanceof ContractError?error.status:503,{error:error instanceof ContractError?error.code:'AVATAR_IMAGE_UPLOAD_FAILED'});
        return true;
      }
    }
    if(isWatchHttpRoute(request.method,request.url!)){
      if(!this.#watch){sendJson(response,503,{status:'failed',reason:'service_unavailable'});return true;}
      await handleWatchHttp(request,response,this.#watch,()=>this.#edge.authorize({method:request.method!,url:request.url!,
        remoteAddress:request.socket.remoteAddress,rawHeaders:request.rawHeaders,controlHost:this.#controlHost}),
        error=>process.stderr.write(`${JSON.stringify({route:request.url,safeErrorCode:safeErrorCode(error)})}\n`));return true;
    }
    const began=Date.now();
    const place=request.url==='/v1/place/upload'||request.url==='/v1/place/credential';
    const macPairing=MAC_PAIRING.exec(request.url??'')?.[1];
    const macSsh=MAC_SSH.exec(request.url??'')?.[1];
    const enrollment = ENROLLMENT.exec(request.url ?? '')?.[1] as 'glasses'|'mac'|undefined;
    const retrieval=VIDU_RETRIEVAL.exec(request.url??'')?.[1] as 'memory'|'knowledge'|undefined;
    const selected = routeFor(request.url ?? '/', request.method)!;
    try {
      const live=retrieval?this.#viduRetrieval?.get(bearerValue(request)):undefined;
      if(retrieval&&!live)fail('VIDU_RETRIEVAL_UNAUTHORIZED',401);
      exactContentType(request);
      const body = await readBody(request, retrieval?8192:place?DEFAULT_BODY_BYTES:this.#maxBodyBytes);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')) as unknown; } catch { fail('INVALID_JSON', 400); }
      const value = jsonRecord(parsed);
      if(request.url==='/v1/terminals/capabilities'){
        await this.#edge.authorize({method:request.method!,url:request.url,remoteAddress:request.socket.remoteAddress,rawHeaders:request.rawHeaders,controlHost:this.#controlHost});
        if(!this.#capabilityUpgrade)fail('CAPABILITY_UPGRADE_UNAVAILABLE',503);
        if(Object.keys(value).join(',')!=='capabilities')fail('INVALID_TERMINAL_CAPABILITIES',422);
        sendJson(response,200,await this.#capabilityUpgrade.declare(bearerValue(request),value.capabilities));return true;
      }
      if(request.url==='/v1/mac/wechat/previews'){
        await this.#edge.authorize({method:request.method!,url:request.url,remoteAddress:request.socket.remoteAddress,rawHeaders:request.rawHeaders,controlHost:this.#controlHost});
        if(!this.#wechatPreviews)fail('WECHAT_PREVIEWS_UNAVAILABLE',503);
        const bearer=await this.#bearer.authorize({token:bearerValue(request),operation:'bootstrap',request:value});
        sendJson(response,202,await this.#wechatPreviews(bearer,value));return true;
      }
      if(macSsh){
        await this.#edge.authorize({method:request.method!,url:request.url!,remoteAddress:request.socket.remoteAddress,rawHeaders:request.rawHeaders,controlHost:this.#controlHost});
        if(!this.#ownerMac)fail('OWNER_MAC_UNAVAILABLE',503);
        const bearer=await this.#bearer.authorize({token:bearerValue(request),operation:'bootstrap',request:value});
        sendJson(response,200,macSsh==='provision'?await this.#ownerMac.provision(bearer,value):await this.#ownerMac.control(bearer,value,macSsh==='revoke'));return true;
      }
      if(place){
        await this.#edge.authorize({method:request.method!,url:request.url!,remoteAddress:request.socket.remoteAddress,rawHeaders:request.rawHeaders,controlHost:this.#controlHost});
        if(!this.#place)fail('PLACE_UPLOAD_UNAVAILABLE',503);
        if(request.url==='/v1/place/credential'){
          if(Object.keys(value).sort().join(',')!=='action,device_id' || typeof value.device_id!=='string' || !['issue','rotate','revoke'].includes(value.action as string))fail('PLACE_CREDENTIAL_INVALID',422);
          sendJson(response,200,await this.#place.credential(bearerValue(request),value as {device_id:string;action:'issue'|'rotate'|'revoke'}));return true;
        }
        if(!this.#schemas.validateRequest('place_upload',value))fail('PLACE_SCHEMA_INVALID',422);
        const result=await this.#place.upload(bearerValue(request),value);
        if(!this.#schemas.validateResponse('place_upload',result))fail('PLACE_RESPONSE_SCHEMA_INVALID',503);
        sendJson(response,200,result);return true;
      }
      if(retrieval){
        if(value.live_id!==live!.live_id)fail('VIDU_RETRIEVAL_UNAUTHORIZED',401);
        const types=value[retrieval==='memory'?'memory_types':'knowledge_types'];
        if(typeof value.query!=='string'||!value.query.trim()||typeof value.reason!=='string'||
          types!==undefined&&(!Array.isArray(types)||!types.every(type=>typeof type==='string'))||
          value.time_hint!==undefined&&typeof value.time_hint!=='string'||value.max_results!==undefined&&
          (!Number.isSafeInteger(value.max_results)||Number(value.max_results)<1||Number(value.max_results)>10))fail('VIDU_RETRIEVAL_INVALID',400);
        let items:Awaited<ReturnType<NonNullable<typeof live>['lookup']>>['items']=[],lookupError:string|undefined;
        try{items=(await live!.lookup(live!.source,{kind:retrieval,query:value.query,reason:value.reason,
          ...(types?{types:types as string[]}:{}),...(value.time_hint!==undefined?{time_hint:value.time_hint as string}:{}),
          ...(value.max_results!==undefined?{max_results:value.max_results as number}:{})})).items;}catch(error){lookupError=safeErrorCode(error);}
        // A call may end while Hermes is reading. Its revoked capability must not release a late private answer.
        if(this.#viduRetrieval?.get(bearerValue(request))!==live)fail('VIDU_RETRIEVAL_UNAUTHORIZED',401);
        sendJson(response,200,{[retrieval==='memory'?'memories':'knowledge']:items.map(({id,text,type,confidence,updated_at,source})=>
          retrieval==='memory'?{id,summary:text,type,confidence,updated_at,source}:{id,title:id,content:text,type,confidence,updated_at,source})});
        // The answer Vidu's front reads (latency and count only; a failed Hermes lookup answers empty, so its code is kept).
        try{process.stderr.write(`${JSON.stringify({route:request.url,status:200,live_id:live!.live_id,ms:Date.now()-began,items:items.length,...(lookupError?{lookup_error:lookupError}:{})})}\n`);}catch{}
        return true;
      }
      if(macPairing){
        await this.#edge.authorize({method:request.method!,url:request.url!,remoteAddress:request.socket.remoteAddress,rawHeaders:request.rawHeaders,controlHost:this.#controlHost});
        if(!this.#glassesEnrollment)fail('MAC_PAIRING_UNAVAILABLE',503);
        const keys=Object.keys(value).sort().join(',');
        if(keys!==(macPairing==='request'?'registration':macPairing==='preview'?'nonce':macPairing==='approve'?'nonce,owner_proof':'nonce,poll_token'))fail('MAC_PAIRING_INVALID',422);
        const result=macPairing==='request'?await this.#glassesEnrollment.requestMac(jsonRecord(value.registration)):
          macPairing==='preview'?await this.#glassesEnrollment.previewMac(bearerValue(request),value.nonce):
          macPairing==='approve'?await this.#glassesEnrollment.approveMac(bearerValue(request),value.nonce,jsonRecord(value.owner_proof)):
          await this.#glassesEnrollment.exchangeMac(value.nonce,value.poll_token);
        sendJson(response,200,result);return true;
      }
      if (enrollment) {
        await this.#edge.authorize({method:request.method!, url:request.url!, remoteAddress:request.socket.remoteAddress,
          rawHeaders:request.rawHeaders, controlHost:this.#controlHost});
        if (!this.#glassesEnrollment) fail(`${enrollment.toUpperCase()}_ENROLLMENT_UNAVAILABLE`, 503);
        const exchange = request.url!.endsWith('/exchange');
        if (exchange ? Object.keys(value).sort().join(',') !== 'registration,token' || typeof value.token !== 'string' : Object.keys(value).length !== 0) fail(`${enrollment.toUpperCase()}_ENROLLMENT_INVALID`, 422);
        const result = exchange ? await this.#glassesEnrollment.exchange(value.token as string, jsonRecord(value.registration), enrollment)
          : await this.#glassesEnrollment.issue(bearerValue(request), enrollment);
        sendJson(response, 200, result); return true;
      }
      if (value.operation !== selected.route.operation || !this.#schemas.validateRequest(selected.route.operation, value, selected.route.requestSchema)) {
        fail('REALTIME_SCHEMA_INVALID', 422);
      }
      await this.#edge.authorize({
        method: request.method ?? '',
        url: request.url ?? '/',
        remoteAddress: request.socket.remoteAddress,
        rawHeaders: request.rawHeaders,
        controlHost: this.#controlHost,
      });
      const bearer = await this.#bearer.authorize({
        token: bearerValue(request), operation: selected.route.operation === 'watch_binding' ? 'bootstrap' : selected.route.operation, request: value,
      });
      const requestDevice = typeof value.device_id === 'string' ? value.device_id
        : typeof value.from_device_id === 'string' ? value.from_device_id : undefined;
      if (requestDevice !== undefined && bearer.deviceId !== requestDevice) {
        fail('CONTROL_CAPABILITY_DEVICE_MISMATCH', 403);
      }
      const authorityResult = selected.path === '/v1/realtime/bootstrap/reconcile'
        ? await this.#runtime.readBootstrapFact(value, bearer)
        : selected.route.operation === 'watch_binding'
        ? await this.#runtime.watchBinding(value, bearer, selected.path === '/v1/realtime/watch-binding/read')
        : selected.route.operation === 'bootstrap'
        ? await this.#runtime.bootstrap(value, bearer)
        : selected.route.operation === 'realtime_e2ee_key_resolve'
          ? await this.#runtime.resolveE2eeKey(value, bearer)
        : selected.route.operation === 'connected_credential_refresh'
          ? await this.#runtime.refresh(value, bearer)
          : selected.route.operation === 'media_stop'
            ? await this.#runtime.stop(value, bearer)
            : selected.route.operation === 'end_continuity'
              ? await this.#runtime.endContinuity(value, bearer)
              : fail('PUBLIC_CONTROL_OPERATION_UNAVAILABLE', 503);
      // Reconcile has a closed response contract in already-installed clients.
      const result = selected.path === '/v1/realtime/bootstrap' && this.#canonicalApiOrigin
        ? {...authorityResult, canonical_api_origin: this.#canonicalApiOrigin} : authorityResult;
      if (!this.#schemas.validateResponse(selected.route.operation, result, selected.route.responseSchema)) fail('REALTIME_RESPONSE_SCHEMA_INVALID', 503);
      sendJson(response, 200, result);
      // Every public-control outcome is observable (route and status only; never bodies or credentials).
      try { process.stderr.write(`${JSON.stringify({ route: selected.path, status: 200 })}\n`); } catch {}
    } catch (error) {
      const status = safeErrorStatus(error);
      const code = safeErrorCode(error);
      try {
        process.stderr.write(`${JSON.stringify({ route: request.url, status, safeErrorCode: code })}\n`);
      } catch {}
      const terminal = (error as { readonly terminalResult?: unknown } | undefined)?.terminalResult;
      if (!response.headersSent && terminal !== undefined && this.#schemas.validateTerminal(terminal)) {
        sendJson(response, status, terminal);
      } else if (!response.headersSent) sendJson(response, status, retrieval?{[retrieval==='memory'?'memories':'knowledge']:[]}:{ error: code });
      else if (!response.writableEnded) response.end();
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#runtime.close();
  }
}

export const createRealtimePublicControlController = (
  options: RealtimePublicControlControllerOptions,
): RealtimePublicControlController => new RealtimePublicControlController(options);
