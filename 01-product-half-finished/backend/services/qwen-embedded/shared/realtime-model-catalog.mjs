const OMNI_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: true, videoInput: true,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const OMNI_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false,
  imageBufferInput: true,
})
const LEGACY_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, videoInput: false,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const LEGACY_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false,
  imageBufferInput: false,
})
// Protocol capabilities are selected by deployment config, independently of the model identifier.
export const DASHSCOPE_DIALECTS = Object.freeze({
  'nested-audio': Object.freeze({nestedAudio: true, imageBufferInput: true,
    speechEmotion: false, conversationItemIdEcho: false, turnDetection: Object.freeze({type: 'semantic_vad'})}),
  'flat-smart-turn': Object.freeze({nestedAudio: false, imageBufferInput: false,
    speechEmotion: true, conversationItemIdEcho: true, turnDetection: Object.freeze({type: 'smart_turn'})}),
  'flat-semantic-vad': Object.freeze({nestedAudio: false, imageBufferInput: true,
    speechEmotion: false, conversationItemIdEcho: false, turnDetection: Object.freeze({type: 'semantic_vad'})}),
})
export function dashScopeDialectProfile(model, dialect, voice) {
  const capabilities = DASHSCOPE_DIALECTS[dialect]
  return {id: model, label: model, family: dialect, dialectCapabilities: capabilities,
    modelCapabilities: capabilities.imageBufferInput ? OMNI_MODEL_CAPABILITIES : LEGACY_MODEL_CAPABILITIES,
    transportCapabilities: capabilities.imageBufferInput ? OMNI_TRANSPORT_CAPABILITIES : LEGACY_TRANSPORT_CAPABILITIES,
    sessionDefaults: {voice, turnDetection: capabilities.turnDetection}}
}
