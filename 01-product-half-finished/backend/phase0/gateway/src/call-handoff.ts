import {check} from '../../../services/personal-aios-integration/src/contracts.ts';

export interface CallHandoff {difficulty:string;intent:string;thinking:'enabled'|'disabled'}
/** The realtime model owns this judgement; the host only validates and transports it. */
export const CALL_HANDOFF_TOOL={type:'function',name:'handoff_to_brain',
  description:'读取或核对依米自己的实时运行数据、记忆或私人记录，修改记忆或偏好，执行操作或深入推理时，先调用本工具再回应，不必先自己查或尝试回答。主脑有 self MCP：runtime_query 查通话、轮次、声纹识别结果和各通道相似度，runtime_status 查声音录入、记忆数量、配置和版本；还有历史对话、日程、提醒和行动工具。口头答应不会启动主脑，设置提醒、下单、预订等必须实际交接。只有请求的目标明确才能交接；“帮我查一下”这类没有查询目标的半句话，安静等主人补全或简短问查什么，不调用本工具。intent 保留本次请求原话，只判断一次难度和是否需要深入思考。闲聊、简单常识留在前台，公开实时信息先用 web_search，实际搜索不足也可交接。工具回执只表示收到请求，不含查询结果。交接后自然说等一下；收到本次 main_agent 结果前，不给出记录的数量、内容、时间或执行结果，不猜测、不举虚构记录作例子，不声称已经办好。',
  parameters:{type:'object',properties:{difficulty:{type:'string',description:'简短说明难点或为什么需要主脑'},
    intent:{type:'string',description:'主人要完成什么，保留关键条件'},
    thinking:{type:'string',enum:['enabled','disabled'],description:'深入推理用 enabled，直接查记录或执行明确请求可用 disabled；由本次问题决定'}},
    required:['difficulty','intent','thinking'],additionalProperties:false}};
export const CALL_SEARCH_TOOL={type:'function',name:'web_search',description:'只读联网搜索公开信息。前台自己查证并回答；结果不足时再交给主脑。',
  parameters:{type:'object',properties:{query:{type:'string',description:'包含地点、日期和所需事实的检索词'}},required:['query'],additionalProperties:false}};
export function callHandoff(value:unknown):CallHandoff {
  const note=value as CallHandoff;
  check(note&&typeof note==='object'&&!Array.isArray(note)&&Object.keys(note).length===3&&
    typeof note.difficulty==='string'&&note.difficulty.trim().length>0&&note.difficulty.length<=500&&
    typeof note.intent==='string'&&note.intent.trim().length>0&&note.intent.length<=4000&&
    ['enabled','disabled'].includes(note.thinking),'CALL_HANDOFF_INVALID',422);
  return {difficulty:note.difficulty.trim(),intent:note.intent.trim(),thinking:note.thinking};
}
