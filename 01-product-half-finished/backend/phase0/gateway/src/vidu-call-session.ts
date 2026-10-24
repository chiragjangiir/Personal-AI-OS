import {isAbsolute,resolve} from 'node:path';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {QwenTtsSocket} from '../../../services/personal-aios-integration/src/voice/qwen-resources.mjs';

export interface VideoCallConfiguration {provider:'vidu_component';api_key_file:string;base_url:string;avatar_id:string;component_model:string;action_library_id:string}
/** The same startup contract is enforced by resource loading and direct execution composition. */
export function assertVideoCallConfiguration(video:VideoCallConfiguration) {
  check(video&&typeof video==='object','PRODUCT_VIDEO_CALL_INVALID');
  check(video.provider==='vidu_component','PRODUCT_VIDEO_PROVIDER_UNSUPPORTED');
  check(Object.keys(video).every(key=>['provider','api_key_file','base_url','avatar_id','component_model','action_library_id'].includes(key))&&
    typeof video.api_key_file==='string'&&isAbsolute(video.api_key_file)&&video.api_key_file===resolve(video.api_key_file)&&
    [video.avatar_id,video.component_model,video.action_library_id].every(value=>typeof value==='string'&&value.trim().length>0),'PRODUCT_VIDEO_CALL_INVALID');
  check(typeof video.base_url==='string'&&URL.canParse(video.base_url)&&new URL(video.base_url).protocol==='https:'&&
    new URL(video.base_url).origin===video.base_url,'PRODUCT_VIDEO_BASE_URL_INVALID');
}
export type ViduSocket=QwenTtsSocket&{send(data:string|Buffer):void;close():void;terminate():void;ping():void;bufferedAmount:number};
export type ViduFrontLookup=(source:RegisteredDevice,input:{kind:'memory'|'knowledge';query:string;reason?:string;types?:string[];time_hint?:string;max_results?:number})=>
  Promise<{items:{id:string;text:string;type:string;confidence:number;updated_at:string;source:string}[]}>;
export type ViduRetrieval=Map<string,{live_id:string;source:RegisteredDevice;lookup:ViduFrontLookup}>;
// Vidu component type=9 accepts motion descriptions, not a closed gesture enum.
// Requested at readiness and estimated audio drain; no persistent idle or framing guarantee.
export const VIDU_IDLE_MOTION='面向镜头，头部保持画面中央，自然呼吸，轻微眨眼和细微姿态变化，动作幅度小';
export const VIDU_COMPONENT_RULES='数字人动作通过 avatar_gesture 发送自然语言动作描述，可请求表情、手势、身体动作等；实际效果受当前模型、形象和动作库影响，不保证每个动作都能实现。\n'+
  '决定做动作时，先调用工具再说话；工具没有确认发出就说明现在做不了，不能假装做了。\n'+
  '不支持的实时动作要如实说明，不能另生成视频代替；服装和外观由数字人形象配置处理，不通过动作工具更改。\n'+
  '动作发生在当前实时视频中。成功只表示动作指令已发出，没有动作完成回执，不能声称动作已经完成。';
export const VIDU_GESTURE_TOOL={type:'function',name:'avatar_gesture',description:'向当前数字人视频发送动作描述。接受动作请求时先调用；成功只表示已发出，不证明动作完成。',
  parameters:{type:'object',properties:{action:{type:'string',description:'自然语言描述当前视频中的动作，例如微笑、点头、挥手、转身或跳舞；效果需在实时画面中观察。'}},required:['action'],additionalProperties:false}};
