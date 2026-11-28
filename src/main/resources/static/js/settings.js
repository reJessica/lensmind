import { aiApi } from './ai-client.js';
import { FIXED_MODELS, MODEL_PRESETS, LLM_PROFILES, SPEECH_PROFILES } from './model-presets.js';
export { MODEL_PRESETS } from './model-presets.js';

const STORAGE_KEY = 'lensmind.preferences.v1';
export const DEFAULT_PREFERENCES = Object.freeze({
  modelBaseUrl: MODEL_PRESETS.apihy.url, modelName: MODEL_PRESETS.apihy.model, llmProfile: 'existing', modelDefaultsVersion: 2,
  grid: true, frame: true, delay: '3', voiceEnabled: true, voiceRate: 1, voiceVolume: 1,
  voiceProvider: 'uniapi', asrModel: SPEECH_PROFILES.uniapi.asr, ttsModel: SPEECH_PROFILES.uniapi.tts, cloudWorkspace: '', speechDefaultsVersion: 4,
});

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && (!url.port || url.port === '443') && /^[a-zA-Z0-9_/-]*$/.test(url.pathname)) {
      return url.href.replace(/\/$/, '');
    }
  } catch { /* 损坏的偏好不影响页面启动。 */ }
  return DEFAULT_PREFERENCES.modelBaseUrl;
}

// 明确挑选可持久化字段，永远不写入密钥、会话标识、图片或其他传入字段。
export function normalizePreferences(input) {
  const value = input && typeof input === 'object' ? input : {};
  const boolean = name => typeof value[name] === 'boolean' ? value[name] : DEFAULT_PREFERENCES[name];
  let modelBaseUrl = safeBaseUrl(value.modelBaseUrl);
  let modelName = typeof value.modelName === 'string' && /^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119})?$/.test(value.modelName.trim())
    ? value.modelName.trim() : DEFAULT_PREFERENCES.modelName;
  if (value.modelDefaultsVersion !== 2 && value.llmProfile !== 'custom'
      && modelBaseUrl === MODEL_PRESETS.dashscope.url && modelName === FIXED_MODELS.llm) {
    modelBaseUrl = DEFAULT_PREFERENCES.modelBaseUrl;
    modelName = DEFAULT_PREFERENCES.modelName;
  }
  const profile = Object.keys(LLM_PROFILES).find(key => LLM_PROFILES[key].url === modelBaseUrl && LLM_PROFILES[key].model === modelName);
  const voiceProvider = [3, 4].includes(value.speechDefaultsVersion) && Object.hasOwn(SPEECH_PROFILES, value.voiceProvider) ? value.voiceProvider : 'uniapi';
  const speechProfile = SPEECH_PROFILES[voiceProvider];
  // 迁移原来的百炼默认值至已有 UniAPI；保留新版手选的浏览器或百炼配置。
  const speechModel = (name, fixed) => value[name] === 'browser' && [2, 3, 4].includes(value.speechDefaultsVersion) ? 'browser'
    : name === 'ttsModel' && voiceProvider === 'uniapi' && value.speechDefaultsVersion === 4 && value[name] === 'tts-1' ? 'tts-1' : fixed;
  return {
    modelBaseUrl, modelName, llmProfile: value.llmProfile === 'custom' ? 'custom' : profile || 'custom', modelDefaultsVersion: 2,
    grid: boolean('grid'), frame: boolean('frame'),
    delay: ['0', '3', '5'].includes(String(value.delay)) ? String(value.delay) : DEFAULT_PREFERENCES.delay,
    voiceEnabled: boolean('voiceEnabled'),
    voiceRate: [.8, 1, 1.2].includes(value.voiceRate) ? value.voiceRate : DEFAULT_PREFERENCES.voiceRate,
    voiceVolume: typeof value.voiceVolume === 'number' && Number.isFinite(value.voiceVolume)
      ? Math.min(1, Math.max(0, value.voiceVolume)) : DEFAULT_PREFERENCES.voiceVolume,
    voiceProvider,
    asrModel: speechModel('asrModel', speechProfile.asr),
    ttsModel: speechModel('ttsModel', speechProfile.tts),
    cloudWorkspace: typeof value.cloudWorkspace === 'string' && /^[a-zA-Z0-9-]{0,80}$/.test(value.cloudWorkspace) ? value.cloudWorkspace : '',
    speechDefaultsVersion: 4,
  };
}

export function readPreferences(storage) {
  try { return normalizePreferences(JSON.parse(storage.getItem(STORAGE_KEY))); }
  catch { return { ...DEFAULT_PREFERENCES }; }
}

export function savePreferences(storage, value) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(value))); return true; }
  catch { return false; }
}

export function setupSettings({ onChange, onSpeechChange, onPreviewVoice, voiceAvailable, speechAvailable }) {
  const $ = id => document.getElementById(id);
  let storage;
  try { storage = window.localStorage; } catch { /* 隐私模式下仅使用内存。 */ }
  let preferences = readPreferences(storage);
  let refreshing = false;

  function matchProvider() {
    const base = $('ai-base-url').value.replace(/\/$/, '');
    $('ai-provider').value = Object.keys(MODEL_PRESETS).find(key => MODEL_PRESETS[key].url === base) ?? 'custom';
  }

  function renderModelLocks() {
    $('llm-profile').value = preferences.llmProfile;
    const custom = preferences.llmProfile === 'custom';
    $('custom-provider-field').hidden = !custom;
    $('ai-base-url').readOnly = $('ai-model').readOnly = !custom;
  }

  function renderSpeechOptions() {
    const profile = SPEECH_PROFILES[preferences.voiceProvider];
    const cloud = preferences.asrModel !== 'browser' || preferences.ttsModel !== 'browser';
    $('speech-provider').value = preferences.voiceProvider;
    for (const [id, kind] of [['settings-asr-model', 'asr'], ['settings-tts-model', 'tts']]) {
      const select = $(id);
      if (select.options[0].value !== profile[kind]) {
        select.replaceChildren(new Option(`${profile.label} · ${profile[kind]}（固定）`, profile[kind]),
          ...(kind === 'tts' && preferences.voiceProvider === 'uniapi' ? [new Option('UniAPI · tts-1（备用，曾上游满载）', 'tts-1')] : []),
          new Option(kind === 'asr' ? '浏览器语音识别（手动选择）' : '浏览器语音播报（手动选择）', 'browser'));
      }
      select.value = preferences[kind === 'asr' ? 'asrModel' : 'ttsModel'];
    }
    $('cloud-speech-fields').hidden = !cloud;
    $('speech-workspace-field').hidden = !profile.workspace;
    $('speech-workspace').required = cloud && profile.workspace;
    $('speech-workspace').disabled = !cloud || !profile.workspace;
    $('speech-key-label').textContent = profile.workspace ? '百炼北京地域 API Key' : 'UniAPI API Key';
    $('speech-key').placeholder = profile.workspace ? '填写百炼北京地域 Key' : '可留空读取已配置的本机 UniAPI Key';
    $('speech-key-hint').textContent = profile.workspace ? '需要百炼账号和北京地域 Workspace；提交后清空输入，临时保存 30 分钟。'
      : '无需百炼账号或 Workspace ID；可读取本机已配置的 UniAPI Key，也可在这里单独填写。';
    const voice = preferences.ttsModel === 'tts-1' ? 'alloy' : profile.voice;
    $('speech-voice-note').textContent = `云端音色固定为 ${voice}，模型不会自动切换。` + (preferences.ttsModel === SPEECH_PROFILES.uniapi.tts ? ' Gemini 语速为风格提示，不保证精确倍速。' : '');
    if (!cloud) $('speech-key').value = '';
    $('settings-voice-preview').disabled = $('settings-voice-enabled').disabled = !voiceAvailable();
    $('settings-voice-capability').textContent = !voiceAvailable() ? '当前浏览器不支持所选播报方式，仍可查看文字。'
      : !speechAvailable() ? '当前浏览器不支持所选录音方式，请用文字输入。'
      : preferences.ttsModel === 'browser' ? '试听浏览器播报，不会开启麦克风。' : `试听将调用 ${profile.label} ${preferences.ttsModel}，固定音色 ${voice}。`;
  }

  function render() {
    $('ai-base-url').value = preferences.modelBaseUrl;
    $('ai-model').value = preferences.modelName;
    matchProvider();
    renderModelLocks();
    $('grid-toggle').checked = preferences.grid;
    $('frame-toggle').checked = preferences.frame;
    $('settings-delay').value = $('delay').value = preferences.delay;
    $('settings-voice-enabled').checked = preferences.voiceEnabled;
    $('settings-voice-rate').value = String(preferences.voiceRate);
    $('settings-voice-volume').value = String(preferences.voiceVolume);
    $('settings-volume-label').value = `${Math.round(preferences.voiceVolume * 100)}%`;
    $('speech-workspace').value = preferences.cloudWorkspace;
    renderSpeechOptions();
  }

  function update(changes) {
    const previous = preferences;
    preferences = normalizePreferences({ ...preferences, ...changes });
    if (previous.voiceProvider !== preferences.voiceProvider || previous.asrModel !== preferences.asrModel || previous.ttsModel !== preferences.ttsModel) onSpeechChange();
    const saved = savePreferences(storage, preferences);
    $('settings-save-status').textContent = saved ? '偏好已自动保存。密钥不会保存。' : '浏览器不允许保存偏好，本次页面内仍然生效。';
    $('settings-volume-label').value = `${Math.round(preferences.voiceVolume * 100)}%`;
    renderSpeechOptions();
    onChange(preferences);
  }

  $('llm-profile').addEventListener('change', () => {
    const profile = $('llm-profile').value;
    $('ai-key').value = '';
    const preset = LLM_PROFILES[profile];
    if (preset) {
      $('ai-base-url').value = preset.url; $('ai-model').value = preset.model; matchProvider();
    }
    update({ llmProfile: profile, modelBaseUrl: $('ai-base-url').value, modelName: $('ai-model').value });
    renderModelLocks();
    $('ai-connection-status').textContent = '已填入模型方案。请使用对应服务商的 Key，手动测试并连接。';
  });

  $('ai-provider').addEventListener('change', () => {
    const preset = MODEL_PRESETS[$('ai-provider').value];
    $('ai-key').value = '';
    if (preset) {
      $('ai-base-url').value = preset.url;
      $('ai-model').value = preset.model;
      update({ llmProfile: 'custom', modelBaseUrl: preset.url, modelName: preset.model });
    }
    $('ai-connection-status').textContent = '请填写该服务商的模型和密钥，再测试连接。现有连接暂时保留。';
  });
  for (const id of ['ai-base-url', 'ai-model']) $(id).addEventListener('change', () => {
    if (id === 'ai-base-url') { $('ai-key').value = ''; matchProvider(); }
    update({ llmProfile: 'custom', modelBaseUrl: $('ai-base-url').value, modelName: $('ai-model').value });
  });
  for (const [id, field] of [['settings-asr-model', 'asrModel'], ['settings-tts-model', 'ttsModel'], ['speech-workspace', 'cloudWorkspace']]) {
    $(id).addEventListener('change', () => {
      update({ [field]: $(id).value.trim() });
    });
  }
  $('speech-provider').addEventListener('change', () => {
    const voiceProvider = $('speech-provider').value;
    const profile = SPEECH_PROFILES[voiceProvider];
    $('speech-key').value = '';
    update({ voiceProvider, asrModel: profile.asr, ttsModel: profile.tts });
    $('speech-session-status').textContent = '已切换语音服务商，请保存语音配置；不会沿用其他服务商的密钥。';
  });
  for (const [id, name] of [['grid-toggle', 'grid'], ['frame-toggle', 'frame'], ['settings-voice-enabled', 'voiceEnabled']]) {
    $(id).addEventListener('change', () => update({ [name]: $(id).checked }));
  }
  for (const id of ['settings-delay', 'delay']) $(id).addEventListener('change', () => {
    $('settings-delay').value = $('delay').value = $(id).value;
    update({ delay: $(id).value });
  });
  $('settings-voice-rate').addEventListener('change', () => update({ voiceRate: Number($('settings-voice-rate').value) }));
  $('settings-voice-volume').addEventListener('input', () => update({ voiceVolume: Number($('settings-voice-volume').value) }));
  $('settings-voice-preview').addEventListener('click', onPreviewVoice);
  $('reset-preferences').addEventListener('click', () => {
    $('ai-key').value = '';
    $('speech-key').value = '';
    onSpeechChange();
    preferences = { ...DEFAULT_PREFERENCES };
    render();
    update(preferences);
    $('settings-save-status').textContent += ' 已恢复默认偏好，现有模型连接保持不变。';
  });

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    $('settings-refresh').disabled = true;
    $('settings-service-status').textContent = '正在获取服务状态…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const status = await aiApi.status(controller.signal);
      $('settings-backend-mode').textContent = status.mode === 'MOCK' ? '模拟模式 · 独立接口不调用外部模型' : 'LIVE · 独立接口使用云端模型';
      for (const kind of ['asr', 'tts']) {
        const config = status.models[kind];
        $(`settings-${kind}-status`).textContent = `${config.model || '未指定模型'} · ${config.configured ? '配置齐全，未在此验证' : '配置未齐全'}`;
      }
      $('settings-service-status').textContent = `状态已更新。本进程真实调用尝试 ${status.liveCallAttempts}/${status.maxLiveCalls}；查看状态不调用付费模型。`;
    } catch (error) {
      for (const id of ['settings-backend-mode', 'settings-asr-status', 'settings-tts-status']) $(id).textContent = '暂时无法获取';
      $('settings-service-status').textContent = error.name === 'AbortError' ? '获取状态超时，请稍后重试。' : '无法获取后端状态，请确认灵眸服务正在运行。';
    } finally {
      clearTimeout(timeout);
      refreshing = false;
      $('settings-refresh').disabled = false;
    }
  }
  $('settings-refresh').addEventListener('click', refresh);
  render();
  return {
    get preferences() { return preferences; },
    refresh,
    updateDevice(device, online) {
      $('settings-device-status').textContent = !online ? '控制服务未连接' : device?.so101
        ? `SO-101 三维仿真 · ${device.state === 'STOPPED' ? '已停止' : '已连接'}` : `二维模拟设备 · ${device?.state === 'STOPPED' ? '已停止' : '已连接'}`;
    },
  };
}
