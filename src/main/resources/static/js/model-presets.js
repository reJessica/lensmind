export const FIXED_MODELS = Object.freeze({
  llm: 'qwen3.5-flash-2026-02-23', asr: 'fun-asr-realtime-2026-02-28',
  tts: 'qwen-audio-3.1-tts-flash', voice: 'longanhuan_v3.1',
});
export const MODEL_PRESETS = Object.freeze({
  dashscope: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: FIXED_MODELS.llm },
  apihy: { url: 'https://zgc.apihy.com/v1', model: 'qwen3.5-27b' },
  uniapi: { url: 'https://api.uniapi.io/v1', model: '' },
  sjtu: { url: 'https://models.sjtu.edu.cn/api/v1', model: 'qwen' },
  openai: { url: 'https://api.openai.com/v1', model: '' },
  openrouter: { url: 'https://openrouter.ai/api/v1', model: '' },
  siliconflow: { url: 'https://api.siliconflow.cn/v1', model: '' },
});
export const LLM_PROFILES = Object.freeze({ recommended: MODEL_PRESETS.dashscope, existing: MODEL_PRESETS.apihy, campus: MODEL_PRESETS.sjtu });
export const SPEECH_PROFILES = Object.freeze({
  uniapi: { label: 'UniAPI', asr: 'whisper-1', tts: 'gemini-3.8-flash-lite-tts', voice: 'Kore', workspace: false },
  dashscope: { label: '百炼北京', asr: FIXED_MODELS.asr, tts: FIXED_MODELS.tts, voice: FIXED_MODELS.voice, workspace: true },
});
export function isCloudAsr(model) { return Object.values(SPEECH_PROFILES).some(profile => profile.asr === model); }
export function isCloudTts(model) { return model === 'tts-1' || Object.values(SPEECH_PROFILES).some(profile => profile.tts === model); }
