import { aiApi } from './ai-client.js';
import { FIXED_MODELS, MODEL_PRESETS, LLM_PROFILES, SPEECH_PROFILES, LOCAL_ASR_MODEL } from './model-presets.js';
export { MODEL_PRESETS } from './model-presets.js';

const STORAGE_KEY = 'lensmind.preferences.v1';
export const DEFAULT_PREFERENCES = Object.freeze({
  modelBaseUrl: MODEL_PRESETS.apihy.url, modelName: MODEL_PRESETS.apihy.model, llmProfile: 'existing', modelDefaultsVersion: 2,
  grid: true, frame: true, delay: '3', voiceEnabled: true, voiceRate: 1, voiceVolume: 1,
  microphoneDeviceId: '', microphoneProcessing: false,
  voiceProvider: 'uniapi', asrModel: LOCAL_ASR_MODEL, ttsModel: SPEECH_PROFILES.uniapi.tts, cloudWorkspace: '', speechDefaultsVersion: 5,
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
  const voiceProvider = [3, 4, 5].includes(value.speechDefaultsVersion) && Object.hasOwn(SPEECH_PROFILES, value.voiceProvider) ? value.voiceProvider : 'uniapi';
  const speechProfile = SPEECH_PROFILES[voiceProvider];
  // 迁移原来的百炼默认值至已有 UniAPI；保留新版手选的浏览器或百炼配置。
  const speechModel = (name, fixed) => value[name] === 'browser' && [2, 3, 4, 5].includes(value.speechDefaultsVersion) ? 'browser'
    : name === 'ttsModel' && voiceProvider === 'uniapi' && [4, 5].includes(value.speechDefaultsVersion) && value[name] === 'tts-1' ? 'tts-1' : fixed;
  return {
    modelBaseUrl, modelName, llmProfile: value.llmProfile === 'custom' ? 'custom' : profile || 'custom', modelDefaultsVersion: 2,
    grid: boolean('grid'), frame: boolean('frame'),
    delay: ['0', '3', '5'].includes(String(value.delay)) ? String(value.delay) : DEFAULT_PREFERENCES.delay,
    voiceEnabled: boolean('voiceEnabled'),
    microphoneDeviceId: typeof value.microphoneDeviceId === 'string' && value.microphoneDeviceId.length <= 256 ? value.microphoneDeviceId : '',
    microphoneProcessing: boolean('microphoneProcessing'),
    voiceRate: [.8, 1, 1.2].includes(value.voiceRate) ? value.voiceRate : DEFAULT_PREFERENCES.voiceRate,
    voiceVolume: typeof value.voiceVolume === 'number' && Number.isFinite(value.voiceVolume)
      ? Math.min(1, Math.max(0, value.voiceVolume)) : DEFAULT_PREFERENCES.voiceVolume,
    voiceProvider,
    asrModel: LOCAL_ASR_MODEL,
    ttsModel: speechModel('ttsModel', speechProfile.tts),
    cloudWorkspace: typeof value.cloudWorkspace === 'string' && /^[a-zA-Z0-9-]{0,80}$/.test(value.cloudWorkspace) ? value.cloudWorkspace : '',
    speechDefaultsVersion: 5,
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
    $('model-advanced').open = custom;
    $('ai-base-url').readOnly = $('ai-model').readOnly = !custom;
  }

  function renderSpeechOptions() {
    const profile = SPEECH_PROFILES[preferences.voiceProvider];
    const cloud = preferences.ttsModel !== 'browser';
    $('speech-provider').value = preferences.voiceProvider;
    $('settings-asr-model').replaceChildren(new Option('本地 Zipformer · 流式中文识别', LOCAL_ASR_MODEL));
    $('settings-asr-model').value = LOCAL_ASR_MODEL;
    $('settings-asr-model').disabled = true;
    const select = $('settings-tts-model');
    if (select.dataset.provider !== preferences.voiceProvider) {
      select.replaceChildren(new Option(`${profile.label} · ${profile.tts}（云端）`, profile.tts),
        ...(preferences.voiceProvider === 'uniapi' ? [new Option('UniAPI · tts-1（备用）', 'tts-1')] : []),
        new Option('浏览器语音播报（手动选择）', 'browser'));
      select.dataset.provider = preferences.voiceProvider;
    }
    select.value = preferences.ttsModel;
    $('cloud-speech-fields').hidden = !cloud;
    $('speech-workspace-field').hidden = !profile.workspace;
    $('speech-workspace').required = cloud && profile.workspace;
    $('speech-workspace').disabled = !cloud || !profile.workspace;
    $('speech-key-label').textContent = profile.workspace ? '百炼北京地域 API Key' : 'UniAPI API Key';
    $('speech-key').placeholder = profile.workspace ? '填写百炼北京地域 Key' : '可留空读取已配置的本机 UniAPI Key';
    $('speech-key-hint').textContent = profile.workspace ? '需要百炼账号和北京地域 Workspace；提交后清空输入，临时保存 30 分钟。'
      : '留空可使用本机 UniAPI Key。';
    const voice = preferences.ttsModel === 'tts-1' ? 'alloy' : profile.voice;
    $('speech-voice-note').textContent = `音色 ${voice} · 不自动切换模型。`;
    if (!cloud) $('speech-key').value = '';
    $('settings-voice-preview').disabled = $('settings-voice-enabled').disabled = !voiceAvailable();
    $('settings-voice-capability').textContent = !voiceAvailable() ? '当前浏览器不支持所选播报方式，仍可查看文字。'
      : !speechAvailable() ? '当前浏览器不支持所选录音方式，请用文字输入。'
      : preferences.ttsModel === 'browser' ? '试听浏览器播报，不会开启麦克风。' : `试听使用 ${profile.label} · ${voice}。`;
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
    $('settings-mic-processing').checked = preferences.microphoneProcessing;
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
  for (const [id, field] of [['settings-tts-model', 'ttsModel'], ['speech-workspace', 'cloudWorkspace']]) {
    $(id).addEventListener('change', () => {
      update({ [field]: $(id).value.trim() });
    });
  }
  $('speech-provider').addEventListener('change', () => {
    const voiceProvider = $('speech-provider').value;
    const profile = SPEECH_PROFILES[voiceProvider];
    $('speech-key').value = '';
    update({ voiceProvider, asrModel: LOCAL_ASR_MODEL, ttsModel: profile.tts });
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
  $('settings-mic-device').addEventListener('change', () => {
    onSpeechChange();
    update({ microphoneDeviceId: $('settings-mic-device').value });
  });
  $('settings-mic-processing').addEventListener('change', () => {
    onSpeechChange();
    update({ microphoneProcessing: $('settings-mic-processing').checked });
  });
  async function refreshMicrophones() {
    const select = $('settings-mic-device');
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('当前浏览器不支持枚举输入设备。');
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
      select.replaceChildren(new Option('系统默认麦克风', ''), ...devices.filter(device => device.deviceId).map((device, index) =>
        new Option(device.label || `麦克风 ${index + 1}（授权后可显示名称）`, device.deviceId)));
      if (preferences.microphoneDeviceId && !devices.some(device => device.deviceId === preferences.microphoneDeviceId)) {
        select.add(new Option('此前选择的麦克风（当前不可用）', preferences.microphoneDeviceId));
      }
      select.value = preferences.microphoneDeviceId;
      $('settings-mic-hint').textContent = '建议选择 MacBook Air 麦克风或你的实体麦克风；BlackHole 等虚拟设备可能没有输入。更改后返回拍摄页重新开启麦克风。此选择用于本地及云端 ASR。';
    } catch (error) { $('settings-mic-hint').textContent = error.message; }
  }
  $('settings-mic-refresh').addEventListener('click', refreshMicrophones);
  async function refreshLocalAsr() {
    $('local-asr-status').textContent = '正在检查本机识别服务…';
    try {
      const response = await fetch('/api/ai/local-asr/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const result = await response.json();
      if (!response.ok || !result.ready) throw new Error(result.message || '本地 ASR 正在准备或尚未就绪。');
      $('local-asr-status').textContent = '本地 Zipformer 已就绪 · CPU 流式识别 · 不使用云端额度。';
    } catch (error) { $('local-asr-status').textContent = error.message || '无法获取识别状态，请确认后端已启动。'; }
  }
  $('local-asr-check').addEventListener('click', refreshLocalAsr);
  $('reset-preferences').addEventListener('click', () => {
    $('ai-key').value = '';
    $('speech-key').value = '';
    onSpeechChange();
    preferences = { ...DEFAULT_PREFERENCES };
    render();
    refreshMicrophones();
    update(preferences);
    $('settings-save-status').textContent += ' 已恢复默认偏好，现有模型连接保持不变。';
  });

  async function refresh() {
    if (refreshing) return;
    refreshLocalAsr();
    refreshing = true;
    $('settings-refresh').disabled = true;
    $('settings-service-status').textContent = '正在获取服务状态…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const status = await aiApi.status(controller.signal);
      $('settings-backend-mode').textContent = status.mode === 'MOCK' ? '模拟模式 · 独立接口不调用外部模型' : 'LIVE · 独立接口使用云端模型';
      $('settings-asr-status').textContent = preferences.asrModel === LOCAL_ASR_MODEL
        ? '本地 Zipformer · 无需 API Key' : `${preferences.asrModel} · 已选择`;
      $('settings-tts-status').textContent = `${preferences.ttsModel} · 已选择`;
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
  refreshMicrophones();
  return {
    get preferences() { return preferences; },
    refresh,
    refreshMicrophones,
    updateDevice(device, online) {
      $('settings-device-status').textContent = !online ? '控制服务未连接' : device?.so101
        ? `SO-101 三维仿真 · ${device.state === 'STOPPED' ? '已停止' : '已连接'}` : `二维模拟设备 · ${device?.state === 'STOPPED' ? '已停止' : '已连接'}`;
    },
  };
}
