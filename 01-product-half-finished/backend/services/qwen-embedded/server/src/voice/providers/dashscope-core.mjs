// Modified source derived from QwenAudio/qwen-audio-agent f6dd0e3703d58e4941159c1be89447f3fcb5063a: explicit host dependencies and lifecycle boundaries.
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import { dashScopeDialectProfile } from '../../../../shared/realtime-model-catalog.mjs'
import { isRecoverableRealtimeInactivityError, RealtimeConfigurationError } from '../realtime-errors.mjs'
import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

export function createDashscopeProvider({ config, realtimeUrl, buildFrontendInstructions,
  frontendTools, resultResponseInstructions, speakResponseInstructions, permissionResponseInstructions, fetcher = fetch }) {
function classifyError(message) {
  if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
  // DashScope exposes one response slot per realtime session. A gateway
  // response can race the tail of another model/tool response before its
  // lifecycle events reach us; let RealtimeFrontend replay it after idle.
  if (/another response is in progress|cannot create response while .*response.*in progress/i.test(message)) {
    return 'response_slot_busy'
  }
  if (/user is speaking/i.test(message)) return 'input_busy'
  if (/already has (?:a pending response request|an active response)|another response is in progress/i.test(message)) {
    return 'response_slot_busy'
  }
  if (/no active response/i.test(message)) return 'no_active_response'
  if (
    /data[_ -]?inspection[_ -]?failed|ip[_ -]?infringement[_ -]?suspect/i.test(message)
    || /inappropriate content|content[_ -]?(?:filter|moderation|safety|policy)/i.test(message)
    || /(?:input|output) data may contain/i.test(message)
  ) return 'content_safety'
  if (
    /invalid[_ -]?api[_ -]?key|incorrect api key|authentication failed|unauthorized|unexpected server response: (?:401|403)/i
      .test(message)
    || /\barrearage\b|account is not in good standing/i.test(message)
    || /allocationquota\.freetieronly|free allocated quota exceeded|free tier .* exhausted/i
      .test(message)
    || /model(?:\.|_)?accessdenied|model[_ -]?not[_ -]?found/i.test(message)
  ) return 'fatal'
  return 'other'
}

function activeModelProfile() {
  return dashScopeDialectProfile(config.audioModel, config.audioDialect, config.audioVoice)
}

function responseModalities(profile) {
  const capabilities = profile.modelCapabilities
  return [
    capabilities.textOutput ? 'text' : null,
    capabilities.audioOutput ? 'audio' : null,
  ].filter(Boolean)
}

function validateSessionOptions() {
  if (new URL(config.audioRealtimeBaseUrl).protocol !== 'wss:') throw new RealtimeConfigurationError('Realtime endpoint must use wss')
}

const dashscopeProvider = {
  key: 'dashscope',
  label: 'DashScope Realtime',
  aliases: ['qwen'],
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  protocol: openAiCompatibleProtocol,

  get capabilities() {
    return {
      perResponseInstructions: true,
      singleResponseSlot: true,
      sessionOutputVoice: true,
      conversationItemIdEcho: activeModelProfile().dialectCapabilities.conversationItemIdEcho,
      imageRequiresAudioStart: true,
    }
  },

  model: () => config.audioModel,
  modelProfile: activeModelProfile,
  voice: () => config.audioVoice,
  isConfigured: () => Boolean(config.dashscopeApiKey),
  missingConfigurationMessage: '请先配置 DASHSCOPE_API_KEY',
  connectTimeoutMessage: '连接 Qwen Audio Realtime 超时',

  url: () => realtimeUrl(config.audioRealtimeBaseUrl, config.audioModel),
  headers: () => ({ Authorization: `Bearer ${config.dashscopeApiKey}` }),
  requireBeijing() {
    if (config.region !== 'cn-beijing') throw new Error('VISION_EMBEDDING_REQUIRES_BEIJING')
  },
  async postJSON(path, body, maximumBytes, signal) {
    const response = await fetcher(Object.assign(new URL(path, config.audioRealtimeBaseUrl), { protocol: 'https:' }), {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...dashscopeProvider.headers() },
      body: JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]),
    })
    if (!response.ok) throw new Error(`VISION_EMBEDDING_HTTP_${response.status}`)
    if (!response.body) throw new Error('VISION_EMBEDDING_BODY_REQUIRED')
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > maximumBytes) {
          await reader.cancel()
          throw new Error('VISION_EMBEDDING_RESPONSE_TOO_LARGE')
        }
        chunks.push(Buffer.from(part.value))
      }
    } finally { reader.releaseLock() }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  },

  classifyError,
  validateSessionOptions,

  buildSession: ({ configured, agentContext, sessionOptions }) => {
    const profile = activeModelProfile()
    const sessionVoice = String(sessionOptions?.voice || '').trim()
    const session = {
      instructions: buildFrontendInstructions(agentContext),
    }
    if (profile.modelCapabilities.functionCalling) {
      session.tools = frontendTools(agentContext)
    }
    if (!configured) {
      session.modalities = responseModalities(profile)
      if (profile.dialectCapabilities.nestedAudio) {
        // Keep the client audio contract unchanged: mono PCM16, 16 kHz in /
        // 24 kHz out. 3.8 uses the nested audio configuration on first setup only.
        session.audio = {
          input: { format: { type: 'pcm', sample_rate: dashscopeProvider.inputSampleRate } },
          output: {
            format: { type: 'pcm', sample_rate: dashscopeProvider.outputSampleRate },
            voice: sessionVoice || dashscopeProvider.voice(),
          },
        }
      } else {
        if (profile.modelCapabilities.audioOutput) {
          session.voice = sessionVoice || dashscopeProvider.voice()
          session.output_audio_format = 'pcm'
        }
        if (profile.transportCapabilities.audioInput) {
          session.input_audio_format = 'pcm'
        }
      }
      session.turn_detection = profile.transportCapabilities.audioInput
        ? profile.sessionDefaults.turnDetection
        : null
    }
    return session
  },

  buildSpeakResponse: content => ({
    conversation: 'none',
    modalities: responseModalities(activeModelProfile()),
    instructions: speakResponseInstructions(content),
  }),

  buildResultInjection: (content, { allowTools = false } = {}) => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
    response: {
      modalities: responseModalities(activeModelProfile()),
      tool_choice: allowTools ? 'auto' : 'none',
      instructions: resultResponseInstructions,
    },
  }),

  buildPermissionInjection: permission => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          '<permission_request>',
          `permission_id=${permission.id}`,
          `task_id=${permission.taskId}`,
          `operation=${permission.summary}`,
          `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
          '</permission_request>',
        ].join('\n'),
      }],
    },
    response: {
      modalities: responseModalities(activeModelProfile()),
      tool_choice: 'none',
      instructions: permissionResponseInstructions,
    },
  }),
}

return dashscopeProvider
}
