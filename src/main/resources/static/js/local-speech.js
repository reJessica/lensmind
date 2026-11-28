import { microphoneConstraints, resample16k } from './cloud-speech.js';
import { dispatchSpeechText } from './voice.js';

export function createLocalAsrClient() {
  async function request(path, options = {}) {
    const response = await fetch(`/api/ai/local-asr/${path}`, { cache: 'no-store', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || '本地 ASR 暂时不可用；不会自动切换云端。');
    return body;
  }
  return {
    create: signal => request('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sampleRate":16000}', signal }),
    audio: (id, data, signal) => request(`audio?connectionId=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data, signal }),
    reset: (id, signal) => request(`reset?connectionId=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal }),
    close: id => request(`session?connectionId=${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }),
  };
}

// Interim text only updates the draft. A segment can execute a command at most once.
export function createStreamingResultHandler(onText, onCommand) {
  let lastFinal = -1;
  return results => {
    for (const result of results || []) {
      if (!Number.isInteger(result.segment) || result.segment <= lastFinal || typeof result.final !== 'boolean' || typeof result.text !== 'string' || result.text.length > 500) continue;
      if (!result.final) { onText(result.text); continue; }
      lastFinal = result.segment;
      if (result.text.trim()) dispatchSpeechText(result.text.trim(), onText, onCommand);
    }
  };
}

export function createLocalSpeechInput({ onState, onText, onCommand, audioOptions = () => ({}), onDeviceReady = () => {}, client = createLocalAsrClient() }) {
  let handsFree = false, playing = false, generation = 0, current = null;
  const Context = window.AudioContext || window.webkitAudioContext;
  const report = message => onState({ handsFree, listening: handsFree && !!current && !playing, message });
  function dispose(resources) {
    resources?.controller?.abort();
    resources?.stream?.getTracks().forEach(track => track.stop());
    resources?.source?.disconnect(); resources?.node?.disconnect();
    resources?.context?.close().catch(() => {});
    if (resources?.id) client.close(resources.id).catch(() => {});
  }
  function stop(message = '') {
    generation++; handsFree = false;
    const previous = current; current = null; dispose(previous); report(message);
  }
  async function pump(resources, token) {
    if (resources.pumping) return;
    resources.pumping = true;
    try {
      while (token === generation && (resources.resetNeeded || !playing && resources.queue.length)) {
        if (resources.resetNeeded) {
          resources.resetNeeded = false;
          await client.reset(resources.id, resources.controller.signal);
          continue;
        }
        const epoch = resources.epoch;
        const result = await client.audio(resources.id, resources.queue.shift(), resources.controller.signal);
        if (token !== generation || resources.epoch !== epoch || playing || document.hidden) continue;
        if (result.mode !== 'LOCAL') throw new Error('本地 ASR 返回模式异常，已停止识别。');
        resources.deliver(result.results);
      }
    } catch (error) {
      if (token === generation && error.name !== 'AbortError') stop(error.message);
    } finally { resources.pumping = false; }
  }
  async function start() {
    const token = ++generation;
    const resources = { controller: new AbortController(), queue: [], epoch: 0, resetNeeded: false,
      deliver: createStreamingResultHandler(onText, onCommand) };
    handsFree = true; report('正在连接本地流式 ASR…');
    try {
      if (!Context || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('当前浏览器不支持录音，请使用新版 Chrome 或 Edge。');
      const session = await client.create(resources.controller.signal);
      resources.id = session.id;
      if (token !== generation) { dispose(resources); return; }
      resources.stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(audioOptions()));
      if (token !== generation) { dispose(resources); return; }
      resources.context = new Context();
      await resources.context.resume();
      await resources.context.audioWorklet.addModule('/js/pcm-worklet.js');
      if (token !== generation) { dispose(resources); return; }
      resources.source = resources.context.createMediaStreamSource(resources.stream);
      resources.node = new AudioWorkletNode(resources.context, 'lensmind-pcm');
      resources.node.onprocessorerror = () => { if (token === generation) stop('录音处理失败，请重新开启麦克风。'); };
      resources.node.port.onmessage = ({ data }) => {
        if (token !== generation || playing) return;
        if (resources.queue.length >= 16) { stop('本地 ASR 处理跟不上录音，已停止以避免旧口令延迟执行。'); return; }
        const samples = resample16k(new Float32Array(data), resources.context.sampleRate);
        if (!samples.length) return;
        const bytes = new ArrayBuffer(samples.length * 4), view = new DataView(bytes);
        samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
        resources.queue.push(bytes); pump(resources, token);
      };
      resources.stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (token === generation) stop('麦克风已断开，请重新开启。');
      }));
      current = resources;
      resources.source.connect(resources.node); resources.node.connect(resources.context.destination);
      report('本地实时识别中，可以说「拍摄」「停止」或「清空」。'); onDeviceReady();
    } catch (error) {
      dispose(resources);
      if (token === generation) stop(error.name === 'NotAllowedError' ? '请允许浏览器和系统麦克风权限。'
        : ['NotFoundError', 'OverconstrainedError'].includes(error.name) ? '所选麦克风不可用，请到设置重新选择。' : error.message);
    }
  }
  return {
    get available() { return !!(Context && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode); },
    get handsFree() { return handsFree; },
    stop,
    toggleHandsFree() { if (handsFree) stop(); else start(); },
    playback(value) {
      playing = value;
      if (current && value) { current.epoch++; current.queue = []; current.resetNeeded = true; }
      if (current) pump(current, generation);
      if (handsFree) report(value ? '正在播报，结束后继续本地识别。' : '本地实时识别中，可以继续说话。');
    },
  };
}
