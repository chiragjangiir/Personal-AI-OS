// Modified source derived from QwenAudio/qwen-audio-agent f6dd0e3703d58e4941159c1be89447f3fcb5063a: explicit host dependencies and lifecycle boundaries.
import { recentConversationMessages } from '../../../shared/conversation-history.mjs'
const MAX_RECENT_CHARS = 3500
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim() }
export function buildRecentConversationContext(messages = []) {
  const candidates = recentConversationMessages(messages)
  const selected = []
  let used = 0
  for (const message of candidates.toReversed()) {
    const content = clean(message.content)
    if (!content) continue
    const inputSummary = (message.inputs || []).map(input => [
      clean(input.ref),
      clean(input.label || input.filename || input.type),
      clean(input.filename),
      clean(input.mime),
    ].filter(Boolean).join(' · ')).filter(Boolean).join('；')
    const base = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    const line = inputSummary
      ? `${base}（可引用输入：${inputSummary}）`
      : base
    if (selected.length && used + line.length > MAX_RECENT_CHARS) break
    selected.unshift(line)
    used += line.length
  }
  if (!selected.length) return ''
  return [
    '<recent_conversation>',
    ...selected,
    '</recent_conversation>',
  ].join('\n')
}

