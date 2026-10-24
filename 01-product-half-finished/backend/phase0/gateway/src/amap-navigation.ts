import { readFileSync } from 'node:fs';
import { check, ContractError } from '../../../services/personal-aios-integration/src/contracts.ts';
import wire from '../../../../../integrations/contracts/formal-message.v1.json' with {type:'json'};

type Point = {lat: number; lng: number};
import type {NavMode, NavPlace, NavStep, NavPlan, NavRoute, Navigation} from '../../../services/personal-aios-integration/src/movement.ts';
import {NavigationProviderError} from '../../../services/personal-aios-integration/src/movement.ts';
export type {NavMode, NavPlace, NavStep, NavPlan, Navigation};

// Standard GCJ-02 ellipsoid offset. Its inverse refines the same transform, rather than a second formula.
function offset({lat, lng}: Point): Point {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return {lat: 0, lng: 0};
  const x = lng - 105, y = lat - 35, pi = Math.PI;
  const wave = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  let dLat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x)) + wave;
  dLat += (20*Math.sin(y*pi) + 40*Math.sin(y*pi/3)) * 2/3;
  dLat += (160*Math.sin(y*pi/12) + 320*Math.sin(y*pi/30)) * 2/3;
  let dLng = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x)) + wave;
  dLng += (20*Math.sin(x*pi) + 40*Math.sin(x*pi/3)) * 2/3;
  dLng += (150*Math.sin(x*pi/12) + 300*Math.sin(x*pi/30)) * 2/3;
  const rad = lat*pi/180, magic = 1 - 0.00669342162296594323 * Math.sin(rad)**2;
  return {lat: dLat*180 / ((6378245*(1-0.00669342162296594323)/(magic*Math.sqrt(magic)))*pi),
    lng: dLng*180 / ((6378245/Math.sqrt(magic))*Math.cos(rad)*pi)};
}
function toGcj(point: Point): Point {
  const d = offset(point); return {lat: point.lat + d.lat, lng: point.lng + d.lng};
}
function fromGcj(point: Point): Point {
  let result = point;
  for (let i = 0; i < 3; i++) {const d = offset(result); result = {lat: point.lat - d.lat, lng: point.lng - d.lng};}
  return result;
}
function location(point: Point): string {
  const gcj = toGcj(point); return `${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}`;
}
function point(value: string): Point {
  if (typeof value !== 'string') providerFailed('INVALID_RESPONSE', 'Invalid AMap coordinate');
  const parts = value.split(','), lng = Number(parts[0]), lat = Number(parts[1]);
  if (!(parts.length === 2 && parts.every(p => p.trim()) && Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) providerFailed('INVALID_RESPONSE', 'Invalid AMap coordinate');
  return fromGcj({lat, lng});
}
function amount(value: string | number | undefined, field: string): number {
  const result = Number(value);
  if (!((typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(result) && result >= 0))
    providerFailed('INVALID_RESPONSE', `Invalid AMap ${field}`);
  return result;
}
function maneuver(orientation: string, instruction: string): NavStep['maneuver'] {
  const text = `${instruction} ${orientation}`;
  if (/掉头|调头|折返/.test(text)) return 'uturn';
  if (/左后方|向左急转|急左转|左急转/.test(text)) return 'sharp_left';
  if (/右后方|向右急转|急右转|右急转/.test(text)) return 'sharp_right';
  if (/左前方|稍向左|靠左/.test(text)) return 'slight_left';
  if (/右前方|稍向右|靠右/.test(text)) return 'slight_right';
  if (/左转|向左/.test(text)) return 'left';
  if (/右转|向右/.test(text)) return 'right';
  if (/到达|抵达/.test(text)) return 'arrive';
  if (/出发|起点/.test(text)) return 'depart';
  return 'straight';
}

function simplify(line:Point[],tolerance:number):Point[] {
  if(line.length<3)return line;
  const keep=new Set([0,line.length-1]),ranges=[[0,line.length-1]],metres=Math.PI/180*6371000;
  while(ranges.length){
    const [start,end]=ranges.pop()!,a=line[start!]!,b=line[end!]!,scale=Math.cos((a.lat+b.lat)/2*Math.PI/180);
    const dx=(b.lng-a.lng)*scale*metres,dy=(b.lat-a.lat)*metres,squared=dx*dx+dy*dy;
    let furthest=-1,distance=tolerance*tolerance;
    for(let i=start!+1;i<end!;i++){
      const p=line[i]!,x=(p.lng-a.lng)*scale*metres,y=(p.lat-a.lat)*metres;
      const t=squared?Math.max(0,Math.min(1,(x*dx+y*dy)/squared)):0,d=(x-t*dx)**2+(y-t*dy)**2;
      if(d>distance){distance=d;furthest=i;}
    }
    if(furthest>=0){keep.add(furthest);ranges.push([start!,furthest],[furthest,end!]);}
  }
  return line.filter((_,i)=>keep.has(i));
}

interface AmapResponse {
  status: string; infocode: string; info?: string;
  pois: {name: string; address: string; location: string}[];
  route: {paths: {distance: string; duration?: string; cost?: {duration: string}; steps: {
    instruction: string; orientation: string; road_name: string; step_distance: string | number; cost: {duration: string}; polyline: string;
  }[]}[]};
}
function providerFailed(code: string, reason: string, path?: string): never {
  const error = new NavigationProviderError(code, reason, path);
  if (/^\d{5}$/.test(code)) Object.assign(error, {infocode: code});
  console.error('NAVIGATION_PROVIDER_FAILED', {provider: 'amap', provider_code: code, provider_reason: reason, ...(path ? {provider_path: path} : {})});
  throw error;
}
function shortReason(reason: unknown, key: string): string {
  return (typeof reason === 'string' ? reason : 'AMap request failed').replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replaceAll(key, '[redacted]').replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

export function createAmapNavigation(options: {keyFile: string; fetch?: typeof fetch}): Navigation {
  let key: string;
  try {key = readFileSync(options.keyFile, 'utf8').trim();} catch (error) {providerFailed((error as NodeJS.ErrnoException).code ?? 'KEY_FILE_UNREADABLE', 'Cannot read AMap key file');}
  if (!key.length) providerFailed('EMPTY_KEY', 'AMap key file is empty');
  const fetcher = options.fetch ?? fetch;
  async function request(path: string, params: Record<string, string>): Promise<AmapResponse> {
    const url = new URL(path, 'https://restapi.amap.com');
    url.search = new URLSearchParams({...params, key}).toString();
    let response: Response, body: AmapResponse;
    const signal = AbortSignal.timeout(8_000);
    try {
      response = await fetcher(url, {signal});
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('AMap transport failed');
      const cause = (failure.cause ?? failure) as {code?: unknown; message?: unknown};
      const code = typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) ? cause.code : 'TRANSPORT_ERROR';
      providerFailed(signal.aborted ? 'TIMEOUT' : code, shortReason(signal.aborted ? 'AMap request timed out after 8000 ms' : cause.message ?? failure.message, key), path);
    }
    if (!response.ok) providerFailed(`HTTP_${response.status}`, shortReason(response.statusText || `HTTP ${response.status}`, key), path);
    try {body = await response.json() as AmapResponse;}
    catch {providerFailed('INVALID_JSON', 'AMap returned invalid JSON', path);}
    if (!body || typeof body !== 'object' || body.status !== '0' && body.status !== '1')
      providerFailed('INVALID_RESPONSE', 'Expected AMap v5 status (0 or 1)', path);
    if (body.status === '0') providerFailed(typeof body.infocode === 'string' && /^\d{5}$/.test(body.infocode) ? body.infocode : 'AMAP_ERROR', shortReason(body.info, key), path);
    return body;
  }
  return {
    async search(query, near) {
      const body = await request('/v5/place/text', {keywords: query, page_size: '5',
        ...(near ? {location: location(near)} : {})});
      if (!Array.isArray(body.pois)) providerFailed('INVALID_RESPONSE', 'Missing AMap pois');
      const places = body.pois.map(poi => {
        if (!poi || typeof poi.name !== 'string' || !poi.name.length) providerFailed('INVALID_RESPONSE', 'Invalid AMap poi.name');
        return {name: poi.name, ...(typeof poi.address === 'string' && poi.address ? {address: poi.address} : {}), ...point(poi.location)};
      });
      if (near) {
        const distance = (p: Point) => (p.lat-near.lat)**2 + ((p.lng-near.lng)*Math.cos(near.lat*Math.PI/180))**2;
        places.sort((a, b) => distance(a)-distance(b));
      }
      return places.slice(0, 5);
    },
    async plan(origin, destination, mode) {
      const body = await request(`/v5/direction/${mode}`, {origin: location(origin), destination: location(destination),
        show_fields: 'polyline,cost', alternative_route: '2'});
      const paths = body.route?.paths;
      if (!Array.isArray(paths)) providerFailed('INVALID_RESPONSE', 'Missing AMap route.paths');
      check(paths.length > 0, 'NAVIGATION_NO_ROUTE', 404);
      const routes: NavRoute[] = paths.slice(0, 2).map(path => {
        if (!path || !Array.isArray(path.steps)) providerFailed('INVALID_RESPONSE', 'Missing AMap route.paths[].steps');
        check(path.steps.length > 0, 'NAVIGATION_NO_ROUTE', 404);
        const steps: NavStep[] = path.steps.map((step, index) => {
          if (!step || typeof step.instruction !== 'string' || typeof step.polyline !== 'string' || !step.polyline.length)
            providerFailed('INVALID_RESPONSE', 'Invalid AMap step instruction/polyline');
          // Amap's instruction ends this segment, so its turn enters the next segment's road.
          const road = path.steps[index + 1]?.road_name, polyline = step.polyline.split(';').map(point);
          return {index, maneuver: maneuver(step.orientation, step.instruction), instruction: step.instruction,
            ...(typeof road === 'string' && road ? {road} : {}),
            distance_m: amount(step.step_distance, 'step_distance'), duration_s: amount(step.cost?.duration, 'step.cost.duration'), polyline, maneuver_location: polyline.at(-1)!};
        });
        steps.push({index: steps.length, maneuver: 'arrive', instruction: `到达${destination.name}`, distance_m: 0, duration_s: 0,
          polyline: [steps.at(-1)!.polyline.at(-1)!], maneuver_location: steps.at(-1)!.maneuver_location});
        return {total_m: amount(path.distance, 'path.distance'), total_s: amount(path.cost?.duration ?? path.duration, 'path duration'), steps};
      });
      // Both choices must fit: switching sends the alternate's full steps plus the other overview line.
      for (const tolerance of [5,10,15,20,25]) {
        const reduced = routes.map(route => ({...route, steps: route.steps.map(step => ({...step, polyline: simplify(step.polyline,tolerance)}))}));
        const fits = reduced.every((active, selected) => {
          const alternatives = reduced.filter((_, index) => index !== selected).map(route => ({
            total_m: route.total_m, total_s: route.total_s, polyline: route.steps.flatMap(step => step.polyline)}));
          const message = {schema_version: wire.schema, operation: 'nav_route', session_id: 's'.repeat(200), coordinate_system: 'wgs84',
            nav_id: '00000000-0000-4000-8000-000000000000', revision: Number.MAX_SAFE_INTEGER, mode,
            destination: {name: destination.name, lat: destination.lat, lng: destination.lng}, ...active,
            overview: {version: 1, selected, alternatives, show: false}};
          return Buffer.byteLength(JSON.stringify(message)) <= wire.output_limit;
        });
        if (fits) return {mode, destination, ...reduced[0]!, ...(reduced[1] ? {alternative: reduced[1]} : {})};
      }
      throw new ContractError('NAVIGATION_ROUTE_TOO_LONG',413);
    }
  };
}
