import { aiApi } from './ai-client.js';
import { FIXED_MODELS, MODEL_PRESETS, LLM_PROFILES } from './model-presets.js';
export { MODEL_PRESETS } from './model-presets.js';

const STORAGE_KEY = 'lensmind.preferences.v1';
export const DEFAULT_PREFERENCES = Object.freeze({
  modelBaseUrl: MODEL_PRESETS.dashscope.url, modelName: FIXED_MODELS.llm, llmProfile: 'recommended',
  grid: true, frame: true, delay: '3', voiceEnabled: true, voiceRate: 1, voiceVolume: 1,
  asrModel: 'browser', ttsModel: 'browser', cloudWorkspace: '',
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
  const modelBaseUrl = safeBaseUrl(value.modelBaseUrl);
  const modelName = typeof value.modelName === 'string' && /^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119})?$/.test(value.modelName.trim())
    ? value.modelName.trim() : DEFAULT_PREFERENCES.modelName;
  const profile = Object.keys(LLM_PROFILES).find(key => LLM_PROFILES[key].url === modelBaseUrl && LLM_PROFILES[key].model === modelName);
  return {
    modelBaseUrl, modelName, llmProfile: value.llmProfile === 'custom' ? 'custom' : profile || 'custom',
    grid: boolean('grid'), frame: boolean('frame'),
    delay: ['0', '3', '5'].includes(String(value.delay)) ? String(value.delay) : DEFAULT_PREFERENCES.delay,
    voiceEnabled: boolean('voiceEnabled'),
    voiceRate: [.8, 1, 1.2].includes(value.voiceRate) ? value.voiceRate : DEFAULT_PREFERENCES.voiceRate,
    voiceVolume: typeof value.voiceVolume === 'number' && Number.isFinite(value.voiceVolume)
      ? Math.min(1, Math.max(0, value.voiceVolume)) : DEFAULT_PREFERENCES.voiceVolume,
    asrModel: value.asrModel === FIXED_MODELS.asr ? FIXED_MODELS.asr : 'browser',
    ttsModel: value.ttsModel === FIXED_MODELS.tts ? FIXED_MODELS.tts : 'browser',
    cloudWorkspace: typeof value.cloudWorkspace === 'string' && /^[a-zA-Z0-9-]{0,80}$/.test(value.cloudWorkspace) ? value.cloudWorkspace : '',
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
    const cloud = preferences.asrModel !== 'browser' || preferences.ttsModel !== 'browser';
    $('cloud-speech-fields').hidden = !cloud;
    $('speech-workspace').required = cloud;
    if (!cloud) $('speech-key').value = '';
    $('settings-voice-preview').disabled = $('settings-voice-enabled').disabled = !voiceAvailable();
    $('settings-voice-capability').textContent = !voiceAvailable() ? '当前浏览器不支持所选播报方式，仍可查看文字。'
      : !speechAvailable() ? '当前浏览器不支持所选录音方式，请用文字输入。'
      : preferences.ttsModel === 'browser' ? '试听浏览器播报，不会开启麦克风。' : `试听将调用 ${FIXED_MODELS.tts}，固定音色 ${FIXED_MODELS.voice}。`;
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
    $('settings-asr-model').value = preferences.asrModel;
    $('settings-tts-model').value = preferences.ttsModel;
    $('speech-workspace').value = preferences.cloudWorkspace;
    renderSpeechOptions();
  }

  function update(changes) {
    const previous = preferences;
    preferences = normalizePreferences({ ...preferences, ...changes });
    if (previous.asrModel !== preferences.asrModel || previous.ttsModel !== preferences.ttsModel) onSpeechChange();
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
      $('speech-key').value = '';
      update({ [field]: $(id).value.trim() });
    });
  }
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
