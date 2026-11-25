// 提供给组员一的独立客户端；不改变现有 app.js，也不自动执行任何设备动作。
// AI 结果是建议，必须结合页面状态、帧时效与控制端校验。停止仍直接走设备接口。
async function request(path, body, signal) {
  const response = await fetch(`/api/ai/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || `AI 请求失败：${response.status}`);
  }
  return response;
}

export const aiApi = {
  status: async signal => (await request('status', undefined, signal)).json(),
  command: async (text, context = {}, signal) => (await request('command', { text, ...context }, signal)).json(),
  vision: async (imageBlob, { frameId, capturedAt, composition = 'center', framing = 'half' }, signal) => {
    const data = new FormData();
    data.append('image', imageBlob, 'frame.jpg');
    for (const [key, value] of Object.entries({ frameId, capturedAt, composition, framing })) data.append(key, value);
    return (await request('vision', data, signal)).json();
  },
  asr: async (wavBlob, signal) => {
    const data = new FormData();
    data.append('audio', wavBlob, 'recording.wav');
    return (await request('asr', data, signal)).json();
  },
  tts: async (text, signal) => {
    const response = await request('tts', { text }, signal);
    return { audio: await response.blob(), mode: response.headers.get('X-LensMind-Mode'),
      kind: response.headers.get('X-LensMind-Audio') };
  },
};

// 将 Web Audio 采集的单声道 Float32 PCM 编成 WAV。传实际 AudioContext.sampleRate；
// 此函数不采集麦克风、不重采样。录音时长应限制到 15 秒内。
export function encodeWav(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || sampleRate < 8000 || sampleRate > 48000 || samples.length / sampleRate > 15 || samples.length === 0) {
    throw new Error('需要 15 秒以内、8～48 kHz 的单声道 Float32 PCM');
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const v = Math.min(1, Math.max(-1, sample)); view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); });
  return new Blob([buffer], { type: 'audio/wav' });
}
