import type {VoiceResources,ThinkingModeConfiguration} from './contracts.ts';
import type {CallTurnConfiguration} from './turn-model.mjs';
import type {HermesClient} from '../hermes-client.ts';
export interface CallTurnResources {
  config:CallTurnConfiguration;score(samples:Float32Array,signal?:AbortSignal):Promise<number>;thinking:Int16Array;
}
export interface QwenVoiceConfiguration {
    usable: boolean;
    provider: 'dashscope';
    model: string;
    dialect?: DashScopeDialect;
    transcription_model?: string;
    region: 'cn-beijing' | 'ap-southeast-1';
    endpoint: string;
    voice: string;
    apiKey: string;
    instructions: string;
    /** The live call front's own model and voice (dialect selected by configuration). */
    call?: {thinking_mode?:ThinkingModeConfiguration; dialect?: DashScopeDialect; transcription_model?: string; model: string; voice: string; expressive?: boolean; ambient_silence_ms?:number; silence_duration_ms?:number; session_options?: {enable_search?: boolean; temperature?: number; presence_penalty?: number}; greeting?: {enabled?: boolean; text?: string};turn_manager?:CallTurnConfiguration};
    WebSocket?: unknown;
}
export interface QwenTtsSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  send(body: string): void;
  terminate(): void;
}
export function createQwenTtsTransport(configuration: QwenVoiceConfiguration, endpoint?: string): () => QwenTtsSocket;
export function createQwenVoiceResources(options: {
  configuration?: QwenVoiceConfiguration;
  authorizeWindow: VoiceResources['authorizeWindow'];
  authorizeFinal: VoiceResources['authorizeFinal'];
  recordConfirmation?: VoiceResources['recordConfirmation'];
  hasConfirmation?: VoiceResources['hasConfirmation'];
  recoverConfirmation?: VoiceResources['recoverConfirmation'];
  callTurns?:CallTurnResources;classifyCall?:HermesClient['classifyCall'];searchCall?:HermesClient['searchCall'];
  onError: VoiceResources['onError'];
}): VoiceResources&{thinkingMode?:ThinkingModeConfiguration;frontTurns?:CallTurnResources;classifyCall?:HermesClient['classifyCall'];searchCall?:HermesClient['searchCall']};
/** Provider protocol dialects are independent of the selected model. */
export type DashScopeDialect = 'nested-audio' | 'flat-smart-turn' | 'flat-semantic-vad';
export const DASHSCOPE_DIALECTS: Readonly<Record<DashScopeDialect, object>>;
