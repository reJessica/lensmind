// 运行真实 app.js 与语音模块；仅模拟 DOM、网络和扬声器，不调用云端或设备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cropRegion } from '../src/main/resources/static/js/crop.js';

test('摄影助手朗读文字回答与参考图指导，离开拍摄页后停止', async t => {
  class Element extends EventTarget {
    value = ''; textContent = ''; hidden = false; checked = false; disabled = false;
    dataset = {}; children = []; options = [{ value: '' }]; width = 1280; height = 720;
    style = { setProperty() {} };
    classList = { add() {}, remove() {}, toggle() {} };
    attributes = new Map();
    add(node) { this.options.push(node); }
    append(...nodes) { this.children.push(...nodes); }
    insertBefore(node, before) {
      this.children = this.children.filter(child => child !== node);
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
      node.remove = () => { this.children = this.children.filter(child => child !== node); };
    }
    prepend(node) { this.children.unshift(node); }
    replaceChildren(...nodes) { this.children = nodes; this.options = nodes; }
    get firstElementChild() { return this.children[0] ??= new Element(); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); }
    querySelectorAll() { return []; }
    close() {} focus() {}
    getContext() { return { canvas: this, clearRect() {}, drawImage() {}, fillRect() {} }; }
    toBlob(callback) { callback(new Blob(['test.jpeg'])); }
    toDataURL() { return 'data:image/jpeg;base64,dGVzdA=='; }
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
  for (const name of ['document', 'window', 'location', 'Image', 'Option', 'Audio', 'fetch', 'setInterval',
    'setTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'createImageBitmap']) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  const originalTimeout = globalThis.setTimeout;
  let attempts = 0, played = 0, fail = false, lastAudio, movementRequests = 0;
  let visionTick, planRequest, visionBox, legacyBackend = false;
  const plan = { ratio: '1:1', framing: 'half', composition: null, cells: [4, 5, 7, 8],
    personBox: { x: .51, y: .4, width: .44, height: .55 }, poseTip: '模仿示例姿势，放松肩膀。' };
  const ttsTexts = [];
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  Object.assign(globalThis, {
    document: doc, window: win, location: { hash: '#studio' },
    Image: class {}, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    Audio: class { constructor() { lastAudio = this; } pause() {} async play() { played++; } },
    setInterval: (tick, ms) => { if (ms === 250) visionTick = tick; return 0; },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    createImageBitmap: async () => ({ width: 800, height: 800, close() {} }),
    setTimeout: (...args) => { const timer = originalTimeout(...args); timer.unref(); return timer; },
    fetch: async (path, options = {}) => {
      if (path === '/api/ai/session') return response({ connected: true, id: 'llm', model: 'qwen3.5-27b', host: 'example.test',
        expiresAt: new Date(Date.now() + 600000).toISOString(), ...(legacyBackend ? {} : { referencePlan: true }) });
      if (path === '/api/ai/speech/session') return response({ configured: true, id: 'tts', provider: 'uniapi', asr: 'browser', tts: 'gemini-3.8-flash-lite-tts', expiresAt: new Date(Date.now() + 600000).toISOString() });
      if (path === '/api/device/calibration') return response({ required: false, ready: true });
      if (path === '/api/device/status') return response({ connected: true, mode: 'MOCK', state: 'IDLE', x: 0, y: 0 });
      if (path === '/api/device/move') { movementRequests++; return response({ connected: true, mode: 'MOCK', state: 'IDLE' }); }
      if (path.startsWith('/api/vision/person?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        return response({ frameId: Number(query.get('frameId')), timestamp: Number(query.get('timestamp')),
          width: 480, height: 270, people: visionBox ? [{ ...visionBox, confidence: .99 }] : [] });
      }
      if (path === '/api/ai/analyze') {
        const body = JSON.parse(options.body);
        if (body.mode === 'reference-plan') { planRequest = body; return response({ referencePlan: plan }); }
        const motion = body.prompt === '相机向左一点';
        return response({ summary: '内部分析摘要，不应作为播报内容。', feedback: motion ? '已生成向左微调计划，等待控制端执行。' : '可以使用柔和的侧光。',
          steps: [], observations: [], targets: [], settings: null,
          controlPlan: { fileName: 'lensmind-plan-test.json', downloadUrl: '/api/ai/control-plans/test',
            plan: { schemaVersion: 'lensmind.motion.v1', executed: false, actions: motion ? [{ type: 'MOVE', direction: 'LEFT', step: 1 }] : [] } } });
      }
      if (path === '/api/ai/speech/tts') {
        attempts++; ttsTexts.push(JSON.parse(options.body).text);
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
    lastAudio.onended();

    await t.test('参考图一键应用画幅、半身和四格，进入站位框后播报姿势', async () => {
      const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
      const media = { getUserMedia: async () => ({ getVideoTracks: () => [], getTracks: () => [] }) };
      const video = get('camera-video');
      Object.assign(video, { videoWidth: 1280, videoHeight: 720, currentTime: 0, readyState: 2, play: async () => {} });
      Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true });
      try {
        get('camera-retry').dispatchEvent(new Event('click'));
        await settle();
      } finally {
        if (originalDevices) Object.defineProperty(navigator, 'mediaDevices', originalDevices);
        else delete navigator.mediaDevices;
      }
      assert.equal(get('camera-placeholder').hidden, true);
      const originalCrop = get('live-crop').style.width;
      get('ai-reference-file').files = [{ name: 'pose.png', type: 'image/png', size: 400 }];
      get('ai-reference-file').dispatchEvent(new Event('change'));
      await settle();
      assert.equal(planRequest, undefined, '本地选图不自动上传');
      get('command-input').value = '';
      legacyBackend = true;
      get('ai-connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      get('ai-analyze').dispatchEvent(new Event('click'));
      await settle();
      assert.equal(planRequest, undefined, '旧后端不会收到只包含参考图的新请求');
      assert.match(get('ai-status').textContent, /服务版本较旧/);
      legacyBackend = false;
      get('ai-connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      get('ai-analyze').dispatchEvent(new Event('click'));
      await settle();
      assert.equal(planRequest.reference, 'data:image/jpeg;base64,dGVzdA==');
      assert.equal(planRequest.scene, undefined, '只发送参考图');
      assert.equal(get('ai-reference-plan').hidden, false);
      assert.equal(get('ai-reference-settings').textContent, '1:1 · 半身 · 右下四格');
      assert.equal(get('ai-result').hidden, true);
      assert.equal(get('live-crop').style.width, originalCrop, '等用户应用才调整画幅');
      const startedAt = attempts;
      get('ai-apply-reference').dispatchEvent(new Event('click'));
      await settle();
      assert.equal(get('reference-person-frame').hidden, false);
      assert.equal(get('person-target-area').children.length, 4);
      assert.equal(attempts, startedAt + 1);
      assert.match(ttsTexts.at(-1), /对准虚线人物框/);
      assert.equal(movementRequests, 0);

      lastAudio.onended();
      const crop = cropRegion(1280, 720, { ratio: '1:1', zoom: 1.15, cx: .5, cy: .48 });
      const box = plan.personBox;
      visionBox = { x: crop.x + box.x * crop.width, y: crop.y + box.y * crop.height,
        width: box.width * crop.width, height: box.height * crop.height };
      assert.ok(Math.abs(parseFloat(get('live-crop').style.width) / 100 - crop.width) < .001);
      const now = Date.now();
      let tick = now;
      const time = t.mock.method(Date, 'now', () => tick);
      try {
        for (let i = 1; i <= 3; i++) {
          tick = now + i * 260;
          video.currentTime += .26;
          await visionTick();
        }
        await settle();
        assert.equal(get('reference-person-frame').firstElementChild.textContent, '站位已对齐');
        assert.equal(ttsTexts.at(-1), plan.poseTip);
        assert.equal(get('guide-done').hidden, false);
        get('ai-remove-reference').dispatchEvent(new Event('click'));
        assert.equal(get('reference-person-frame').hidden, true);
        assert.equal(get('guide-done').hidden, true);
      } finally { time.mock.restore(); }
    });

    const beforeLeaving = attempts;
    globalThis.location.hash = '#gallery';
    win.dispatchEvent(new Event('hashchange'));
    await ask();
    assert.equal(attempts, beforeLeaving, '离开拍摄页不发起新播报');
  } finally {
    win.dispatchEvent(new Event('pagehide'));
    await settle();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
