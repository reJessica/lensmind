import { encodeWav } from './ai-client.js';
import { FIXED_MODELS } from './model-presets.js';
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
      ? `已保存 ASR：${session.asr}；TTS：${session.tts}。有效至 ${new Date(session.expiresAt).toLocaleTimeString('zh-CN')}，尚未验证鉴权和模型权限。`
      : '云端语音尚未配置。浏览器语音可独立使用。';
  }
  async function change(action) {
    if (busy) return;
    busy = true;
    $('speech-save').disabled = $('speech-disconnect').disabled = true;
    for (const id of ['settings-asr-model', 'settings-tts-model', 'speech-workspace', 'speech-key']) $(id).disabled = true;
    try { describe(await action()); }
    catch (error) { $('speech-session-status').textContent = error.message; }
    finally {
      busy = false; $('speech-save').disabled = $('speech-disconnect').disabled = false;
      for (const id of ['settings-asr-model', 'settings-tts-model', 'speech-workspace', 'speech-key']) $(id).disabled = false;
    }
  }
  $('speech-config-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const body = JSON.stringify({ asr: $('settings-asr-model').value, tts: $('settings-tts-model').value,
      workspace: $('speech-workspace').value, apiKey: $('speech-key').value });
    clearKey();
    $('speech-session-status').textContent = '正在保存本机语音配置，不访问模型平台…';
    change(async () => (await request('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json());
  });
  $('speech-disconnect').addEventListener('click', () => {
    clearKey(); change(async () => (await request('session', { method: 'DELETE' })).json());
  });
  function require(kind) {
    if (!session || Date.parse(session.expiresAt) <= Date.now()
        || session[kind] !== $(kind === 'asr' ? 'settings-asr-model' : 'settings-tts-model').value
        || session.workspace !== $('speech-workspace').value.trim()) {
      throw new Error('请先在设置页填写百炼北京地域 Key 和 Workspace ID，并保存语音配置。');
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
      const response = await request('tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, text: text.slice(0, 160), rate }), signal });
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
  const active = () => document.getElementById('settings-asr-model').value === FIXED_MODELS.asr ? cloud : browser;
  return {
    get available() { return active().available; },
    get handsFree() { return browser.handsFree || cloud.handsFree; },
    stop(message) { browser.stop(); cloud.stop(message); },
    playback(value) { browser.playback(value); cloud.playback(value); },
    toggleHandsFree() { active().toggleHandsFree(); },
  };
}
