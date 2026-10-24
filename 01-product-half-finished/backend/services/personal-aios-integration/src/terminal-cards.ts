import {randomUUID} from 'node:crypto';
import {check,digest,id,voiceEvidence,type ProcessedEvent} from './contracts.ts';
import {hasTerminalCapability,terminalCapabilities,type RegisteredDevice,type TerminalCapability} from './source-authority.ts';

export interface TerminalGesture {card_id:string;kind:'nod'|'shake'|'tap';answer?:string}
export interface TerminalOption {id:string;label:string;lines:string[];recommended?:boolean}
export interface TerminalQuestion {card_id:string;options:TerminalOption[];question?:string;intent?:'ride';expires_at:string}
export interface TerminalCallOffer {offer_id:string;call_id:string;text:string;expires_at:string}
export interface TerminalLease {lease_id:string;approved_at:number;max_until:number;lock_cycle:number}
export interface TerminalWearSession {connection:object;since:number;wear:object;lock_cycle?:number}
export interface TerminalPersonHint {person_ref:string;name:string}
/** Ephemeral connection/wear authority. Taking off or reconnecting ends voice trust and pending interactions. */
export class TerminalCards {
  private readonly connections=new Map<string,{worn:boolean;since:number;owner:boolean;wear:object;lock_cycle?:number;lease?:TerminalLease}>();
  private readonly cards=new Map<string,{source:string;session:string;connection:object;kind:'question'|'call';card:TerminalQuestion|TerminalCallOffer;answering?:boolean}>();
  private readonly now:()=>number;
  constructor(now:()=>number=()=>Date.now()) {this.now=now;}
  private source(source:RegisteredDevice):string {
    check(hasTerminalCapability(source,'display'),'TERMINAL_DISPLAY_REQUIRED',403);
    return digest({principal_id:source.principal_id,device_id:source.device_id});
  }
  connect(source:RegisteredDevice,session:string):()=>void {
    const key=this.source(source);id(session);this.clear(key);
    const connection={worn:!hasTerminalCapability(source,'wear_state'),since:this.now(),owner:false,wear:{}};
    this.connections.set(key,connection);
    return ()=>{if(this.connections.get(key)===connection){this.connections.delete(key);this.clear(key);}};
  }
  private clear(key:string):void {const connection=this.connections.get(key);if(connection)delete connection.lease;for(const [id,card] of this.cards)if(card.source===key)this.cards.delete(id);}
  available(source:RegisteredDevice):boolean {
    return !hasTerminalCapability(source,'wear_state') || this.connections.get(digest({principal_id:source.principal_id,device_id:source.device_id}))?.worn===true;
  }
  wear(source:RegisteredDevice,worn:boolean,lock_cycle?:number):{worn:boolean;owner_verified:boolean} {
    const key=this.source(source);check(hasTerminalCapability(source,'wear_state'),'WEAR_STATE_DEVICE_REQUIRED',403);
    check(typeof worn==='boolean','WEAR_STATE_INVALID');const connection=this.connections.get(key);check(connection,'TERMINAL_NOT_CONNECTED',409);
    check(lock_cycle===undefined||Number.isSafeInteger(lock_cycle)&&lock_cycle>=0,'WEAR_STATE_INVALID');
    if(lock_cycle!==undefined&&connection.lock_cycle!==undefined&&lock_cycle<connection.lock_cycle)return {worn:connection.worn,owner_verified:connection.owner};
    if(!worn||!connection.worn||lock_cycle!==connection.lock_cycle){connection.owner=false;connection.since=this.now();connection.wear={};this.clear(key);}
    if(lock_cycle===undefined)delete connection.lock_cycle;else connection.lock_cycle=lock_cycle;
    connection.worn=worn;return {worn,owner_verified:connection.owner};
  }
  connectionIdentity(source:RegisteredDevice):object|undefined {
    return this.connections.get(digest({principal_id:source.principal_id,device_id:source.device_id}));
  }
  connected(source:RegisteredDevice):boolean {return this.connections.has(this.source(source));}
  wearSession(source:RegisteredDevice):TerminalWearSession|undefined {
    const connection=this.connections.get(this.source(source));
    return connection?.worn?{connection,since:connection.since,wear:connection.wear,...(connection.lock_cycle===undefined?{}:{lock_cycle:connection.lock_cycle})}:undefined;
  }
  requestCycle(source:RegisteredDevice,lock_cycle:number):void {
    check(Number.isSafeInteger(lock_cycle)&&lock_cycle>=0,'PAYMENT_LOCK_CYCLE_INVALID');
    const connection=this.connections.get(this.source(source));
    check(connection?.worn&&connection.lock_cycle!==undefined,'GLASSES_NOT_WORN',409);
    check(lock_cycle>=connection.lock_cycle,'APPROVAL_WEAR_CHANGED',409);
    if(lock_cycle!==connection.lock_cycle){this.lock(source);connection.lock_cycle=lock_cycle;}
  }
  grantLease(source:RegisteredDevice,binding:TerminalWearSession,max_until:number,lease_id=`lease-${randomUUID()}`):TerminalLease {
    const connection=this.connections.get(this.source(source));
    check(connection&&connection===binding.connection&&connection.worn&&connection.since===binding.since&&connection.wear===binding.wear&&connection.lock_cycle!==undefined&&connection.lock_cycle===binding.lock_cycle,'APPROVAL_WEAR_CHANGED',409);
    const lease={lease_id,approved_at:this.now(),max_until,lock_cycle:connection.lock_cycle!};connection.lease=lease;return {...lease};
  }
  lease(source:RegisteredDevice):TerminalLease|undefined {
    const connection=this.connections.get(this.source(source));
    if(connection?.lease&&(!connection.worn||this.now()>=connection.lease.max_until))delete connection.lease;
    return connection?.lease?{...connection.lease}:undefined;
  }
  // Invalidate pending approvals even when screen-off shares the request timestamp.
  lock(source:RegisteredDevice):TerminalLease|undefined {
    const connection=this.connections.get(this.source(source)),lease=connection?.lease;
    if(connection){delete connection.lease;connection.wear={};}return lease?{...lease}:undefined;
  }
  requireOwner(source:RegisteredDevice):void {
    check(hasTerminalCapability(source,'chat_ui')||this.available(source)&&
      this.connections.get(digest({principal_id:source.principal_id,device_id:source.device_id}))?.owner,'TERMINAL_OWNER_VOICE_REQUIRED',403);
  }
  verifiedVoice(source:RegisteredDevice,d:ProcessedEvent):void {
    const connection=this.connections.get(digest({principal_id:source.principal_id,device_id:source.device_id}));
    if(!connection?.worn || !hasTerminalCapability(source,'wear_state') || d.device_id!==source.device_id || d.principal_id!==source.principal_id || voiceEvidence(d)!=='owner')return;
    const start=d.time_range.timebase_id==='utc_epoch_ms'?(d.time_range.kind==='interval'?d.time_range.start_ms:d.time_range.at_ms):Date.parse(d.captured_at);
    if(start>=connection.since)connection.owner=true;
  }
  private store(source:RegisteredDevice,session:string,kind:'question'|'call',card:TerminalQuestion|TerminalCallOffer):void {
    const key=this.source(source),connection=this.connections.get(key);id(session);
    check(connection&&this.available(source),'TERMINAL_NOT_AVAILABLE',409);
    for(const [id,value] of this.cards)if(Date.parse(value.card.expires_at)<=this.now()||value.source===key)this.cards.delete(id);
    this.cards.set('card_id' in card?card.card_id:card.offer_id,{source:key,session,connection,kind,card});
  }
  issue(source:RegisteredDevice,options:TerminalOption[],session:string,question?:string,intent?:'ride'):TerminalQuestion {
    check(intent===undefined||intent==='ride','GLASSES_GESTURE_SCOPE_DENIED',403);
    const short=(text:unknown,max:number)=>typeof text==='string'&&text.trim().length>0&&!/[\r\n]/.test(text)&&Array.from(text).length<=max;
    check(Array.isArray(options)&&options.length>=2&&options.length<=5&&options.every(option=>option&&
      Object.keys(option).every(key=>['id','label','lines','recommended'].includes(key))&&short(option.label,200)&&
      Array.isArray(option.lines)&&option.lines.length<=3&&option.lines.every(line=>short(line,80))&&
      (option.recommended===undefined||typeof option.recommended==='boolean')),'TERMINAL_OPTIONS_INVALID');
    options.forEach(option=>id(option.id));
    check(new Set(options.map(option=>option.id)).size===options.length&&options.filter(option=>option.recommended).length<=1,'TERMINAL_OPTIONS_INVALID');
    check(question===undefined||short(question,200),'GLASSES_GESTURE_TEXT_INVALID');
    check(intent===undefined||options.length===2&&options.some(option=>option.id==='yes')&&options.some(option=>option.id==='no'),'GLASSES_GESTURE_SCOPE_DENIED',403);
    const card:TerminalQuestion={card_id:`gesture:${randomUUID()}`,options:structuredClone(options),...(question===undefined?{}:{question}),...(intent===undefined?{}:{intent}),expires_at:new Date(this.now()+30000).toISOString()};
    this.store(source,session,'question',card);return structuredClone(card);
  }
  private pending(source:RegisteredDevice,id:string,kind:'question'|'call') {
    const key=this.source(source),pending=this.cards.get(id),connection=this.connections.get(key);
    check(pending&&pending.source===key&&pending.kind===kind&&pending.connection===connection,'GLASSES_GESTURE_CARD_REQUIRED',403);
    check(Date.parse(pending.card.expires_at)>this.now(),'GLASSES_GESTURE_CARD_EXPIRED',410);
    check(this.available(source),'TERMINAL_NOT_AVAILABLE',409);
    return {pending,owner:connection!.owner};
  }
  async answer<T>(source:RegisteredDevice,gesture:TerminalGesture,submit:(answer:{card:TerminalQuestion;session:string;owner:boolean;text:string;answer:string})=>Promise<T>):Promise<T> {
    check(!hasTerminalCapability(source,'chat_ui'),'GLASSES_GESTURE_DEVICE_REQUIRED',403);
    check(gesture && Object.keys(gesture).every(k=>['card_id','kind','answer'].includes(k)) &&
      (gesture.kind==='nod'&&(gesture.answer===undefined||gesture.answer==='yes')||gesture.kind==='shake'&&(gesture.answer===undefined||gesture.answer==='no')||
        gesture.kind==='tap'&&typeof gesture.answer==='string'),
      'GLASSES_GESTURE_INVALID');
    const {pending,owner}=this.pending(source,gesture.card_id,'question'),card=pending.card as TerminalQuestion,
      answer=gesture.answer??(gesture.kind==='nod'?'yes':'no');
    const option=card.options.find(option=>option.id===answer),binary=card.options.length===2&&card.options.some(option=>option.id==='yes')&&card.options.some(option=>option.id==='no');
    check(option&&(gesture.kind==='tap'||binary),'GLASSES_GESTURE_INVALID');
    check(!pending.answering,'GLASSES_GESTURE_PENDING',409);pending.answering=true;
    try {const result=await submit({card,session:pending.session,owner,text:binary?option.label:`就选第${card.options.indexOf(option)+1}项：${option.label}`,answer});
      if(this.cards.get(gesture.card_id)===pending)this.cards.delete(gesture.card_id);return result;
    }finally{pending.answering=false;}
  }
  offer(source:RegisteredDevice,text:string,session:string):TerminalCallOffer {
    check(hasTerminalCapability(source,'microphone'),'VOICE_CALL_DEVICE_REQUIRED',403);
    check(typeof text==='string'&&text.trim().length>0&&Array.from(text).length<=200,'CALL_OFFER_TEXT_INVALID');
    const uuid=randomUUID(),offer={offer_id:`offer:${uuid}`,call_id:`offer-call:${uuid}`,text,expires_at:new Date(this.now()+30000).toISOString()};
    this.store(source,session,'call',offer);return {...offer};
  }
  answerOffer(source:RegisteredDevice,offer:string,answer:'accept'|'decline'):TerminalCallOffer|undefined {
    check(['accept','decline'].includes(answer),'CALL_OFFER_ANSWER_INVALID');
    const {pending}=this.pending(source,offer,'call');this.cards.delete(offer);return answer==='accept'?{...pending.card as TerminalCallOffer}:undefined;
  }
  close():void {this.cards.clear();this.connections.clear();}
}

/** One flat card for terminals with a display and no chat UI; commands retain producer identities. */
export function terminalDisplayCard(device: {device_type:string;capabilities?:readonly TerminalCapability[]},
  body: Record<string,unknown>&{operation:string}): (Record<string,unknown>&{operation:string})|undefined {
  const capabilities = terminalCapabilities(device);
  if (!capabilities.includes('display') || capabilities.includes('chat_ui')) return undefined;
  const cardId = (identity:unknown) => `card-${digest({session_id:body.session_id,operation:body.operation,identity})}`;
  const remaining = () => Math.max(0,Math.min(30000,Date.parse(body.expires_at as string)-Date.now()));
  const action = (actionId:string,label:string,command:Record<string,unknown>) => ({id:actionId,label,command});
  const card:Record<string,unknown>&{operation:string} = {operation:'display_card',session_id:body.session_id,
    card_id:'',title:'依米',lines:[],priority:'normal',lifetime_ms:30000};
  switch (body.operation) {
    case 'text_chunk': {
      const chunk=body.chunk as Record<string,unknown>;
      Object.assign(card,{card_id:cardId([body.processed_event_id,chunk.reply_epoch,chunk.seq]),lines:[chunk.text],lifetime_ms:120000,
        delivery:{processed_event_id:body.processed_event_id,...Object.fromEntries(
          ['output_id','reply_id','reply_epoch','target_device_id','route_version','seq','final'].map(key=>[key,chunk[key]]))}});
      break;
    }
    case 'ambient_reply':
      Object.assign(card,{card_id:cardId(body.processed_event_id),title:body.reminder_id?'提醒':'依米',
        lines:[body.text],lifetime_ms:15000});
      break;
    case 'care_checkin':
      Object.assign(card,{card_id:cardId(body.care_id),title:'安全确认',lines:[body.text],priority:'high',
        actions:[action('safe','我安全',{operation:'care_safe',control_id:`care-${digest({session_id:body.session_id,care_id:body.care_id})}`})]});
      break;
    case 'errand_progress': {
      const errands = body.errands as {job_id:string;title:string;state:string;step:number;max_steps:number}[];
      const states:Record<string,string> = {waiting:'等待中',running:'进行中',stopping:'停止中'};
      Object.assign(card,{card_id:cardId('errands'),title:errands.length===1?errands[0]!.title:'代办进度',
        lines:errands.map(job=>`${job.title} · ${states[job.state]} ${job.step}/${job.max_steps}`),
        lifetime_ms:errands.length?60000:0});
      if (errands.length) Object.assign(card,{
        progress:{current:errands.reduce((sum,job)=>sum+job.step,0),total:errands.reduce((sum,job)=>sum+job.max_steps,0)},
        actions:errands.map(job=>action(`cancel-${job.job_id}`,`取消${job.title}`,{operation:'errand_cancel',job_id:job.job_id}))});
      break;
    }
    case 'call_transcript': {
      const roles:Record<string,string> = {user:'你',assistant:'依米',main_agent:'主助手'};
      Object.assign(card,{card_id:cardId([body.call_id,body.turn,body.role]),title:roles[body.role as string],
        lines:[body.text],lifetime_ms:8000,caption:{role:body.role,turn:body.turn}});
      break;
    }
    case 'gesture_card': {
      const options=body.options as TerminalOption[];
      Object.assign(card,{card_id:body.card_id,title:'请选择',lines:body.question?[body.question]:[],lifetime_ms:remaining(),
        actions:[...options].sort((a,b)=>Number(Boolean(b.recommended))-Number(Boolean(a.recommended))).map(option=>({
          ...action(option.id,option.recommended?`推荐 · ${option.label}`:option.label,
            {operation:'card_answer',card_id:body.card_id,kind:'tap',answer:option.id}),lines:option.lines}))});
      break;
    }
    case 'call_offer':
      Object.assign(card,{card_id:body.offer_id,title:'依米来电',lines:[body.text],priority:'high',lifetime_ms:remaining(),
        actions:['accept','decline'].map(answer=>action(answer,answer==='accept'?'接听':'拒绝',
          {operation:'call_offer_answer',offer_id:body.offer_id,answer}))});
      break;
    default: return undefined;
  }
  return card;
}
