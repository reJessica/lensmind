// 运行真实 app.js 与语音模块；仅模拟 DOM、网络和扬声器，不调用云端或设备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('摄影助手独立朗读文字回答，失败不关闭后续播报，关闭偏好及离页后不播报', async () => {
  class Element extends EventTarget {
    value = ''; textContent = ''; hidden = false; checked = false; disabled = false;
    dataset = {}; children = []; options = [{ value: '' }]; width = 1280; height = 720;
    style = { setProperty() {} };
    classList = { add() {}, remove() {}, toggle() {} };
    attributes = new Map();
    add(node) { this.options.push(node); }
    append(...nodes) { this.children.push(...nodes); }
    prepend(node) { this.children.unshift(node); }
    insertBefore(node, before) { node.parentElement = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
    replaceChildren(...nodes) { this.children = nodes; this.options = nodes; }
    get firstElementChild() { return this.children[0] ??= new Element(); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); }
    querySelectorAll() { return []; }
    close() {} focus() {}
    getContext() { return { canvas: this, clearRect() {}, fillRect() {}, drawImage() {} }; }
    toDataURL() { return 'data:image/jpeg;base64,TEST'; }
    async play() { this.readyState = 2; this.videoWidth = 1280; this.videoHeight = 720; }
  }
  const html = await readFile(new URL('../src/main/resources/static/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const get = id => { assert.ok(elements.has(id), `真实页面缺少 ${id}`); return elements.get(id); };
  const doc = Object.assign(new EventTarget(), {
    hidden: false, getElementById: get, querySelectorAll: () => [],
    createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
  });
  const win = Object.assign(new EventTarget(), { scrollTo() {} });
  const saved = new Map();
  for (const name of ['document', 'window', 'location', 'Image', 'Option', 'Audio', 'fetch', 'setInterval', 'setTimeout', 'cancelAnimationFrame', 'requestAnimationFrame', 'navigator']) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  const track = Object.assign(new EventTarget(), { stop() {} });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) } } });
  const originalTimeout = globalThis.setTimeout;
  let attempts = 0, played = 0, fail = false, lastAudio, movementRequests = 0, deviceState = 'IDLE', offline = false, holdSpeech = false, releaseSpeech, ttsSignal;
  const statusPolls = [];
  const ttsTexts = [];
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  Object.assign(globalThis, {
    document: doc, window: win, location: { hash: '#studio' },
    Image: class {}, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    Audio: class { constructor() { lastAudio = this; } pause() {} async play() { played++; } },
    setInterval: (callback, delay) => { if (delay === 4000) statusPolls.push(callback); return 0; }, cancelAnimationFrame() {}, requestAnimationFrame: () => 0,
    setTimeout: (...args) => { const timer = originalTimeout(...args); timer.unref(); return timer; },
    fetch: async (path, options = {}) => {
      if (path === '/api/ai/session') return response({ connected: true, id: 'llm', model: 'qwen3.5-27b', host: 'example.test', expiresAt: new Date(Date.now() + 600000).toISOString() });
      if (path === '/api/ai/speech/session') return response({ configured: true, id: 'tts', provider: 'uniapi', asr: 'browser', tts: 'gemini-3.8-flash-lite-tts', expiresAt: new Date(Date.now() + 600000).toISOString() });
      if (path === '/api/device/calibration') return response({ required: false, ready: true });
      if (path === '/api/device/status') return offline ? response({ message: '控制服务未连接' }, 503) : response({ connected: true, mode: 'MOCK', state: deviceState, x: 0, y: 0 });
      if (path === '/api/device/move') { movementRequests++; return response({ connected: true, mode: 'MOCK', state: 'IDLE' }); }
      if (path === '/api/ai/analyze') {
        const motion = JSON.parse(options.body).prompt === '相机向左一点';
        return response({ summary: '内部分析摘要，不应作为播报内容。', feedback: motion ? '已生成向左微调计划，等待控制端执行。' : '可以使用柔和的侧光。',
          steps: [], observations: [], targets: [], settings: null,
          controlPlan: { fileName: 'lensmind-plan-test.json', downloadUrl: '/api/ai/control-plans/test',
            plan: { schemaVersion: 'lensmind.motion.v1', executed: false, actions: motion ? [{ type: 'MOVE', direction: 'LEFT', step: 1 }] : [] } } });
      }
      if (path === '/api/ai/speech/tts') {
        attempts++; ttsTexts.push(JSON.parse(options.body).text);
        if (holdSpeech) { ttsSignal = options.signal; return new Promise(done => { releaseSpeech = () => done(new Response(new Blob(['audio']), { headers: { 'Content-Type': 'audio/wav' } })); }); }
        return fail ? response({ message: '上游负载已饱和' }, 503) : new Response(new Blob(['audio']), { headers: { 'Content-Type': 'audio/wav' } });
      }
      throw Error(`未预期的请求 ${path}`);
    },
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };
  const ask = async (text = '灯光应该怎么布置？') => {
    get('command-input').value = text;
    get('command-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  try {
    await import('../src/main/resources/static/js/app.js');
    await settle();
    assert.equal(get('settings-asr-model').disabled, true);
    assert.equal(get('settings-asr-model').options.length, 1, '仅保留本地识别');
    get('speech-config-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    assert.equal(get('settings-asr-model').disabled, true, '保存 TTS 不应重新启用 ASR 切换');
    await ask();
    assert.notEqual(get('mic-button').getAttribute('aria-pressed'), 'true', '未开启麦克风');
    assert.equal(played, 1, '文字提问也应播放 TTS');
    assert.equal(ttsTexts[0], get('ai-summary').textContent);
    assert.equal(get('voice-status').hidden, false);
    assert.equal(get('voice-status').textContent, '正在朗读回答…');
    lastAudio.onended();
    fail = true; await ask();
    assert.match(get('voice-status').textContent, /语音播报失败.*上游负载已饱和/);
    assert.equal(attempts, 2, '失败不自动重试');
    fail = false; await ask();
    assert.equal(played, 2, '上一句失败不应关闭下一句朗读');
    get('settings-voice-enabled').checked = false;
    get('settings-voice-enabled').dispatchEvent(new Event('change'));
    await ask();
    assert.equal(attempts, 3, '关闭朗读不调用 TTS');
    get('settings-voice-enabled').checked = true;
    get('settings-voice-enabled').dispatchEvent(new Event('change'));
    await ask();
    assert.equal(played, 3);
    await ask('相机向左一点');
    assert.equal(movementRequests, 0, '模型连接后机位调整仅生成计划，不能直接发起移动');
    assert.match(get('ai-plan-json').textContent, /LEFT/);
    assert.equal(get('ai-plan-json').textContent.includes('feedback'), false, '控制 JSON 不混入播报文本');
    assert.equal(ttsTexts.at(-1), '已生成向左微调计划，等待控制端执行。');
    assert.equal(get('ai-plan-download').href, '/api/ai/control-plans/test');
    get('settings-delay').value = '0';
    get('settings-delay').dispatchEvent(new Event('change'));
    assert.equal(get('capture-button').disabled, false, `人物检测加载时快门可用：${get('capture-hint').textContent} / ${get('camera-status').textContent}`);
    await ask('给我动作建议');
    assert.equal(get('guide-done').hidden, false);
    await ask('拍摄');
    assert.equal(get('gallery-count').textContent, '01', '指导未完成且没有人物检测结果时，说拍摄也应成片');
    assert.equal(get('guide-done').hidden, true, '拍摄会结束当前动作指导');
    await ask('拍摄');
    assert.equal(get('gallery-count').textContent, '02', '无需等人物完整入镜即可继续拍摄');
    deviceState = 'MOVING';
    await ask('拍摄');
    assert.equal(get('gallery-count').textContent, '02', '控制端运动状态仍应拦截');
    deviceState = 'IDLE'; offline = true; holdSpeech = true;
    await ask();
    assert.equal(get('voice-status').textContent, '正在合成语音…');
    await statusPolls[0](); await settle();
    assert.equal(ttsSignal.aborted, false, '控制服务断连不能取消正在合成的回答');
    releaseSpeech(); await settle();
    assert.equal(played, 6, '设备断连时云端晚到音频仍应播放');
    lastAudio.onended();
    offline = false; holdSpeech = false; deviceState = 'STOPPED';
    await statusPolls[0](); await settle();
    await ask();
    assert.equal(played, 7, '机械臂停止锁定不应禁止后续主动提问的朗读');
    globalThis.location.hash = '#gallery';
    win.dispatchEvent(new Event('hashchange'));
    await ask();
    assert.equal(attempts, 8, '离开拍摄页不发起新播报');
  } finally {
    win.dispatchEvent(new Event('pagehide'));
    await settle();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
