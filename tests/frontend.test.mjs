// 可选开发检查：Node.js 20+，无第三方依赖，不参与页面运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSpokenShutter, parseCommand, spokenYawDirection } from '../src/main/resources/static/js/commands.js';
import { cropRect, cropRegion, renderCrop, resizeCrop } from '../src/main/resources/static/js/crop.js';
import { capturePositionHint, composeAdvice, createVisionTracker, cropVisionFrame, fitFrame } from '../src/main/resources/static/js/vision.js';
import { encodeWav } from '../src/main/resources/static/js/ai-client.js';
import { DEFAULT_PREFERENCES, normalizePreferences, readPreferences, savePreferences } from '../src/main/resources/static/js/settings.js';
import { FIXED_MODELS, LLM_PROFILES, SPEECH_PROFILES, LOCAL_ASR_MODEL, isCloudAsr, isCloudTts } from '../src/main/resources/static/js/model-presets.js';
import { createUtteranceBuffer, createCloudSpeechInput, microphoneConstraints, resample16k } from '../src/main/resources/static/js/cloud-speech.js';
import { createStreamingResultHandler, createLocalSpeechInput } from '../src/main/resources/static/js/local-speech.js';
import { openWristCamera } from '../src/main/resources/static/js/wrist-camera.js';

test('固定模型预设和旧配置迁移保留正确服务商，不接受未知语音模型', () => {
  assert.equal(LLM_PROFILES.recommended.model, 'qwen3.5-flash-2026-02-23');
  assert.equal(FIXED_MODELS.asr, 'fun-asr-realtime-2026-02-28');
  assert.equal(FIXED_MODELS.tts, 'qwen-audio-3.1-tts-flash');
  assert.equal(FIXED_MODELS.voice, 'longanhuan_v3.1');
  const old = normalizePreferences({ modelBaseUrl: 'https://zgc.apihy.com/v1', modelName: 'qwen3.5-27b' });
  assert.equal(old.llmProfile, 'existing');
  assert.equal(old.asrModel, LOCAL_ASR_MODEL);
  const pinned = normalizePreferences({ voiceProvider: 'dashscope', speechDefaultsVersion: 3, asrModel: FIXED_MODELS.asr, ttsModel: FIXED_MODELS.tts, apiKey: 'fake-secret' });
  assert.equal(pinned.asrModel, LOCAL_ASR_MODEL);
  assert.equal(pinned.ttsModel, FIXED_MODELS.tts);
  assert.equal(normalizePreferences({ asrModel: 'unknown', ttsModel: 'unknown' }).asrModel, LOCAL_ASR_MODEL);
  assert.equal(JSON.stringify(pinned).includes('fake-secret'), false);
});

test('本地流式中间字只更新文本，最终句只执行一次，否定口令不拍照', () => {
  const text = [], commands = [];
  const deliver = createStreamingResultHandler(value => text.push(value), value => commands.push(parseCommand(value).type));
  deliver([{ text: '拍', final: false, segment: 0 }, { text: '拍摄', final: false, segment: 0 }]);
  assert.deepEqual(commands, []); assert.deepEqual(text, ['拍', '拍摄']);
  deliver([{ text: '拍摄', final: true, segment: 0 }, { text: '拍摄', final: true, segment: 0 }]);
  deliver([{ text: '不要拍照', final: true, segment: 1 }]);
  deliver([{ text: '拍摄', final: 'true', segment: 2 }]);
  assert.deepEqual(commands, ['CAPTURE', 'CLARIFY']);
});

test('所有历史 ASR 偏好固定本地，TTS 保持原选择', () => {
  const old = normalizePreferences({ ...DEFAULT_PREFERENCES, speechDefaultsVersion: 4, asrModel: 'whisper-1' });
  assert.equal(old.asrModel, LOCAL_ASR_MODEL);
  assert.equal(old.ttsModel, DEFAULT_PREFERENCES.ttsModel);
  const manual = normalizePreferences({ ...DEFAULT_PREFERENCES, asrModel: 'whisper-1' });
  assert.equal(manual.asrModel, LOCAL_ASR_MODEL);
  for (const version of [2, 3, 4, 5]) for (const model of ['browser', 'whisper-1', FIXED_MODELS.asr, 'unknown']) {
    assert.equal(normalizePreferences({ ...DEFAULT_PREFERENCES, speechDefaultsVersion: version, asrModel: model }).asrModel, LOCAL_ASR_MODEL);
  }
});

test('停止本地识别时未完成的连接返回后立即关闭，不开启录音或执行指令', async () => {
  const saved = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let resolve, closed;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: class {}, AudioWorkletNode: class {} } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: assert.fail } } });
  try {
    const local = createLocalSpeechInput({ onState() {}, onText: assert.fail, onCommand: assert.fail,
      client: { create: () => new Promise(done => { resolve = done; }), close: async id => { closed = id; } } });
    local.toggleHandsFree(); local.stop(); resolve({ id: 'late-session' });
    await new Promise(done => setImmediate(done));
    assert.equal(local.handsFree, false); assert.equal(closed, 'late-session');
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test('本地音频逐块回显，播报重置旧句并丢弃晚到的快门结果', async () => {
  const saved = new Map(['window', 'navigator', 'document', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let node, calls = 0, reset = 0, resolve, closed = 0;
  const drafts = [], commands = [];
  class Context {
    sampleRate = 16000; audioWorklet = { addModule: async () => {} };
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Worklet { port = {}; constructor() { node = this; } connect() {} disconnect() {} }
  const globals = { window: { AudioContext: Context, AudioWorkletNode: Worklet }, document: { hidden: false }, AudioWorkletNode: Worklet,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] }) } } };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let local;
  try {
    local = createLocalSpeechInput({ onState() {}, onText: text => drafts.push(text), onCommand: text => commands.push(text), client: {
      create: async () => ({ id: 'local-id' }), close: async () => { closed++; }, reset: async () => { reset++; },
      audio: async () => {
        calls++;
        if (calls === 3) return new Promise(done => { resolve = done; });
        return { mode: 'LOCAL', results: [{ text: '拍摄', final: calls !== 1, segment: calls >= 4 ? 2 : 0 }] };
      },
    } });
    local.toggleHandsFree(); await new Promise(done => setImmediate(done));
    const frame = () => node.port.onmessage({ data: new Float32Array(1600).buffer });
    frame(); await new Promise(done => setImmediate(done));
    assert.deepEqual(drafts, ['拍摄']); assert.deepEqual(commands, []);
    frame(); await new Promise(done => setImmediate(done)); assert.deepEqual(commands, ['拍摄']);
    frame(); local.playback(true);
    resolve({ mode: 'LOCAL', results: [{ text: '拍摄', final: true, segment: 1 }] });
    await new Promise(done => setImmediate(done));
    assert.equal(reset, 1); assert.deepEqual(commands, ['拍摄']);
    local.playback(false); frame(); await new Promise(done => setImmediate(done));
    assert.deepEqual(commands, ['拍摄', '拍摄']);
    local.stop(); assert.equal(closed, 1);
  } finally {
    local?.stop();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test('首次加载、旧浏览器默认值和恢复默认使用云端，后续手选浏览器会保留', () => {
  assert.equal(DEFAULT_PREFERENCES.asrModel, LOCAL_ASR_MODEL);
  assert.equal(DEFAULT_PREFERENCES.ttsModel, SPEECH_PROFILES.uniapi.tts);
  assert.deepEqual(readPreferences({ getItem() { return null; } }), DEFAULT_PREFERENCES);
  const old = { asrModel: 'browser', ttsModel: 'browser', grid: false, cloudWorkspace: 'workspace-123' };
  const migrated = readPreferences({ getItem() { return JSON.stringify(old); } });
  assert.equal(migrated.asrModel, LOCAL_ASR_MODEL);
  assert.equal(migrated.ttsModel, SPEECH_PROFILES.uniapi.tts);
  assert.equal(migrated.grid, false);
  assert.equal(migrated.cloudWorkspace, 'workspace-123');
  assert.equal(migrated.speechDefaultsVersion, 5);
  let saved;
  const storage = { setItem(key, value) { saved = value; }, getItem() { return saved; } };
  savePreferences(storage, { ...migrated, asrModel: 'browser', ttsModel: 'browser' });
  assert.equal(readPreferences(storage).asrModel, LOCAL_ASR_MODEL);
  assert.equal(readPreferences(storage).ttsModel, 'browser');
  savePreferences(storage, { ...DEFAULT_PREFERENCES });
  assert.equal(readPreferences(storage).asrModel, LOCAL_ASR_MODEL);
  assert.equal(readPreferences(storage).ttsModel, SPEECH_PROFILES.uniapi.tts);
});

test('语音默认迁移至 UniAPI，百炼仅在新版手选时保留，两套云端模型都走后端', () => {
  const old = normalizePreferences({ speechDefaultsVersion: 2, asrModel: FIXED_MODELS.asr, ttsModel: FIXED_MODELS.tts });
  assert.equal(old.voiceProvider, 'uniapi');
  assert.equal(old.asrModel, LOCAL_ASR_MODEL); assert.equal(old.ttsModel, SPEECH_PROFILES.uniapi.tts);
  const selected = normalizePreferences({ ...DEFAULT_PREFERENCES, voiceProvider: 'dashscope', asrModel: FIXED_MODELS.asr, ttsModel: FIXED_MODELS.tts });
  assert.equal(selected.voiceProvider, 'dashscope'); assert.equal(selected.asrModel, LOCAL_ASR_MODEL);
  for (const profile of Object.values(SPEECH_PROFILES)) { assert.equal(isCloudAsr(profile.asr), true); assert.equal(isCloudTts(profile.tts), true); }
  assert.equal(isCloudAsr('browser'), false); assert.equal(isCloudTts('unknown'), false);
});

test('LLM 默认汇云，迁移旧版百炼默认配置，保留后续手选和其他服务商', () => {
  assert.equal(DEFAULT_PREFERENCES.modelBaseUrl, 'https://zgc.apihy.com/v1');
  assert.equal(DEFAULT_PREFERENCES.modelName, 'qwen3.5-27b');
  assert.equal(DEFAULT_PREFERENCES.llmProfile, 'existing');
  const old = { modelBaseUrl: LLM_PROFILES.recommended.url, modelName: FIXED_MODELS.llm, llmProfile: 'recommended' };
  assert.equal(normalizePreferences(old).modelBaseUrl, DEFAULT_PREFERENCES.modelBaseUrl);
  assert.equal(normalizePreferences({ ...old, modelDefaultsVersion: 2 }).modelName, FIXED_MODELS.llm);
  assert.equal(normalizePreferences({ ...old, llmProfile: 'custom' }).modelName, FIXED_MODELS.llm);
  assert.equal(normalizePreferences({ modelBaseUrl: LLM_PROFILES.campus.url, modelName: 'qwen' }).llmProfile, 'campus');
});

test('Gemini TTS 迁移旧默认且保留新版手选备用模型和浏览器', () => {
  assert.equal(DEFAULT_PREFERENCES.ttsModel, 'gemini-3.8-flash-lite-tts');
  assert.equal(normalizePreferences({ voiceProvider: 'uniapi', speechDefaultsVersion: 3, ttsModel: 'tts-1' }).ttsModel, 'gemini-3.8-flash-lite-tts');
  assert.equal(normalizePreferences({ voiceProvider: 'uniapi', speechDefaultsVersion: 4, ttsModel: 'tts-1' }).ttsModel, 'tts-1');
  assert.equal(normalizePreferences({ speechDefaultsVersion: 4, ttsModel: 'browser' }).ttsModel, 'browser');
  assert.equal(isCloudTts('gemini-3.8-flash-lite-tts'), true);
  assert.equal(isCloudTts('tts-1'), true);
});

test('云端录音先检测短句，静音和短噪声不上传，长句限制在十秒左右', () => {
  const buffer = createUtteranceBuffer(16000);
  const silence = new Float32Array(1600), speech = new Float32Array(1600).fill(.1);
  for (let i = 0; i < 20; i++) assert.equal(buffer.push(silence), null);
  for (let i = 0; i < 3; i++) assert.equal(buffer.push(speech), null);
  for (let i = 0; i < 6; i++) assert.equal(buffer.push(silence), null);
  const utterance = buffer.push(silence);
  assert.ok(utterance.length >= 16000 && utterance.length <= 20000);
  assert.equal(utterance[1600], speech[0]);
  buffer.push(speech);
  for (let i = 0; i < 7; i++) assert.equal(buffer.push(silence), null);
  let long = null;
  for (let i = 0; i < 100 && !long; i++) long = buffer.push(speech);
  assert.ok(long.length <= 161600);
  buffer.reset(); assert.equal(buffer.push(silence), null);
});

test('麦克风 PCM 在编码 WAV 前重采样到 16kHz', () => {
  const output = resample16k(new Float32Array(48000).fill(.25), 48000);
  assert.equal(output.length, 16000);
  assert.equal(output[500], .25);
  assert.equal(resample16k(new Float32Array(16000), 16000).length, 16000);
  assert.throws(() => resample16k(new Float32Array(8000), 8000));
});

test('轻声短口令可以进入 ASR，低电平底噪和瞬时声音不上传', () => {
  const buffer = createUtteranceBuffer(16000);
  const frame = value => new Float32Array(320).fill(value);
  for (let i = 0; i < 100; i++) assert.equal(buffer.push(frame(.001)), null);
  for (let i = 0; i < 8; i++) assert.equal(buffer.push(frame(.006)), null);
  assert.ok(buffer.level > .004);
  let utterance;
  for (let i = 0; i < 40; i++) utterance ||= buffer.push(frame(0));
  assert.ok(utterance instanceof Float32Array);
  assert.equal(buffer.level, 0);
  buffer.reset(); buffer.push(frame(.1));
  for (let i = 0; i < 40; i++) assert.equal(buffer.push(frame(0)), null);
});

test('云端麦克风短句经 WAV 转写后回填文本，并识别为快门口令', async () => {
  const saved = new Map(['window', 'document', 'navigator', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const states = [], drafts = [], commands = [];
  let node, stopped = false, uploaded, temporarilyBusy = false;
  class Context {
    sampleRate = 16000;
    audioWorklet = { addModule: async () => {} };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Worklet {
    port = {};
    constructor() { node = this; }
    connect() {}
    disconnect() {}
  }
  const globals = { window: { AudioContext: Context, AudioWorkletNode: Worklet }, document: { hidden: false }, AudioWorkletNode: Worklet,
    navigator: { mediaDevices: { getUserMedia: async options => {
      assert.deepEqual(options.audio.deviceId, { exact: 'physical-mic' });
      assert.equal(options.audio.noiseSuppression, false);
      return { getTracks: () => [{ label: '实体测试麦克风', stop() { stopped = true; }, addEventListener() {} }] };
    } } } };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let speech;
  try {
    speech = createCloudSpeechInput({ cloud: { require: () => 'test-session', transcribe: async wav => {
      if (temporarilyBusy) throw Object.assign(new Error('语音识别 ASR：供应商上游满载'), { status: 503 });
      uploaded = wav; return '請拍照';
    } },
      audioOptions: () => ({ deviceId: 'physical-mic', processing: false }),
      onState: state => states.push(state), onText: text => drafts.push(text), onCommand: text => commands.push(parseCommand(text).type) });
    speech.toggleHandsFree();
    await new Promise(done => setImmediate(done));
    const frame = value => ({ data: new Float32Array(320).fill(value).buffer });
    for (let i = 0; i < 8; i++) await node.port.onmessage(frame(.006));
    for (let i = 0; i < 40; i++) await node.port.onmessage(frame(0));
    assert.equal(uploaded.type, 'audio/wav');
    assert.deepEqual(drafts, ['請拍照']); assert.deepEqual(commands, ['CAPTURE']);
    assert.ok(states.some(state => state.message === '正在识别云端语音…'));
    assert.equal(speech.handsFree, true);
    assert.equal(states.at(-1).listening, true);
    assert.equal(states.at(-1).deviceLabel, '实体测试麦克风');
    temporarilyBusy = true;
    for (let i = 0; i < 8; i++) await node.port.onmessage(frame(.006));
    for (let i = 0; i < 40; i++) await node.port.onmessage(frame(0));
    assert.equal(speech.handsFree, true, '短暂上游满载不关闭麦克风');
    assert.match(states.at(-1).message, /本句未重试/);
    assert.equal(stopped, false);
    assert.deepEqual(commands, ['CAPTURE'], '失败句不触发拍照');
  } finally {
    speech?.stop();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
  assert.equal(stopped, true);
});

test('麦克风默认使用原始音频，显式选择设备不会静默退回默认输入', () => {
  assert.deepEqual(microphoneConstraints(), { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  const chosen = microphoneConstraints({ deviceId: 'device-123', processing: true });
  assert.deepEqual(chosen.audio.deviceId, { exact: 'device-123' });
  assert.equal(chosen.audio.echoCancellation, true);
  const prefs = normalizePreferences({ microphoneDeviceId: 'device-123', microphoneProcessing: true });
  assert.equal(prefs.microphoneDeviceId, 'device-123'); assert.equal(prefs.microphoneProcessing, true);
});

test('设置只持久化普通偏好，不保存密钥、会话或带凭据的地址', () => {
  let saved;
  const storage = { setItem(key, value) { saved = value; }, getItem() { return saved; } };
  assert.equal(savePreferences(storage, { ...DEFAULT_PREFERENCES, grid: false, delay: '5', voiceRate: 1.2,
    apiKey: 'fake-secret', connectionId: 'private-session', reference: 'private-image' }), true);
  assert.deepEqual(readPreferences(storage), { ...DEFAULT_PREFERENCES, grid: false, delay: '5', voiceRate: 1.2 });
  for (const secret of ['fake-secret', 'private-session', 'private-image']) assert.equal(saved.includes(secret), false);
  for (const url of ['https://user:fake-secret@example.com/v1', 'https://example.com/v1?key=fake-secret', 'https://example.com/v1#fake-secret']) {
    assert.equal(normalizePreferences({ modelBaseUrl: url }).modelBaseUrl, DEFAULT_PREFERENCES.modelBaseUrl);
  }
});

test('损坏或不可访问的设置存储不阻止启动，参数使用有效范围', () => {
  assert.deepEqual(readPreferences({ getItem() { return '{broken'; } }), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences({ getItem() { throw Error('blocked'); } }), DEFAULT_PREFERENCES);
  assert.equal(savePreferences({ setItem() { throw Error('blocked'); } }, DEFAULT_PREFERENCES), false);
  const value = normalizePreferences({ grid: 'false', voiceEnabled: false, delay: '99', voiceRate: 900, voiceVolume: -2,
    modelBaseUrl: 'http://example.com/v1', modelName: '<invalid>' });
  assert.deepEqual(value, { ...DEFAULT_PREFERENCES, voiceEnabled: false, voiceVolume: 0 });
  assert.equal(normalizePreferences({ voiceVolume: NaN }).voiceVolume, 1);
  assert.equal(normalizePreferences({ modelBaseUrl: 'https://api.uniapi.io/v1/' }).modelBaseUrl, 'https://api.uniapi.io/v1');
});

test('实机语音只识别直接的单步转向口令', () => {
  assert.equal(spokenYawDirection('相机向左转一点。'), 'LEFT');
  assert.equal(spokenYawDirection('请镜头往右微转一下！'), 'RIGHT');
  for (const phrase of ['不要向左转', '如果相机向左转一点', '相机向左转一点然后向右转', '相机向右转一点？', '相机往前']) {
    assert.equal(spokenYawDirection(phrase), null);
  }
});

test('腕部取景使用指定 USB 设备，缺失时不改用内置摄像头', async () => {
  const streams = [];
  const cameras = [
    { kind: 'videoinput', deviceId: 'integrated', label: 'Integrated Webcam' },
    { kind: 'videoinput', deviceId: 'wrist', label: 'USB CAMERA (10bb:2b08)' },
  ];
  const devices = {
    enumerateDevices: async () => cameras,
    getUserMedia: async options => { streams.push(options); return 'wrist-stream'; },
  };
  assert.equal(await openWristCamera(devices, 'USB CAMERA'), 'wrist-stream');
  assert.deepEqual(streams[0].video.deviceId, { exact: 'wrist' });
  await assert.rejects(openWristCamera(devices, 'Missing camera'), /找不到腕部摄像头/);
  assert.equal(streams.length, 1);
});

test('描述要拍的照片时，明确的画幅和四格区域从文字或语音转写直接设置', () => {
  const four = { type: 'POSITION_BODY', cells: [3, 4, 6, 7] };
  assert.deepEqual(parseCommand('我要拍一张左下四格的照片'), four);
  assert.deepEqual(parseCommand('拍一张左下角四格的照片呀'), four);
  assert.deepEqual(parseCommand('我要拍一张一比一画幅的照片'), { type: 'RATIO', ratio: '1:1' });
  assert.deepEqual(parseCommand('请把画幅调成九比十六'), { type: 'RATIO', ratio: '9:16' });
  assert.deepEqual(parseCommand('切换到原始比例'), { type: 'RATIO', ratio: 'original' });
  const head = { type: 'POSITION_HEAD', part: 'head', cells: [2], ratio: '1:1' };
  assert.deepEqual(parseCommand('1：1，让人物的头在右上角'), head);
  assert.deepEqual(parseCommand('一比一画幅让人物的头在右上角'), head);
  assert.equal(parseCommand('让树在左上四格，人在右下四格').type, 'CLARIFY');
  assert.equal(parseCommand('一比一，或者用十六比九').type, 'CLARIFY');
});
import { gridLabel, parseGridCells } from '../src/main/resources/static/js/grid.js';

test('放大、构图和机位意图保持区分', () => {
  assert.equal(parseCommand('放大一点').type, 'ZOOM');
  assert.equal(parseCommand('人物在画面中靠左一点').type, 'COMPOSE');
  assert.deepEqual(parseCommand('相机向左一点'), { type: 'MOVE', direction: 'LEFT' });
  assert.deepEqual(parseCommand('相机靠近一点'), { type: 'CAMERA_DISTANCE', direction: 'NEARER' });
  assert.deepEqual(parseCommand('相机拉远一点'), { type: 'CAMERA_DISTANCE', direction: 'FARTHER' });
  assert.deepEqual(parseCommand('缩小一点'), { type: 'ZOOM', delta: -.15 });
  assert.equal(parseCommand('相机向左再向右').type, 'CLARIFY');
});

test('停止优先，否定拍摄不触发快门', () => {
  assert.equal(parseCommand('停止拍照').type, 'STOP');
  assert.equal(parseCommand('不要拍照').type, 'CLARIFY');
  assert.equal(parseCommand('不要停止').type, 'CLARIFY');
  assert.equal(parseCommand('不要拍照，停止').type, 'STOP');
  assert.equal(parseCommand('怎么拍照').type, 'CLARIFY');
  assert.equal(parseCommand('拍照').type, 'CAPTURE');
  assert.equal(parseCommand('重拍').type, 'RETAKE');
  assert.equal(parseCommand('给我动作建议').type, 'GUIDE');
  assert.deepEqual(parseCommand('居中的半身照。'), { type: 'COMPOSE', composition: 'center', framing: 'half' });
  assert.deepEqual(parseCommand('右三分的全身照'), { type: 'COMPOSE', composition: 'right', framing: 'full' });
  assert.equal(parseCommand('三分构图').type, 'CLARIFY');
  assert.equal(parseCommand('半身还是全身').type, 'CLARIFY');
});

const target = { composition: 'center', framing: 'half' };
const person = { x: .1, y: .15, width: .24, height: .65, confidence: .9 };
const frame = (timestamp, box = null) => ({ frameId: timestamp, timestamp, width: 480, height: 320, person: box });

test('人物进入、移动、离开与重新站稳按顺序输出', () => {
  const tracker = createVisionTracker();
  assert.equal(tracker.update(frame(500), target).status, 'empty');
  assert.equal(tracker.update(frame(1000, person), target).status, 'acquiring');
  tracker.update(frame(1250, person), target);
  const start = tracker.update(frame(1500, person), target);
  assert.equal(start.status, 'moving');
  assert.equal(start.horizontal, '人物偏左');
  assert.equal(start.adjustment.type, 'SUBJECT_RIGHT');
  assert.equal(start.occupancy, person.width * person.height);
  assert.equal(tracker.update(frame(2000, person), target).stable, true);
  assert.equal(tracker.update(frame(2250, { ...person, x: .3 }), target).stable, false);
  assert.equal(tracker.update(frame(2100, person), target), null);
  assert.equal(tracker.update(frame(2500), target).status, 'reacquiring');
  assert.equal(tracker.update(frame(2750, person), target).status, 'moving');
  tracker.update(frame(3250, person), target);
  assert.equal(tracker.update(frame(3750, person), target).stable, true);
  assert.equal(tracker.update(frame(5500, person), target).stable, false);
  assert.equal(tracker.update(frame(6500), target).status, 'lost');
});

test('三分线、占比与原始画面坐标保持一致', () => {
  const small = { x: .58, y: .3, width: .17, height: .31, confidence: .93 };
  const result = composeAdvice(frame(1000, small), { composition: 'right', framing: 'full' });
  assert.equal(result.horizontal, '位置接近目标');
  assert.equal(result.framing, '人物占比过小');
  assert.equal(result.adjustment.type, 'ENLARGE_SUBJECT');
  assert.deepEqual(fitFrame(640, 480, 1200, 800), { x: (1200 - 640 * 800 / 480) / 2, y: 0, width: 640 * 800 / 480, height: 800 });
});

test('位置符合时开放拍摄，使用最新一帧且无需等待站稳', () => {
  const tracked = (id, x, y) => ({
    id, position: { x, y }, person: { x: x - .06, y: y - .05, width: .12, height: .1 },
  });
  const reading = people => ({ timestamp: 1000, status: 'moving', stable: false, people });
  const from = (people, composition = 'center', targets = new Map(), now = 1100) =>
    capturePositionHint(reading(people), composition, targets, { now });
  const left = tracked(1, .33, .25);
  const right = tracked(2, .74, .72);
  assert.equal(from([left], 'left'), '');
  assert.match(from([tracked(1, .18, .25)]), /构图区域/);
  assert.equal(from([tracked(1, .44, .25), tracked(2, .55, .72)]), '');
  const targets = new Map([[1, { composition: 'left' }], [2, { cells: [8] }]]);
  assert.equal(from([left, right], 'center', targets), '');
  assert.match(from([left, tracked(2, .74, .35)], 'center', targets), /人物 2 的大部分/);
  assert.match(from([left], 'center', targets), /人物 2 回到/);
  assert.match(from([]), /出现在/);
  assert.match(from([left, right], 'center', targets, 2600), /更新/);
  assert.match(capturePositionHint({ status: 'error' }, 'center', targets, { now: 1100 }), /暂不可用/);
});

test('不限景别时只判断可见人物框是否超过一半进入目标区域', () => {
  const partial = { x: .42, y: 0, width: .2, height: .3 };
  const report = (box, cells) => capturePositionHint({ timestamp: 1000, people: [{ id: 1, person: box }] }, 'center',
    new Map([[1, { cells }]]), { now: 1005 });
  assert.equal(composeAdvice(frame(1000, partial), { composition: 'center', framing: 'any' }).framing, '');
  assert.equal(report(partial, [1]), '');
  assert.match(report({ x: .24, y: .1, width: .52, height: .7 }, [4]), /大部分/);
  assert.match(report({ x: .4, y: 0, width: .2, height: 2 / 3 }, [1]), /大部分/);
  assert.equal(report({ x: 0, y: 0, width: 1, height: 1 }, [0, 1, 2, 6, 7, 8]), '');
});

test('头部目标使用脸部中心，单人即使没有人物框也可以拍', () => {
  const headTarget = { part: 'head', cells: [8] };
  const face = { x: .75, y: .74, width: .11, height: .12 };
  const offTarget = { ...face, y: .2 };
  const reading = (faces, people = []) => ({ timestamp: 1000, faces, people, stable: false });
  const now = 1005;
  const head = value => capturePositionHint(value, 'center', new Map(), { now, headTarget });
  assert.equal(head(reading([face])), '');
  assert.match(head(reading([offTarget])), /头部进入/);
  assert.match(head(reading([])), /暂未看清/);
  assert.match(head(reading(null)), /模型/);
  assert.match(head(reading([face, offTarget])), /指定人物/);

  const targets = new Map([[2, headTarget]]);
  const people = [{ id: 1, face }, { id: 2, face: offTarget }];
  const forNumber = entries => capturePositionHint(reading([face, offTarget], entries), 'center', targets, { now });
  assert.match(forNumber(people), /人物 2 的头部/);
  assert.equal(forNumber([{ id: 1, face: offTarget }, { id: 2, face }]), '');
});

test('头部目标跟随当前裁剪画幅，框外的脸无法满足九宫格目标', () => {
  const face = { x: .588, y: .73, width: .035, height: .05 };
  const raw = { width: 1200, height: 800, timestamp: 1000, people: [], faces: [face] };
  const options = { now: 1010, headTarget: { part: 'head', cells: [8] } };
  const check = crop => capturePositionHint(cropVisionFrame(raw, crop), 'center', new Map(), options);
  assert.match(check(cropRegion(1200, 800, { ratio: 'original', cx: .5, cy: .5, zoom: 1 })), /进入目标区域/);
  assert.equal(check(cropRegion(1200, 800, { ratio: '3:4', cx: .5, cy: .5, zoom: 1 })), '');
  assert.match(check(cropRegion(1200, 800, { ratio: '3:4', cx: .30, cy: .5, zoom: 1.5 })), /进入当前裁剪框/);
});

test('人物位置按裁剪后仍可见的框计算，整个人在画幅外时不会达标', () => {
  const raw = { width: 1200, height: 800, timestamp: 1000, people: [
    { id: 1, person: { x: .43, y: .37, width: .30, height: .19 } },
    { id: 2, person: { x: .08, y: .28, width: .13, height: .25 } },
  ] };
  const cropped = cropVisionFrame(raw, { x: .25, y: 0, width: .30, height: 1 });
  const rightColumn = { cells: [2, 5, 8] };
  assert.equal(capturePositionHint(cropped, 'center', new Map([[1, rightColumn]]), { now: 1010 }), '');
  assert.match(capturePositionHint(cropped, 'center', new Map([[2, rightColumn]]), { now: 1010 }), /人物 2 进入当前裁剪框/);
  assert.match(capturePositionHint(raw, 'center', new Map([[1, rightColumn]]), { now: 1010 }), /大部分/);
  assert.equal(raw.people[0].person.width, .30);
});

test('中文头部与角落指令保留九宫格及各人物目标', () => {
  const examples = ['让人物的头在右下角', '请把头部放到画面右下格', '头在右下一格', '让人的头在右下角'];
  for (const phrase of examples) assert.deepEqual(parseCommand(phrase), { type: 'POSITION_HEAD', part: 'head', cells: [8] });
  assert.deepEqual(parseCommand('人物1的头放到右下角，人物2在左上四格'), {
    type: 'POSITION_PEOPLE', targets: [{ id: 1, part: 'head', cells: [8] }, { id: 2, cells: [0, 1, 3, 4] }],
  });
  assert.deepEqual(parseCommand('取消头部目标'), { type: 'CLEAR_HEAD_TARGET' });
  assert.deepEqual(parseCommand('不限景别'), { type: 'COMPOSE', framing: 'any' });
});

test('九宫格理解相邻四格、单格、任意组合并保留三分线预设', () => {
  assert.deepEqual(parseGridCells('左下四格'), [3, 4, 6, 7]);
  assert.deepEqual(parseGridCells('中上一格'), [1]);
  assert.deepEqual(parseGridCells('把左上一格和第9格'), [0, 8]);
  assert.equal(gridLabel([3, 4, 6, 7]), '左下四格');
  assert.equal(parseGridCells('左下五格'), null);
  assert.deepEqual(parseCommand('人物1左下四格，人物2中上一格，人物3右三分'), {
    type: 'POSITION_PEOPLE',
    targets: [{ id: 1, cells: [3, 4, 6, 7] }, { id: 2, cells: [1] }, { id: 3, composition: 'right' }],
  });
  assert.deepEqual(parseCommand('中上一格'), { type: 'POSITION_SELECTED', cells: [1] });
  assert.equal(parseCommand('人物1左下五格').type, 'CLARIFY');
  const sample = frame(1000, { x: .55, y: .55, width: .12, height: .24, confidence: .9 });
  assert.equal(composeAdvice(sample, { composition: 'center', framing: 'half', cells: [3, 4, 6, 7] }).horizontal, '人物大部分已进入目标区域');
  assert.equal(composeAdvice(sample, { composition: 'center', framing: 'half', cells: [1] }).adjustment.type, 'SUBJECT_UP');
});

test('编号构图指令独立指定目标，拒绝互相冲突的描述', () => {
  assert.deepEqual(parseCommand('人物1放左三分，人物2放右三分'), {
    type: 'POSITION_PEOPLE', targets: [{ id: 1, composition: 'left' }, { id: 2, composition: 'right' }],
  });
  assert.deepEqual(parseCommand('请让一号人物居中，再让第二个人站在右边'), {
    type: 'POSITION_PEOPLE', targets: [{ id: 1, composition: 'center' }, { id: 2, composition: 'right' }],
  });
  assert.deepEqual(parseCommand('选择人物2'), { type: 'SELECT_PERSON', id: 2 });
  assert.equal(parseCommand('人物1左边又右边').type, 'CLARIFY');
  assert.equal(parseCommand('人物1左边，人物1右边').type, 'CLARIFY');
  assert.equal(parseCommand('人物1左三分，人物2').type, 'CLARIFY');
  assert.equal(parseCommand('人物1左三分，停止').type, 'STOP');
});

test('多人编号独立于置信度次序，交错移动时沿各自轨迹保持编号', () => {
  const tracker = createVisionTracker();
  const at = (x, confidence = .9) => ({ x, y: .2, width: .17, height: .55, confidence });
  const update = (timestamp, people) => tracker.update({ ...frame(timestamp, people[0]), people }, target);
  update(500, [at(.61, .99), at(.16, .85)]);
  update(750, [at(.16, .99), at(.61, .85)]);
  const first = update(1000, [at(.61, .99), at(.16, .85)]);
  assert.deepEqual(first.people.map(p => [p.id, p.person.x]), [[1, .16], [2, .61]]);
  assert.deepEqual(update(1250, [at(.26, .99), at(.51, .85)]).people.map(p => p.id), [1, 2]);
  update(1500, [at(.41), at(.36)]);
  const crossed = update(1750, [at(.31), at(.46)]);
  assert.deepEqual(crossed.people.map(p => [p.id, p.person.x]), [[1, .46], [2, .31]]);
  assert.deepEqual(update(2000, [at(.56)]).people.map(p => p.id), [1]);
  assert.deepEqual(update(2250, [at(.66), at(.12)]).people.map(p => p.id), [1, 2]);
  assert.deepEqual(update(3500, [at(.66), at(.12)]).people.map(p => p.id), [1, 2]);
});

test('三人快速移动、漏检和重复框不会多发人物编号', () => {
  const tracker = createVisionTracker();
  const at = (x, confidence = .9) => ({ x, y: .16, width: .16, height: .58, confidence });
  const update = (timestamp, people) => tracker.update({ ...frame(timestamp, people[0]), people }, target);
  const original = [at(.07), at(.39), at(.72)];
  assert.deepEqual(update(1000, original).people, []);
  assert.deepEqual(update(1250, [...original].reverse()).people, []);
  assert.deepEqual(update(1500, original).people.map(p => p.id), [1, 2, 3]);
  const hidden = update(1750, [at(.40), at(.73)]);
  assert.deepEqual(hidden.people.map(p => p.id), [2, 3]);
  assert.deepEqual(hidden.occluded, [1]);
  const ghost = { ...at(.22, .55), y: .8, height: .13 };
  const duplicate = at(.263, .52);
  const moved = [at(.73, .99), at(.255), at(.41), duplicate, ghost];
  for (const time of [2000, 2250]) {
    assert.deepEqual(update(time, moved).people.map(p => p.id), [1, 2, 3]);
  }
  assert.deepEqual(update(2500, moved.filter(box => box !== ghost)).people.map(p => p.id), [1, 2, 3]);
  assert.deepEqual(update(3000, moved.filter(box => box !== ghost)).people.map(p => p.id), [1, 2, 3]);
});

test('编号回收保留已设置目标的编号并限制标签总量', () => {
  const tracker = createVisionTracker();
  const a = { ...person, x: .05 };
  const b = { ...person, x: .62 };
  const pinned = new Set();
  const update = (timestamp, box) => tracker.update(frame(timestamp, box), { ...target, pinnedIds: pinned });
  for (const time of [500, 750, 1000]) update(time, a);
  pinned.add(1);
  update(5400, b);
  update(5650, b);
  assert.deepEqual(update(5900, b).people.map(p => p.id), [2]);
  pinned.delete(1);
  update(10300, a);
  update(10550, a);
  assert.deepEqual(update(10800, a).people.map(p => p.id), [1]);
});

test('所有可选比例与放大级别始终在原片边界内', () => {
  for (const ratio of ['original', '1:1', '4:3', '3:4', '16:9', '9:16']) {
    for (const zoom of [1, 1.15, 2.5]) {
      for (const cx of [0, .5, 1]) {
        for (const cy of [0, .5, 1]) {
          const rect = cropRect(1200, 800, { ratio, zoom, cx, cy });
          assert.ok(rect.x >= -1e-8 && rect.y >= -1e-8);
          assert.ok(rect.x + rect.w <= 1200 + 1e-8);
          assert.ok(rect.y + rect.h <= 800 + 1e-8);
          const expected = ratio === 'original' ? 1.5 : ratio.split(':').map(Number).reduce((a, b) => a / b);
          assert.ok(Math.abs(rect.w / rect.h - expected) < 1e-8);
        }
      }
    }
  }
});

test('拖动四角保持比例和对角锚点，并遵守缩放与原片边界', () => {
  const base = { ratio: '3:4', zoom: 1.4, cx: .5, cy: .5 };
  const before = cropRect(1200, 800, base);
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const east = corner.endsWith('e');
    const south = corner.startsWith('s');
    const anchor = rect => [east ? rect.x : rect.x + rect.w, south ? rect.y : rect.y + rect.h];
    const inward = resizeCrop(1200, 800, base, corner, east ? -80 : 80, south ? -110 : 110);
    const outward = resizeCrop(1200, 800, base, corner, east ? 500 : -500, south ? 500 : -500);
    assert.ok(inward.zoom > base.zoom && inward.zoom <= 2.5);
    assert.ok(outward.zoom >= 1 && outward.zoom < base.zoom);
    for (const update of [inward, outward]) {
      const rect = cropRect(1200, 800, { ...base, ...update });
      assert.ok(Math.abs(rect.w / rect.h - .75) < 1e-8);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1200 && rect.y + rect.h <= 800);
      assert.ok(anchor(rect).every((value, index) => Math.abs(value - anchor(before)[index]) < 1e-8));
    }
  }
  assert.equal(resizeCrop(1200, 800, base, 'se', -9999, -9999).zoom, 2.5);
});

test('裁剪预览复用画布，按相同裁剪坐标绘制并保留原片', () => {
  const source = { width: 1200, height: 800 };
  const calls = [];
  const target = { width: 0, height: 0, getContext: () => ({
    clearRect: (...args) => calls.push(['clear', ...args]),
    drawImage: (...args) => calls.push(['draw', ...args]),
  }) };
  const first = { ratio: '3:4', zoom: 1, cx: .5, cy: .5 };
  assert.equal(renderCrop(source, first, target), target);
  assert.deepEqual(calls.pop(), ['draw', source, 300, 0, 600, 800, 0, 0, 600, 800]);
  calls.length = 0;
  renderCrop(source, { ...first, cx: .65 }, target);
  assert.deepEqual(calls, [
    ['clear', 0, 0, 600, 800],
    ['draw', source, 480, 0, 600, 800, 0, 0, 600, 800],
  ]);
  assert.deepEqual(source, { width: 1200, height: 800 });
});
import { isAiCommand } from '../src/main/resources/static/js/ai.js';
import { liveCompositionCue } from '../src/main/resources/static/js/vision.js';
import { createSpeechInput, createVoiceGuide, dispatchSpeechText } from '../src/main/resources/static/js/voice.js';

test('浏览器与云端共享清空口令处理，清空草稿不提交模型或设备指令', () => {
  let draft = '已有内容';
  const commands = [];
  const receive = text => dispatchSpeechText(text, value => { draft = value; }, value => commands.push(value));
  for (const phrase of ['清空', '重来', '请帮我把输入框里的内容清空一下吧']) {
    draft = '已有内容'; receive(phrase); assert.equal(draft, '');
  }
  assert.deepEqual(commands, []);
  for (const phrase of ['清除头部目标', '重置相机', '不要清空', '拍照']) receive(phrase);
  assert.deepEqual(commands, ['清除头部目标', '重置相机', '不要清空', '拍照']);
  assert.equal(draft, '拍照');
});

test('a spoken photo request sets grid placement and framing together without firing the shutter', () => {
  const phrase = '我需要拍一张人物在右下四格的半身照';
  const target = { type: 'POSITION_BODY', cells: [4, 5, 7, 8], framing: 'half' };
  assert.deepEqual(parseCommand(phrase), target);
  assert.deepEqual(parseCommand('帮我拍一张半身照，人物站在右下四格'), target);
  assert.deepEqual(parseCommand('我想要拍一张人物1在右下四格的全身照'), {
    type: 'POSITION_PEOPLE', targets: [{ id: 1, cells: [4, 5, 7, 8] }], framing: 'full',
  });
  assert.deepEqual(parseCommand('拍摄。'), { type: 'CAPTURE' });
  assert.equal(isSpokenShutter('现在开始拍摄！'), true);
  assert.equal(isSpokenShutter('我想知道为什么可以拍照了'), false);
  assert.equal(isSpokenShutter('不要拍照'), false);
  assert.equal(isSpokenShutter(phrase), false);
});

test('hands-free input discards results from playback and starts listening again after the prompt', async () => {
  const recognitions = [];
  const heard = [];
  const reports = [];
  let restarted;
  class Recognition {
    constructor() { recognitions.push(this); }
    start() { this.onstart(); restarted?.(); }
    abort() { this.aborted = true; this.onend(); }
    result(transcript) {
      this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal: true })] });
    }
  }
  const speech = createSpeechInput({ Recognition, onState: state => reports.push(state), onText: () => {},
    onCommand: text => heard.push(text) });
  speech.toggleHandsFree();
  const first = recognitions[0];
  assert.equal(first.continuous, true);
  speech.playback(true);
  first.result('拍摄');
  assert.equal(first.aborted, true);
  assert.equal(heard.length, 0);
  await new Promise(resolve => { restarted = resolve; speech.playback(false); });
  const second = recognitions[1];
  second.result('拍摄');
  second.result('拍摄');
  assert.deepEqual(heard, ['拍摄']);
  speech.stop();
  assert.equal(second.aborted, true);
  assert.equal(reports.at(-1).handsFree, false);
});

test('voice clear commands empty the draft and keep listening without submitting', () => {
  let engine;
  let draft = '';
  const submitted = [];
  const results = [];
  class Recognition {
    constructor() { engine = this; }
    start() { this.onstart(); }
    abort() { this.onend(); }
  }
  const speech = createSpeechInput({ Recognition, onState: () => {}, onText: text => { draft = text; },
    onCommand: text => submitted.push(text) });
  const say = (transcript, isFinal = true) => {
    results.push(Object.assign([{ transcript }], { isFinal }));
    engine.onresult({ resultIndex: results.length - 1, results });
  };
  speech.toggleHandsFree();
  for (const phrase of ['清除', '清空。', '重来！', '重置', '请帮我把输入框里的内容清空一下吧', '重新来一次', '删掉刚才的文字']) {
    draft = '已有内容';
    say(phrase);
    assert.equal(draft, '', phrase);
  }
  draft = '未完成的输入';
  say('清空', false);
  assert.equal(draft, '未完成的输入');
  assert.deepEqual(submitted, []);
  assert.equal(speech.handsFree, true);

  for (const phrase of ['清除头部目标', '重置相机', '不要清空', '重新拍摄', '放大一点']) {
    say(phrase);
    assert.equal(draft, phrase);
    assert.equal(submitted.at(-1), phrase);
  }
  speech.stop();
});

test('AI photography requests route separately from capture, person targets and emergency stop', () => {
  assert.equal(isAiCommand('让树在左上四格，人在右下四格', 'CLARIFY'), true);
  assert.equal(isAiCommand('模仿这张参考图，帮我看看姿势', 'GUIDE'), true);
  assert.equal(isAiCommand('AI 帮我分析画面', 'CLARIFY'), true);
  assert.equal(isAiCommand('AI 停止', 'STOP'), false);
  assert.equal(isAiCommand('拍照', 'CAPTURE'), false);
  assert.equal(isAiCommand('人物1左下四格，人物2中上一格', 'POSITION_PEOPLE'), false);
  assert.equal(isAiCommand('AI 已完成', 'GUIDE_DONE'), false);
});

test('live speech guides the subject in the current frame and uses the same readiness as the shutter', () => {
  const now = 2000;
  const person = (id, x) => ({ id, position: { x, y: .5 }, person: { x: x - .06, y: .2, width: .12, height: .6 } });
  const reading = { status: 'moving', timestamp: now, people: [person(1, .8)] };
  assert.equal(liveCompositionCue(reading, 'center', new Map(), { now }), '请往画面左侧挪一点。');
  assert.equal(liveCompositionCue({ ...reading, people: [person(1, .5)] }, 'center', new Map(), { now }), '构图已到位，可以拍了。');
  const bodyTarget = { cells: [4, 5, 7, 8] };
  assert.equal(liveCompositionCue(reading, 'center', new Map(), { now, bodyTarget }), '构图已到位，可以拍了。');
  assert.equal(liveCompositionCue({ ...reading, people: [person(1, .2)] }, 'center', new Map(), { now, bodyTarget }), '请往画面右侧挪一点。');
  assert.equal(liveCompositionCue(reading, 'center', new Map(), { now: now + 1800 }), '');
  const targets = new Map([[1, { composition: 'right' }], [2, { composition: 'right' }]]);
  assert.equal(liveCompositionCue({ ...reading, people: [person(1, .7), person(2, .2)] }, 'center', targets, { now }), '人物 2，请往画面右侧挪一点。');
  const face = { x: .74, y: .75, width: .1, height: .1 };
  assert.equal(liveCompositionCue({ ...reading, faces: [face] }, 'center', new Map(), { now, headTarget: { part: 'head', cells: [2] } }), '请把头往画面上方挪一点。');
  assert.deepEqual(parseCommand('我已完成，继续。'), { type: 'GUIDE_DONE' });
});

test('工作台启用严格景别，通用构图判断仍支持景别参考模式', () => {
  const now = 7300;
  const box = { x: .32, y: .08, width: .36, height: .92 };
  const face = { x: .46, y: .12, width: .08, height: .08 };
  const point = (x, y) => ({ x, y });
  const halfPose = { nose: point(.5, .15), leftShoulder: point(.40, .27), rightShoulder: point(.60, .27),
    leftHip: point(.43, .78), rightHip: point(.57, .79) };
  const fullPose = { ...halfPose, leftHip: point(.43, .53), rightHip: point(.57, .53),
    leftKnee: point(.43, .71), rightKnee: point(.57, .71), leftAnkle: point(.43, .90), rightAnkle: point(.57, .90),
    leftHeel: point(.43, .93), rightHeel: point(.57, .94), leftToe: point(.45, .95), rightToe: point(.59, .96) };
  const frame = pose => cropVisionFrame({ timestamp: now, faces: [face], poses: [pose], people: [{ id: 1, face, person: { ...box, pose } }] },
    { x: 0, y: 0, width: 1, height: 1 });
  const goals = new Map();
  const options = { headTarget: { cells: [1], part: 'head' }, framing: 'half', now };
  assert.equal(capturePositionHint(frame({ nose: halfPose.nose }), 'center', goals, options), '');
  assert.equal(liveCompositionCue(frame({ nose: halfPose.nose }), 'center', goals, options), '构图已到位，可以拍了。');
  assert.equal(capturePositionHint(frame({ ...halfPose, nose: point(.5, .73) }), 'center', goals, options), '');
  assert.equal(capturePositionHint(frame(halfPose), 'center', goals, options), '');
  assert.equal(capturePositionHint(frame(fullPose), 'center', goals, options), '');
  assert.equal(capturePositionHint(frame(halfPose), 'center', goals, { ...options, framing: 'full', skipPosition: true }), '');
  assert.equal(capturePositionHint(frame(fullPose), 'center', goals, { ...options, framing: 'full' }), '');
  assert.equal(capturePositionHint(frame({}), 'center', goals, { ...options, framing: 'any' }), '');
  const strict = { ...options, strictFraming: true };
  assert.match(capturePositionHint(frame({ nose: halfPose.nose }), 'center', goals, strict), /腰胯/);
  assert.match(liveCompositionCue(frame({ nose: halfPose.nose }), 'center', goals, strict), /腰胯/);
  assert.equal(capturePositionHint(frame(halfPose), 'center', goals, strict), '');
  assert.match(capturePositionHint(frame(fullPose), 'center', goals, strict), /下边缘/);
  assert.match(capturePositionHint(frame(halfPose), 'center', goals, { ...strict, framing: 'full', skipPosition: true }), /双脚/);
  assert.equal(capturePositionHint(frame(fullPose), 'center', goals, { ...strict, framing: 'full' }), '');
  assert.equal(capturePositionHint(frame({}), 'center', goals, { ...strict, framing: 'any' }), '');
  assert.equal(capturePositionHint({ status: 'error' }, 'center', goals, { ...options, framing: 'full', skipPosition: true }), '');
});

test('voice feedback waits for a consistent cue, deduplicates it and cancels when stopped', () => {
  const messages = [];
  const synthesis = { speak(message) { messages.push(message); }, cancel() { messages.push('cancel'); } };
  class Utterance { constructor(text) { this.text = text; } }
  const voice = createVoiceGuide({ synthesis, Utterance, onError: assert.fail });
  voice.observe('向左', 0);
  voice.observe('向左', 900);
  assert.equal(messages.length, 0);
  voice.setEnabled(true);
  voice.observe('向左', 0);
  voice.observe('向右', 500);
  voice.observe('向左', 550);
  voice.observe('向左', 1250);
  assert.equal(messages[0].text, '向左');
  const first = messages[0];
  first.onend();
  voice.observe('向左', 2400);
  voice.observe('向左', 3200);
  assert.equal(messages.length, 1);
  voice.observe('构图到位', 3300);
  voice.observe('构图到位', 4100);
  assert.equal(messages[1].text, '构图到位');
  voice.speak('放松肩膀');
  assert.deepEqual(messages.slice(2).map(message => message.text || message), ['cancel', '放松肩膀']);
  first.onend();
  voice.setEnabled(false);
  assert.equal(messages.at(-1), 'cancel');
  assert.equal(voice.speak('不应播放'), false);
});

test('播报使用所选语速和音量，关闭后不继续说话', () => {
  const messages = [];
  const synthesis = { speak(message) { messages.push(message); }, cancel() {} };
  class Utterance { constructor(text) { this.text = text; } }
  const voice = createVoiceGuide({ synthesis, Utterance, onError: assert.fail });
  voice.configure({ rate: 1.2, volume: .4 });
  voice.setEnabled(true);
  voice.speak('试听');
  assert.equal(messages[0].rate, 1.2);
  assert.equal(messages[0].volume, .4);
  voice.setEnabled(false);
  assert.equal(voice.speak('已关闭'), false);
  assert.equal(messages.length, 1);
});

test('取消云端合成后丢弃晚到的音频，不转为浏览器播报', async () => {
  let resolve, signal;
  const playback = [];
  const voice = createVoiceGuide({ synthesis: { speak: assert.fail }, Utterance: class {}, useCloud: () => true,
    synthesize: (text, rate, inputSignal) => { signal = inputSignal; return new Promise(done => { resolve = done; }); },
    onError: assert.fail, onPlayback: value => playback.push(value) });
  voice.setEnabled(true);
  voice.speak('测试');
  await Promise.resolve();
  voice.cancel();
  assert.equal(signal.aborted, true);
  resolve(new Blob(['not-played']));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(playback, [], '等待 TTS 合成和取消未播放音频均不应暂停 ASR');
});

test('云端合成失败明确报错，不伪造音频或自动切换模型', async () => {
  const errors = [], playback = [], status = [];
  const voice = createVoiceGuide({ useCloud: () => true, synthesize: async () => { throw Error('语音配置已过期'); },
    onStatus: (phase, message) => status.push([phase, message]),
    onError: error => errors.push(error.message), onPlayback: value => playback.push(value) });
  voice.setEnabled(true); voice.speak('测试');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['语音配置已过期']);
  assert.deepEqual(playback, [], 'TTS 失败不能中断 ASR 收听');
  assert.deepEqual(status, [['loading', undefined], ['error', '语音配置已过期']]);
  assert.equal(voice.busy, false);
});

test('等待合成时立即报告状态，取消后不播放晚到音频', async () => {
  const status = [];
  let resolve;
  const voice = createVoiceGuide({ useCloud: () => true,
    synthesize: () => new Promise(done => { resolve = done; }), onError: assert.fail,
    onStatus: phase => status.push(phase) });
  voice.setEnabled(true); voice.speak('试听');
  assert.equal(voice.busy, true);
  assert.deepEqual(status, ['loading']);
  await Promise.resolve();
  voice.cancel(); resolve(new Blob(['ignored']));
  await new Promise(done => setImmediate(done));
  assert.equal(voice.busy, false);
  assert.deepEqual(status, ['loading', 'cancelled']);
});

test('主动停止试听显示简短提示，内部重置不冒充用户取消', async () => {
  const status = [];
  const voice = createVoiceGuide({ useCloud: () => true,
    synthesize: () => new Promise(() => {}), onError: assert.fail,
    onStatus: (phase, message) => status.push([phase, message]) });
  voice.setEnabled(true); voice.speak('试听');
  await Promise.resolve();
  voice.cancel('试听已停止。');
  assert.deepEqual(status.at(-1), ['cancelled', '试听已停止。']);
  voice.speak('再试听');
  await Promise.resolve();
  voice.reset();
  assert.deepEqual(status.at(-1), ['cancelled', '']);
  assert.equal(voice.busy, false);
});

test('Whisper 繁体快门口令可以直接拍照，否定口令和停止保持正确优先级', () => {
  for (const text of ['請拍照', '請拍攝。', '幫我拍一張照片']) {
    assert.equal(isSpokenShutter(text), true);
    assert.equal(parseCommand(text).type, 'CAPTURE');
  }
  assert.equal(parseCommand('請勿拍攝').type, 'CLARIFY');
  assert.equal(parseCommand('別拍照').type, 'CLARIFY');
  assert.equal(isSpokenShutter('別拍照'), false);
  assert.equal(parseCommand('別動').type, 'STOP');
});

test('音量为零给出提示，避免消耗云端调用后静音', () => {
  const status = [];
  const voice = createVoiceGuide({ useCloud: () => true, synthesize: assert.fail, onError: assert.fail,
    onStatus: (phase, message) => status.push([phase, message]) });
  voice.setEnabled(true); voice.configure({ volume: 0 });
  assert.equal(voice.speak('试听'), false);
  assert.equal(status[0][0], 'error');
  assert.match(status[0][1], /音量为 0/);
  assert.equal(voice.busy, false);
});

test('真实播放开始和结束才报告相应状态，浏览器阻止播放时保留原因', async () => {
  const original = globalThis.Audio, status = [], errors = [];
  let audio, rejectPlayback = false;
  globalThis.Audio = class {
    constructor() { audio = this; }
    pause() {}
    play() { return rejectPlayback ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : Promise.resolve(); }
  };
  const voice = createVoiceGuide({ useCloud: () => true, synthesize: async () => new Blob(['test']),
    onError: error => errors.push(error.message), onStatus: (phase, message) => status.push([phase, message]) });
  try {
    voice.setEnabled(true); voice.speak('试听');
    await new Promise(done => setImmediate(done));
    assert.deepEqual(status.map(item => item[0]), ['loading', 'playing']);
    audio.onended();
    assert.equal(voice.busy, false);
    assert.equal(status.at(-1)[0], 'ended');
    rejectPlayback = true; voice.speak('再次试听');
    await new Promise(done => setImmediate(done));
    assert.equal(status.at(-1)[0], 'error');
    assert.match(status.at(-1)[1], /浏览器阻止/);
    assert.match(errors[0], /允许本站播放声音/);
    assert.equal(voice.busy, false);
  } finally {
    voice.cancel();
    if (original === undefined) delete globalThis.Audio;
    else globalThis.Audio = original;
  }
});

test('三维机位支持前后、上下和俯仰，混合方向指令需要先明确一步', () => {
  const mode = { depthMovement: true };
  assert.deepEqual(parseCommand('相机靠近一点', mode), { type: 'MOVE', direction: 'FORWARD' });
  assert.deepEqual(parseCommand('镜头往后退', mode), { type: 'MOVE', direction: 'BACKWARD' });
  assert.equal(parseCommand('相机向右前进', mode).type, 'CLARIFY');
  assert.deepEqual(parseCommand('相机向上', mode), { type: 'MOVE', direction: 'UP' });
  assert.deepEqual(parseCommand('镜头降低一点', mode), { type: 'MOVE', direction: 'DOWN' });
  assert.equal(parseCommand('相机向前并抬高', mode).type, 'CLARIFY');
  assert.deepEqual(parseCommand('镜头抬头一点', mode), { type: 'MOVE', direction: 'PITCH_UP' });
  assert.deepEqual(parseCommand('相机低头一点', mode), { type: 'MOVE', direction: 'PITCH_DOWN' });
  assert.equal(parseCommand('镜头抬头一点').type, 'CLARIFY');
  assert.equal(parseCommand('相机抬头并升高', mode).type, 'CLARIFY');
  assert.equal(parseCommand('拉近一点', mode).type, 'ZOOM');
});

test('录音编码为真实 PCM WAV，并拒绝超过时长的输入', async () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0]), 16000);
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(wav.type, 'audio/wav');
  assert.equal(view.byteLength, 52);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
  assert.throws(() => encodeWav(new Float32Array(16000 * 16), 16000));
});
