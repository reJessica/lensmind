// 可选开发检查：Node.js 20+，无第三方依赖，不参与页面运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSpokenShutter, parseCommand, spokenYawDirection } from '../src/main/resources/static/js/commands.js';
import { cropRect, cropRegion, renderCrop, resizeCrop } from '../src/main/resources/static/js/crop.js';
import { capturePositionHint, composeAdvice, createVisionTracker, cropVisionFrame, fitFrame } from '../src/main/resources/static/js/vision.js';
import { encodeWav } from '../src/main/resources/static/js/ai-client.js';
import { openWristCamera } from '../src/main/resources/static/js/wrist-camera.js';

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
import { createSpeechInput, createVoiceGuide } from '../src/main/resources/static/js/voice.js';

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

test('half and full shots require actual pose in the crop even when a tracked head is on target', () => {
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
  assert.match(capturePositionHint(frame({ nose: halfPose.nose }), 'center', goals, options), /腰胯/);
  assert.match(liveCompositionCue(frame({ nose: halfPose.nose }), 'center', goals, options), /腰胯/);
  assert.match(capturePositionHint(frame({ ...halfPose, nose: point(.5, .73) }), 'center', goals, options), /腰胯/);
  assert.equal(capturePositionHint(frame(halfPose), 'center', goals, options), '');
  assert.match(capturePositionHint(frame(fullPose), 'center', goals, options), /下边缘/);
  assert.match(capturePositionHint(frame(halfPose), 'center', goals, { ...options, framing: 'full', skipPosition: true }), /双脚/);
  assert.equal(capturePositionHint(frame(fullPose), 'center', goals, { ...options, framing: 'full' }), '');
  assert.equal(capturePositionHint(frame({}), 'center', goals, { ...options, framing: 'any' }), '');
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
