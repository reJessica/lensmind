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
