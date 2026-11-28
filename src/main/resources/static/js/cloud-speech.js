import { encodeWav } from './ai-client.js';
import { isCloudAsr } from './model-presets.js';
import { dispatchSpeechText } from './voice.js';

async function request(path, options = {}) {
  const response = await fetch(`/api/ai/speech/${path}`, { cache: 'no-store', ...options });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.message || '云端语音服务暂时不可用。');
  }
  return response;
}

export function setupCloudSpeech() {
  const $ = id => document.getElementById(id);
  let session = null;
  let busy = false;
  const clearKey = () => { $('speech-key').value = ''; };
  function describe(result) {
    session = result.configured ? result : null;
    $('speech-disconnect').hidden = !session;
    $('speech-session-status').textContent = session
      ? `已保存 ${session.provider === 'uniapi' ? 'UniAPI' : '百炼'}：ASR ${session.asr}；TTS ${session.tts}。密钥由本机临时保管至 ${new Date(session.expiresAt).toLocaleTimeString('zh-CN')}，输入框留空即可使用；尚未验证鉴权和模型权限。`
      : $('speech-provider').value === 'dashscope' ? '当前手选百炼官方，需要百炼账号、北京地域 Key 与 Workspace ID；现有 UniAPI Key 不适用于此项。'
      : result.localUniapiKeyConfigured ? '本机已有 UniAPI Key。点击「保存语音配置」即可启用，无需填写 Workspace ID；尚未调用或验证模型。'
      : '云端语音尚未配置。请选择已有账号的服务商并保存 Key；UniAPI 无需 Workspace ID，不会自动回退到浏览器。';
  }
  async function change(action, { submitted = false } = {}) {
    if (busy) return;
    busy = true;
    $('speech-save').disabled = $('speech-disconnect').disabled = true;
    for (const id of ['speech-provider', 'settings-asr-model', 'settings-tts-model', 'speech-workspace', 'speech-key']) $(id).disabled = true;
    try { describe(await action()); }
    catch (error) { $('speech-session-status').textContent = error.message + (submitted ? ' 本次密钥输入已清空，请重新填写后重试。' : ''); }
    finally {
      busy = false; $('speech-save').disabled = $('speech-disconnect').disabled = false;
      for (const id of ['speech-provider', 'settings-asr-model', 'settings-tts-model', 'speech-workspace', 'speech-key']) $(id).disabled = false;
      $('speech-workspace').disabled = $('speech-provider').value !== 'dashscope';
    }
  }
  $('speech-config-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const body = JSON.stringify({ provider: $('speech-provider').value, asr: $('settings-asr-model').value, tts: $('settings-tts-model').value,
      workspace: $('speech-provider').value === 'dashscope' ? $('speech-workspace').value : '', apiKey: $('speech-key').value });
    clearKey();
    $('speech-session-status').textContent = '密钥已提交并清空输入框，正在保存本机语音配置，不访问模型平台…';
    change(async () => (await request('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json(), { submitted: true });
  });
  $('speech-disconnect').addEventListener('click', () => {
    clearKey(); change(async () => (await request('session', { method: 'DELETE' })).json());
  });
  function require(kind) {
    if (!session || Date.parse(session.expiresAt) <= Date.now()
        || session.provider !== $('speech-provider').value
        || session[kind] !== $(kind === 'asr' ? 'settings-asr-model' : 'settings-tts-model').value
        || session.provider === 'dashscope' && session.workspace !== $('speech-workspace').value.trim()) {
      throw new Error('请先在设置页保存所选服务商的语音配置；UniAPI 可读取本机 Key，无需 Workspace ID。');
    }
    return session.id;
  }
  return {
    clearKey,
    refresh: () => change(async () => (await request('session')).json()),
    require,
    async transcribe(wav, signal) {
      const connectionId = require('asr');
      const data = new FormData(); data.append('audio', wav, 'speech.wav'); data.append('connectionId', connectionId);
      const result = await (await request('asr', { method: 'POST', body: data, signal })).json();
      if (require('asr') !== connectionId) throw new Error('语音配置已变化，丢弃旧转写。');
      return result.text;
    },
    async synthesize(text, rate, signal) {
      const connectionId = require('tts');
      const timeout = AbortSignal.timeout(70000);
      let response;
      try {
        response = await request('tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId, text: text.slice(0, 160), rate }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (error) {
        if (timeout.aborted && !signal?.aborted) throw new Error('云端合成等待超时，请检查服务状态后手动重试；未自动重试。');
        throw error;
      }
      if (require('tts') !== connectionId) throw new Error('语音配置已变化，丢弃旧播报。');
      return response.blob();
    },
  };
}

export function resample16k(samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000) throw new Error('不支持当前麦克风采样率。');
  if (sampleRate === 16000) return samples;
  const ratio = sampleRate / 16000;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio), end = Math.floor((i + 1) * ratio);
    let total = 0;
    for (let j = start; j < end; j++) total += samples[j];
    output[i] = total / Math.max(1, end - start);
  }
  return output;
}

// 能量断句只决定何时上传，不承担人物稳定性或设备控制判断。
export function createUtteranceBuffer(sampleRate) {
  let chunks = [], count = 0, voiced = 0, silence = 0, previous = null;
  const reset = () => { chunks = []; count = voiced = silence = 0; previous = null; };
  return {
    reset,
    push(samples) {
      let energy = 0;
      for (const value of samples) energy += value * value;
      const speaking = Math.sqrt(energy / samples.length) > .012;
      if (!count && !speaking) { previous = samples; return null; }
      if (!count && previous) { chunks.push(previous); count += previous.length; previous = null; }
      chunks.push(samples); count += samples.length;
      if (speaking) { voiced += samples.length; silence = 0; } else silence += samples.length;
      if (silence < sampleRate * .65 && count < sampleRate * 10) return null;
      let result = null;
      if (voiced >= sampleRate * .2) {
        result = new Float32Array(count); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      }
      reset(); return result;
    },
  };
}

export function createCloudSpeechInput({ cloud, onState, onText, onCommand }) {
  let handsFree = false, playing = false, generation = 0, current = null, pending = null;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const report = message => onState({ handsFree, listening: handsFree && !!current && !playing && !pending, message });
  function dispose(resources) {
    resources?.stream?.getTracks().forEach(track => track.stop());
    resources?.node?.disconnect(); resources?.source?.disconnect();
    resources?.context?.close().catch(() => {});
  }
  function stop(message = '') {
    generation++; handsFree = false;
    pending?.abort(); pending = null;
    dispose(current); current = null; report(message);
  }
  async function start() {
    const token = ++generation;
    const resources = {};
    try {
      cloud.require('asr');
      if (!AudioContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('当前浏览器不支持云端录音，请使用新版 Edge 或 Chrome。');
      handsFree = true; report('正在开启云端语音录音…');
      resources.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (token !== generation) { dispose(resources); return; }
      resources.context = new AudioContext();
      await resources.context.resume();
      await resources.context.audioWorklet.addModule('/js/pcm-worklet.js');
      if (token !== generation) { dispose(resources); return; }
      resources.source = resources.context.createMediaStreamSource(resources.stream);
      resources.node = new AudioWorkletNode(resources.context, 'lensmind-pcm');
      resources.buffer = createUtteranceBuffer(resources.context.sampleRate);
      resources.node.port.onmessage = async ({ data }) => {
        if (token !== generation || playing || pending) return;
        const samples = resources.buffer.push(new Float32Array(data));
        if (!samples) return;
        const controller = pending = new AbortController(); report('正在识别云端语音…');
        try {
          const text = await cloud.transcribe(encodeWav(resample16k(samples, resources.context.sampleRate), 16000), controller.signal);
          if (token !== generation || pending !== controller || playing || document.hidden) return;
          dispatchSpeechText(text, onText, onCommand);
        } catch (error) {
          if (token === generation && error.name !== 'AbortError') stop(error.message);
        } finally {
          if (pending === controller) { pending = null; resources.buffer.reset(); report(''); }
        }
      };
      resources.source.connect(resources.node);
      // Worklet 不回传输入到扬声器，连接输出仅用于驱动处理。
      resources.node.connect(resources.context.destination);
      resources.stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (token === generation) stop('麦克风已断开，请重新开启。');
      }));
      current = resources; report('');
    } catch (error) {
      dispose(resources);
      if (token === generation) stop(error.name === 'NotAllowedError' ? '请允许麦克风权限后重试。' : error.message);
    }
  }
  return {
    get available() { return !!(AudioContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode); },
    get handsFree() { return handsFree; },
    stop,
    toggleHandsFree() { if (handsFree) stop(); else start(); },
    playback(value) {
      playing = value; current?.buffer.reset();
      if (playing) { pending?.abort(); pending = null; }
      if (handsFree) report(value ? '正在播报，结束后继续听。' : '');
    },
  };
}

export function routeSpeechInput(browser, cloud) {
  const active = () => isCloudAsr(document.getElementById('settings-asr-model').value) ? cloud : browser;
  return {
    get available() { return active().available; },
    get handsFree() { return browser.handsFree || cloud.handsFree; },
    stop(message) { browser.stop(); cloud.stop(message); },
    playback(value) { browser.playback(value); cloud.playback(value); },
    toggleHandsFree() { active().toggleHandsFree(); },
  };
}
