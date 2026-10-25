import {check,utc,type RawEvent,EVENT_SCHEMA,canonical} from './contracts.ts';
import type {RegisteredDevice} from './source-authority.ts';

export interface WechatPreview {id:string;chat:string;subtitle:string;body:string;delivered_at:string}
export interface WechatPreviewBatch {device_id:string;batch_id:string;previews:WechatPreview[]}
/** This trust boundary accepts notification evidence, never a recipient or an owner instruction. */
export function wechatPreviewBatch(value:unknown):WechatPreviewBatch {
  const batch=value as WechatPreviewBatch;
  check(batch&&typeof batch==='object'&&!Array.isArray(batch)&&
    Object.keys(batch).sort().join(',')==='batch_id,device_id,previews'&&
    typeof batch.device_id==='string'&&batch.device_id.length>0&&batch.device_id.length<=200&&
    typeof batch.batch_id==='string'&&/^[A-Za-z0-9_-]{1,100}$/u.test(batch.batch_id)&&
    Array.isArray(batch.previews)&&batch.previews.length>0&&batch.previews.length<=20,'WECHAT_PREVIEWS_INVALID',422);
  const previews=batch.previews.map(preview=>{
    check(preview&&typeof preview==='object'&&!Array.isArray(preview)&&
      Object.keys(preview).sort().join(',')==='body,chat,delivered_at,id,subtitle'&&
      typeof preview.id==='string'&&/^[a-f0-9]{32}$/iu.test(preview.id)&&
      typeof preview.chat==='string'&&preview.chat.trim().length>0&&preview.chat.length<=256&&
      typeof preview.subtitle==='string'&&preview.subtitle.length<=512&&
      typeof preview.body==='string'&&preview.body.length<=8192&&typeof preview.delivered_at==='string',
      'WECHAT_PREVIEWS_INVALID',422);
    utc(preview.delivered_at);
    return {...preview,id:preview.id.toLowerCase()};
  });
  check(new Set(previews.map(preview=>preview.id)).size===previews.length,'WECHAT_PREVIEWS_INVALID',422);
  return {...batch,previews};
}
export function wechatPreviewEvent(preview:WechatPreview,source:RegisteredDevice):RawEvent {
  return {schema_version:EVENT_SCHEMA,event_id:`wechat-preview:${source.device_id}:${preview.id}`,
    device_id:source.device_id,device_type:source.device_type,captured_at:preview.delivered_at,
    source:{channel:source.channel},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(canonical({kind:'wechat_notification_preview',...preview}))};
}
