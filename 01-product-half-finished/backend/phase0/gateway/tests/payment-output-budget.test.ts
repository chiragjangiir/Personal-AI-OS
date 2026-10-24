import test from 'node:test';
import assert from 'node:assert/strict';
import {DataPacketKind,RoomEvent} from '@livekit/rtc-node';
import {paymentWire} from '../src/personal-aios-payment-wire.ts';
import {createFormalTextIngress,FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';
import {packPaymentItems,PAYMENT_LIVE_LIMIT,PAYMENT_OUTPUT_LIMIT,PAYMENT_ENVELOPE_ID} from '../../../services/personal-aios-integration/src/payment/wire-budget.ts';

type Schema=Record<string,any>;
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
/** Include optional fields, longest enums, six-byte JSON escapes, and maximum array lengths. */
function maximum(schema:Schema):any {
  if(schema.$ref)return maximum(paymentWire.$defs[schema.$ref.split('/').at(-1)] as Schema);
  if('const' in schema)return schema.const;
  if(schema.enum)return schema.enum.reduce((a:unknown,b:unknown)=>bytes(a)>=bytes(b)?a:b);
  if(schema.oneOf)return schema.oneOf.map(maximum).reduce((a:unknown,b:unknown)=>bytes(a)>=bytes(b)?a:b);
  if(schema.type==='object')return Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,maximum(v as Schema)]));
  if(schema.type==='array')return Array.from({length:schema.maxItems},()=>maximum(schema.items));
  if(schema.type==='boolean')return false;
  if(schema.type==='null')return null;
  if(schema.type==='integer')return schema.maximum;
  if(schema.format==='paios-utc')return '9999-12-31T23:59:59.999Z';
  if(schema.pattern){
    if(schema.pattern==='^[A-Za-z0-9_-]+$')return 'a'.repeat(schema.maxLength);
    if(schema.pattern.includes('{0,199}'))return PAYMENT_ENVELOPE_ID;
    if(schema.pattern.includes('{43}'))return 'a'.repeat(43);
    if(schema.pattern.includes('{64}'))return 'a'.repeat(64);
    for(const prefix of ['pay-','pi-','apr-'])if(schema.pattern.startsWith('^'+prefix))return prefix+'f'.repeat(36);
    throw Error('Unhandled wire pattern: '+schema.pattern);
  }
  assert.equal(typeof schema.maxLength,'number');
  return '\u0000'.repeat(schema.maxLength);
}

test('Amendments 2 and 4: every maximum payment output and complete live snapshot fits 12288 bytes on the real formal serializer',async t=>{
  assert.equal(PAYMENT_OUTPUT_LIMIT,12288);
  const packets:Buffer[]=[],listeners=new Map<string,(...args:readonly unknown[])=>void>(),errors:unknown[]=[];
  const device={principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:[],channel:'fixture',consent_ref:'fixture',route_version:'fixture',output_modes:['text']};
  let deliver!:(body:Record<string,unknown>)=>Promise<void>,reply:Record<string,unknown>|undefined,replySent:(()=>void)|undefined;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>device,paymentDetach:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchReminders:async()=>()=>{},
    watchPayments:async(_source:unknown,send:typeof deliver,session:string)=>{assert.equal(session,PAYMENT_ENVELOPE_ID);deliver=send;return ()=>{};},
    paymentInput:async(_source:unknown,_body:unknown,session:string)=>{assert.equal(session,PAYMENT_ENVELOPE_ID);return reply;}};
  const capture=async(data:Uint8Array|string)=>{const packet=Buffer.from(data);packets.push(packet);if(JSON.parse(packet.toString()).operation==='payment_records')replySent?.();};
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal'}]]),
    on:(event:string,fn:(...args:readonly unknown[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),
    localParticipant:{publishData:capture,sendText:capture}};
  const ingress=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime:runtime as never,
    authority:{credentialForBootstrap:()=>({})} as never,max_packet_bytes:PAYMENT_OUTPUT_LIMIT,onError:error=>errors.push(error)});
  try{
    await ingress.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:PAYMENT_ENVELOPE_ID}} as never);
    for(const [operation,schema] of Object.entries(paymentWire.outputs)){
      const largest=maximum(schema as Schema) as Record<string,any>;
      const snapshotField=({payment_cards:'cards',payment_approvals:'approvals'} as Record<string,string>)[operation];
      if(snapshotField){
        assert.equal(largest.complete,true);assert.equal(largest[snapshotField].length,PAYMENT_LIVE_LIMIT);
        if(operation==='payment_cards')for(const count of [3,4]){
          const length=bytes({...largest,cards:Array(count).fill(largest.cards[0])});
          assert.ok(length>12288,`${count} maximum cards exceed the limit`);t.diagnostic(`${count} maximum cards: ${length} bytes (cannot fit)`);
        }
      }
      const field=({payment_records:'items',payment_record:'timeline'} as Record<string,string>)[operation];
      const body=field?{...largest,[field]:packPaymentItems(largest[field],items=>({...largest,[field]:items}),PAYMENT_ENVELOPE_ID)}:largest;
      if(operation==='payment_records'){
        reply=body;const sent=new Promise<void>(resolve=>{replySent=resolve;});
        listeners.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify({operation:'payment_records_get',request_id:PAYMENT_ENVELOPE_ID})),
          {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
        await sent;
      }else await deliver(body);
      const packet=packets.at(-1)!;assert.ok(packet.byteLength<=12288,`${operation}: ${packet.byteLength}`);
      const entries=snapshotField??field;
      t.diagnostic(`${operation}: ${packet.byteLength} bytes${entries?`, ${body[entries].length} complete entries`:''}`);
      assert.deepEqual(JSON.parse(packet.toString()),body,operation+' retains every field of every included item');
      if(field){
        assert.ok(body[field].length>0);
        if(body[field].length<largest[field].length){
          assert.ok(bytes({...body,[field]:largest[field].slice(0,body[field].length+1)})>12288,operation+' packs as many complete entries as fit');
        }
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await ingress.close();}
});
