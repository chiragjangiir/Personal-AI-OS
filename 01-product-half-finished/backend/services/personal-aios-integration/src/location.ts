import Ajv2020Module from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {canonical, check, checkLocation, digest, utc, type CaptureLocation} from './contracts.ts';
import {inTransaction, openOwnerDatabase} from './owner-db.ts';
import {localDay} from './health/calendar.ts';

/** How long a device's latest fix locates what that device captures (a chat turn, a call, a wake turn heard on it). */
export const LOCATION_FRESH_MS = 15 * 60_000;
/** Navigation may start from a recent pocket fix, never an unbounded last-known position. */
export const NAVIGATION_LOCATION_FRESH_MS = 120_000;
const DEVICES = 64;
export const PLACE_RETENTION_MS = 90 * 86400_000;
export interface PlaceEvent {
  id:string;kind:'visit_arrival'|'visit_departure'|'region_enter'|'region_exit';sensor_at:string;location:CaptureLocation;
  arrival_at?:string;departure_at?:string;region_id?:string;
}
export interface PlaceBatch {schema:'paios.place-upload.v1';device_id:string;region_version?:number;events:PlaceEvent[]}
export interface PlaceRegion {id:string;label:string;latitude:number;longitude:number;radius_m:number}
const ajv=new Ajv2020Module.default({strict:false});
ajv.addFormat('paios-utc',{type:'string',validate:(value:string)=>{try{utc(value);return true;}catch{return false;}}});
ajv.addFormat('uuid',/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
const wire=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
ajv.addSchema({$id:wire.$id,$defs:{location:wire.$defs.location}});
const validateBatch=ajv.compile(JSON.parse(readFileSync(new URL('../../../contracts/json-schema/realtime/realtime-place-upload-request.v1.schema.json',import.meta.url),'utf8')));
export function checkPlaceUpload(value:unknown,now=Date.now()):asserts value is PlaceBatch {
  check(validateBatch(value),'PLACE_UPLOAD_INVALID');
  check(new Set((value as PlaceBatch).events.map(event=>event.id)).size===(value as PlaceBatch).events.length,'PLACE_EVENT_ID_DUPLICATE');
  for(const event of (value as PlaceBatch).events){
    utc(event.sensor_at);check(event.location.observed_at===event.sensor_at&&Date.parse(event.sensor_at)<=now,'PLACE_SENSOR_TIME_INVALID');
    if(event.kind==='visit_arrival')check(event.arrival_at===event.sensor_at,'PLACE_VISIT_TIME_INVALID');
    if(event.kind==='visit_departure')check(event.departure_at===event.sensor_at&&Date.parse(event.arrival_at!)<=Date.parse(event.departure_at),'PLACE_VISIT_TIME_INVALID');
  }
}
const DDL=`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS places(principal TEXT NOT NULL,id TEXT NOT NULL,device TEXT NOT NULL,sensor_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,region_id TEXT,label TEXT NOT NULL,data TEXT NOT NULL,admitted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(principal,id)) STRICT;
CREATE INDEX IF NOT EXISTS places_time ON places(principal,sensor_ms,id);
CREATE TABLE IF NOT EXISTS regions(principal TEXT NOT NULL,id TEXT NOT NULL,label TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,
  radius_m REAL NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(principal,id)) STRICT;`;

/** The one per-device latest-fix authority. Every fix a device sends — with a request, with a call_open, or as a location
 *  update while 随身模式 keeps the phone listening in a pocket — is recorded here, newest observation wins; the events that
 *  device captures carry it while it is fresh. In memory: after a restart the next fix the phone sends is the first. */
export class DeviceLocations {
  private readonly latest = new Map<string, {fix?:CaptureLocation;cachedAt?:number;lostAt?:number;reason?:string}>();
  private readonly now: () => number;
  private readonly db:DatabaseSync;private readonly timer:ReturnType<typeof setInterval>;
  constructor(now: () => number = Date.now,db?:DatabaseSync) {
    this.now=now;this.db=db??new DatabaseSync(':memory:');if(!db)this.db.exec(DDL);
    this.purge();this.timer=setInterval(()=>this.purge(),86400_000);this.timer.unref();
  }
  static open(directory:string,now:()=>number=Date.now):DeviceLocations {
    return new DeviceLocations(now,openOwnerDatabase(directory,'places.sqlite',DDL,'paios.places.v1','PLACE_STORE'));
  }
  close():void {clearInterval(this.timer);if(this.db.isOpen)this.db.close();this.latest.clear();}
  purge():number {return Number(this.db.prepare('DELETE FROM places WHERE sensor_ms < ?').run(this.now()-PLACE_RETENTION_MS).changes);}
  observe(principal: string, device: string, fix: CaptureLocation|null, reason?: string,cachedFixAgeMs?:number|null): void {
    const key = digest([principal, device]), known = this.latest.get(key);
    if(fix!==null)checkLocation(fix);
    if (fix && known?.fix && Date.parse(known.fix.observed_at) > Date.parse(fix.observed_at)) return;
    // A delayed fix or heartbeat from before the loss cannot make the provider current again.
    const value=fix===null?{...known,lostAt:this.now(),...(reason?{reason}:{}),
      ...(typeof cachedFixAgeMs==='number'?{cachedAt:Math.max(this.now()-cachedFixAgeMs,known?.cachedAt??-Infinity,known?.fix?Date.parse(known.fix.observed_at):-Infinity)}:{})}:{fix:structuredClone(fix),
      ...(known?.lostAt!==undefined&&Date.parse(fix.observed_at)<=known.lostAt?{lostAt:known.lostAt,cachedAt:known.cachedAt,...(known.reason?{reason:known.reason}:{})}:{})};
    this.latest.delete(key); this.latest.set(key, value);
    if (this.latest.size > DEVICES) this.latest.delete(this.latest.keys().next().value!);
  }
  /** The device's latest fix while fresh (observed within LOCATION_FRESH_MS of now), else none. */
  fresh(principal: string, device: string,maxAgeMs=LOCATION_FRESH_MS): CaptureLocation | undefined {
    const state = this.latest.get(digest([principal, device])),fix=state?.fix;
    const age=fix?this.now()-Date.parse(fix.observed_at):-1;
    return fix && state?.lostAt===undefined && age>=0 && age<=maxAgeMs ? structuredClone(fix) : undefined;
  }
  age(principal:string,device:string):number|null {
    const state=this.latest.get(digest([principal,device]));
    const observedAt=state?.cachedAt??(state?.fix?Date.parse(state.fix.observed_at):undefined);
    return observedAt===undefined?null:this.now()-observedAt;
  }
  /** Why the phone last said it has no fix (the device's own `unavailable_reason`), until a newer fix recovers it. */
  unavailableReason(principal:string,device:string):string|undefined {
    const state=this.latest.get(digest([principal,device]));
    return state?.lostAt!==undefined?state.reason:undefined;
  }
  /** Last known fix, including stale or lost observations; callers must show its observation time. */
  lastKnown(principal:string,device:string):CaptureLocation|undefined {
    const fix=this.latest.get(digest([principal,device]))?.fix;
    return fix?structuredClone(fix):undefined;
  }
  regions(principal:string,knownVersion?:number):{version:number;items?:PlaceRegion[]} {
    const version=Number((this.db.prepare('SELECT value FROM meta WHERE key=?').get(`regions:${principal}`) as {value:string}|undefined)?.value??0);
    return {version,...(knownVersion===version?{}:{items:this.db.prepare('SELECT id,label,latitude,longitude,radius_m FROM regions WHERE principal=? AND active=1 ORDER BY id').all(principal).map(row=>({...row})) as unknown as PlaceRegion[]})};
  }
  geofences(principal:string,args:Record<string,unknown>) {
    if(args.action==='list')return this.regions(principal);
    inTransaction(this.db,()=>{
      if(args.action==='set'){
        const region=args.region as PlaceRegion,known=this.db.prepare('SELECT id,label,latitude,longitude,radius_m FROM regions WHERE principal=? AND id=? AND active=1').get(principal,region.id);
        if(known&&canonical({...known})===canonical(region))return;
        check(known||(this.regions(principal).items!.length<18),'PLACE_REGION_LIMIT',409);
        this.db.prepare('INSERT INTO regions VALUES(?,?,?,?,?,?,1) ON CONFLICT(principal,id) DO UPDATE SET label=excluded.label,latitude=excluded.latitude,longitude=excluded.longitude,radius_m=excluded.radius_m,active=1')
          .run(principal,region.id,region.label,region.latitude,region.longitude,region.radius_m);
      }else{
        check(args.action==='remove','PLACE_REGION_ACTION_INVALID');
        if(!this.db.prepare('UPDATE regions SET active=0 WHERE principal=? AND id=? AND active=1').run(principal,args.region_id as string).changes)return;
      }
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`regions:${principal}`,String(this.regions(principal).version+1));
    });
    return this.regions(principal);
  }
  record(principal:string,device:string,batch:PlaceBatch) {
    checkPlaceUpload(batch,this.now());check(batch.device_id===device,'PLACE_DEVICE_MISMATCH',403);this.purge();
    const stored_ids:string[]=[],duplicate_ids:string[]=[],expired_ids:string[]=[],transitions:{event:PlaceEvent;label:string}[]=[];
    inTransaction(this.db,()=>{for(const event of batch.events){
      const data=canonical(event),known=this.db.prepare('SELECT device,data,label,admitted FROM places WHERE principal=? AND id=?').get(principal,event.id) as
        {device:string;data:string;label:string;admitted:number}|undefined;
      if(known){check(known.device===device&&known.data===data,'PLACE_EVENT_CONFLICT',409);duplicate_ids.push(event.id);}
      else {
        if(Date.parse(event.sensor_at)<this.now()-PLACE_RETENTION_MS){expired_ids.push(event.id);continue;}
        let place_id:string,label:string;
        if(event.region_id){
          const region=this.db.prepare('SELECT label FROM regions WHERE principal=? AND id=?').get(principal,event.region_id) as {label:string}|undefined;
          check(region,'PLACE_REGION_UNKNOWN',409);place_id=event.region_id;label=region.label;
        }else{
          // Sensor coordinates remain evidence; a visit's place is the closest containing managed region, else a ~100m cell.
          const distances=this.regions(principal).items!.map(region=>{const rad=Math.PI/180,fix=event.location;
            const a=Math.sin((fix.latitude-region.latitude)*rad/2)**2+Math.cos(fix.latitude*rad)*Math.cos(region.latitude*rad)*Math.sin((fix.longitude-region.longitude)*rad/2)**2;
            return {region,distance:2*6371000*Math.asin(Math.sqrt(Math.min(1,a)))};}).filter(item=>item.distance<=item.region.radius_m).sort((a,b)=>a.distance-b.distance);
          place_id=distances[0]?.region.id??`wgs84:${event.location.latitude.toFixed(3)},${event.location.longitude.toFixed(3)}`;
          label=distances[0]?.region.label??event.location.place??place_id;
        }
        this.db.prepare('INSERT INTO places(principal,id,device,sensor_ms,kind,region_id,label,data) VALUES(?,?,?,?,?,?,?,?)')
          .run(principal,event.id,device,Date.parse(event.sensor_at),event.kind,place_id,label,data);stored_ids.push(event.id);
      }
      if(event.region_id&&(!known||!known.admitted))transitions.push({event:structuredClone(event),label:known?.label??(this.db.prepare('SELECT label FROM places WHERE principal=? AND id=?').get(principal,event.id) as {label:string}).label});
    }});
    for(const event of batch.events)if(!expired_ids.includes(event.id))this.observe(principal,device,event.location);
    return {stored_ids,duplicate_ids,expired_ids,transitions};
  }
  admitted(principal:string,id:string):void {this.db.prepare('UPDATE places SET admitted=1 WHERE principal=? AND id=?').run(principal,id);}
  query(principal:string,args:Record<string,unknown>) {
    if(args.from!==undefined)utc(args.from);if(args.until!==undefined)utc(args.until);
    const now=this.now(),zone=args.time_zone as string,from=args.from===undefined?now-PLACE_RETENTION_MS:Date.parse(args.from as string),until=args.until===undefined?now+1:Date.parse(args.until as string);
    check(from<until&&until-from<=PLACE_RETENTION_MS+1,'PLACE_QUERY_RANGE_INVALID');
    let clock:Intl.DateTimeFormat;try{clock=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{check(false,'PLACE_TIME_ZONE_INVALID');}
    this.db.function('place_minute',(at)=>{if(at===null)return null;const parts=clock.formatToParts(new Date(String(at)));
      return Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value);});
    const cursor=(args.cursor as number|undefined)??0,limit=(args.limit as number|undefined)??50,place=(args.place_id as string|undefined)??null;
    let rows:Record<string,unknown>[];
    if(args.view==='transitions')rows=this.db.prepare("SELECT id,device,region_id AS place_id,label,data FROM places WHERE principal=? AND kind IN ('region_enter','region_exit') AND sensor_ms>=? AND sensor_ms>=? AND sensor_ms<? AND (? IS NULL OR region_id=?) ORDER BY sensor_ms,id LIMIT ? OFFSET ?")
      .all(principal,now-PLACE_RETENTION_MS,from,until,place,place,limit+1,cursor).map(row=>({id:row.id,device_id:row.device,place_id:row.place_id,label:row.label,...JSON.parse(row.data as string)}));
    else {
      const visits=`WITH visits AS (SELECT device,json_extract(data,'$.arrival_at') AS arrival_at,
        MAX(json_extract(data,'$.departure_at')) AS departure_at,
        COALESCE(MAX(CASE WHEN kind='visit_arrival' THEN region_id END),MAX(region_id)) AS place_id,
        COALESCE(MAX(CASE WHEN kind='visit_arrival' THEN label END),MAX(label)) AS label,
        COALESCE(MAX(CASE WHEN kind='visit_arrival' THEN json_extract(data,'$.location') END),MAX(json_extract(data,'$.location'))) AS location,
        CAST(round((julianday(json_extract(data,'$.arrival_at'))-2440587.5)*86400000) AS INTEGER) AS arrival_ms
        FROM places WHERE principal=? AND kind IN ('visit_arrival','visit_departure') AND sensor_ms>=? GROUP BY device,arrival_at),
        selected AS (SELECT * FROM visits WHERE arrival_ms<? AND (departure_at IS NULL OR round((julianday(departure_at)-2440587.5)*86400000)>=?) AND (? IS NULL OR place_id=?))`;
      const parameters=[principal,now-PLACE_RETENTION_MS,until,from,place,place,limit+1,cursor];
      if(args.view==='visits')rows=this.db.prepare(`${visits} SELECT device AS device_id,place_id,label,arrival_at,departure_at,location FROM selected ORDER BY arrival_ms,device LIMIT ? OFFSET ?`)
        .all(...parameters).map(row=>({...row,day:localDay(Date.parse(row.arrival_at as string),zone),location:JSON.parse(row.location as string)}));
      else rows=this.db.prepare(`${visits} SELECT place_id,MAX(label) AS label,count(*) AS visits,count(departure_at) AS completed_visits,
        MIN(arrival_at) AS first_arrival_at,MAX(arrival_at) AS last_arrival_at,
        avg(place_minute(arrival_at)) AS mean_arrival_minute,avg(place_minute(departure_at)) AS mean_departure_minute,
        avg((julianday(departure_at)-julianday(arrival_at))*1440) AS mean_duration_min FROM selected GROUP BY place_id ORDER BY place_id LIMIT ? OFFSET ?`).all(...parameters)
        .map(({first_arrival_at,last_arrival_at,...row})=>({...row,first_day:localDay(Date.parse(first_arrival_at as string),zone),last_day:localDay(Date.parse(last_arrival_at as string),zone)}));
    }
    return {view:args.view,time_zone:zone,range_semantics:args.view==='transitions'?'sensor_time':'visit_overlap_departure_unknown_if_null',from:new Date(from).toISOString(),until:new Date(until).toISOString(),items:rows.slice(0,limit),next_cursor:rows.length>limit?cursor+limit:null};
  }
  forget(principal:string) {
    const deleted=Number(this.db.prepare('DELETE FROM places WHERE principal=?').run(principal).changes);
    return {status:'forgotten',deleted_events:deleted};
  }
}
