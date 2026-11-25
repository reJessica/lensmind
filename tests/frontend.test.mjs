// 可选开发检查：Node.js 20+，无第三方依赖，不参与页面运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/main/resources/static/js/commands.js';
import { cropRect } from '../src/main/resources/static/js/crop.js';
import { encodeWav } from '../src/main/resources/static/js/ai-client.js';

test('放大、构图和机位意图保持区分', () => {
  assert.equal(parseCommand('放大一点').type, 'ZOOM');
  assert.equal(parseCommand('人物在画面中靠左一点').type, 'COMPOSE');
  assert.deepEqual(parseCommand('相机向左一点'), { type: 'MOVE', direction: 'LEFT' });
  assert.equal(parseCommand('相机靠近一点').type, 'CLARIFY');
  assert.equal(parseCommand('相机向左再向右').type, 'CLARIFY');
});

test('停止优先，否定拍摄不触发快门', () => {
  assert.equal(parseCommand('停止拍照').type, 'STOP');
  assert.equal(parseCommand('不要拍照').type, 'CLARIFY');
  assert.equal(parseCommand('拍照').type, 'CAPTURE');
  assert.equal(parseCommand('居中半身照').type, 'COMPOSE');
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
