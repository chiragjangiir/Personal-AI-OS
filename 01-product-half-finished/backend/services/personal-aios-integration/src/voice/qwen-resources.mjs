import { createEmbeddedRealtimeSession, createFrontRealtimeSession, frontSees } from '../../../qwen-embedded/server/src/voice/embedded-realtime-session.mjs'
import { WebSocket as NodeWebSocket } from '../../../qwen-embedded/server/src/voice/node-websocket.mjs'
export { DASHSCOPE_DIALECTS } from '../../../qwen-embedded/shared/realtime-model-catalog.mjs'

const callVoice = configuration => ({ ...configuration, ...(configuration.call ? {
  model: configuration.call.model, voice: configuration.call.voice, dialect: configuration.call.dialect ?? configuration.dialect,
  transcription_model: configuration.call.transcription_model ?? configuration.transcription_model, expressive: configuration.call.expressive } : {}) })

// Dedicated text synthesis shares the existing Node WebSocket implementation, not a realtime chat session.
export function createQwenTtsTransport(configuration, synthesisEndpoint) {
  const endpoint = new URL(synthesisEndpoint ?? configuration.endpoint)
  if (!synthesisEndpoint) endpoint.pathname = '/api-ws/v1/inference'
  if (!synthesisEndpoint) endpoint.search = ''
  const WebSocket = configuration.WebSocket ?? NodeWebSocket
  return () => new WebSocket(endpoint.href, { headers: { Authorization: `Bearer ${configuration.apiKey}` } })
}

// The host supplies configuration and permission authorities. Construction opens no connection.
// `configuration.call` ({model, voice, expressive?}) selects the live call front's model and voice, and whether it speaks
// with fitting emotion (default on); without it the call runs on the push-to-talk front's model and voice.
export function createQwenVoiceResources({ configuration, authorizeWindow, authorizeFinal, recordConfirmation, hasConfirmation, recoverConfirmation, callTurns, classifyCall, searchCall, onError }) {
  configuration = configuration ? {...configuration, dialect: configuration.dialect ?? 'nested-audio', transcription_model: configuration.transcription_model ?? 'qwen3-asr-flash-realtime'} : undefined
  // A call on a different model than the front must name its own protocol dialect; it is never guessed from the front's.
  if (configuration?.call && !configuration.call.dialect && configuration.call.model !== configuration.model) throw new TypeError('call.dialect is required when call.model differs from model')
  const { call, ...front } = configuration ?? {}
  const callConfiguration = { ...callVoice(configuration ?? {}), expressive: call?.expressive !== false,
    manualTurns: call?.turn_manager?.enabled === true,
    ...(call?.silence_duration_ms !== undefined ? {silence_duration_ms: call.silence_duration_ms} : {}),
    ...(call?.session_options !== undefined ? {session_options: call.session_options} : {}) }
  const greeting = call?.greeting
  return {
    configured: configuration?.usable === true,
    authorizeWindow,
    authorizeFinal,
    ...(recordConfirmation ? { recordConfirmation } : {}),
    ...(hasConfirmation ? { hasConfirmation } : {}),
    ...(recoverConfirmation ? { recoverConfirmation } : {}),
    onError,
    ...(callTurns ? {frontTurns:callTurns} : {}),
    ...(classifyCall ? {classifyCall} : {}),
    ...(searchCall && call?.session_options?.enable_search !== false ? {searchCall} : {}),
    create: callbacks => createEmbeddedRealtimeSession({
      WebSocket: NodeWebSocket,
      ...front,
      ...callbacks,
      onError,
    }),
    // One live call = one limited-F front connection (instructions come from the call owner).
    createFront: callbacks => createFrontRealtimeSession({
      WebSocket: NodeWebSocket,
      ...callConfiguration,
      ...callbacks,
      onError: callbacks.onError ?? onError,
    }),
    /** Whether the live call front sees the call camera (its model takes image input). */
    frontVision: configuration?.usable === true && frontSees(callConfiguration.dialect),
    /** Whether 依米 speaks with fitting tone and emotion (config `call.expressive`, default on). */
    frontExpressive: callConfiguration.expressive,
    ...(call?.thinking_mode ? {thinkingMode: call.thinking_mode} : {}),
    ambientSilenceMs: call?.ambient_silence_ms ?? 25000,
    /** The pickup greeting ({enabled?, text?} from config `call.greeting`; absent = default on). */
    ...(greeting ? { frontGreeting: greeting } : {}),
  }
}
