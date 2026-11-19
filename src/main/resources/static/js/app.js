import { deviceApi } from './api.js';
import { clamp, cropRect, renderCrop, positionFrame, attachDrag } from './crop.js';
import { parseCommand } from './commands.js';

const $ = id => document.getElementById(id);
const preview = $('preview');
const ctx = preview.getContext('2d');
const state = {
  device: null, online: false, stopped: false, busy: false, capturePending: false,
  epoch: 0, timer: null, stream: null, cameraPending: false, animation: null,
  composition: 'center', framing: 'half',
  crop: { ratio: '3:4', zoom: 1.15, cx: .5, cy: .48 },
  photos: [], selected: null, draft: null, undo: [],
  guide: -1, guidePending: false, recognition: null, listening: false,
};
const demoImage = new Image();
let toastTimer;

function log(message, error = false) {
  const row = document.createElement('li');
  row.classList.toggle('error', error);
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  row.append(time, document.createTextNode(message));
  $('activity-log').prepend(row);
  while ($('activity-log').children.length > 30) $('activity-log').lastChild.remove();
}

function notify(message, error = false) {
  log(message, error);
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function updateDevice(device) {
  state.device = device;
  state.online = device.connected;
  // 本地停止锁存到明确回初始位，避免较早的轮询结果覆盖停止状态。
  state.stopped = state.stopped || device.state === 'STOPPED';
  $('service-status').textContent = state.online ? (state.stopped ? '已停止 · 回初始位恢复' : '模拟控制服务已连接') : '设备已断开';
  $('service-dot').classList.toggle('offline', !state.online || state.stopped);
  $('position-label').textContent = `X ${device.x} · Y ${device.y}`;
  if (state.stopped || !state.online) {
    cancelCapture();
    $('preview-state').textContent = state.stopped ? '已停止' : '连接中断';
  }
  updateAvailability();
  if (!state.stream) drawDemo();
}

function updateAvailability() {
  const blocked = !state.online || state.stopped || state.busy || state.capturePending || state.guidePending || state.cameraPending;
  document.querySelectorAll('[data-direction]').forEach(button => { button.disabled = blocked; });
  $('capture-button').disabled = blocked;
  $('home-button').disabled = !state.online || state.busy || state.capturePending || state.guidePending;
}

async function pollStatus() {
  const epoch = state.epoch;
  try {
    const device = await deviceApi.status();
    if (epoch === state.epoch) updateDevice(device);
  } catch {
    if (epoch !== state.epoch) return;
    const wasOnline = state.online;
    state.online = false;
    cancelCapture();
    $('service-status').textContent = '控制服务未连接';
    $('service-dot').classList.add('offline');
    $('preview-state').textContent = '等待控制服务';
    updateAvailability();
    if (wasOnline) notify('控制服务断开，拍摄已取消。请检查 Spring Boot 服务。', true);
  }
}

function drawDemo() {
  if (!demoImage.complete || !demoImage.naturalWidth || state.stream) return;
  ctx.fillStyle = '#c8c9b9';
  ctx.fillRect(0, 0, preview.width, preview.height);
  const x = -(state.device?.x || 0) * 3;
  const y = (state.device?.y || 0) * 3;
  // 留出边缘余量，仅表现模拟机位变化，不执行真实坐标转换。
  ctx.drawImage(demoImage, -60 + x, -40 + y, 1320, 880);
}

function syncCrop() {
  positionFrame($('live-crop'), preview.width, preview.height, state.crop);
  $('zoom').value = state.crop.zoom;
  $('zoom-value').textContent = `${state.crop.zoom.toFixed(2)}×`;
  document.querySelectorAll('[data-ratio]').forEach(button => {
    button.classList.toggle('selected', button.dataset.ratio === state.crop.ratio);
    button.setAttribute('aria-pressed', button.dataset.ratio === state.crop.ratio);
  });
  for (const key of ['composition', 'framing']) {
    document.querySelectorAll(`[data-${key}]`).forEach(button => {
      button.classList.toggle('selected', button.dataset[key] === state[key]);
      button.setAttribute('aria-pressed', button.dataset[key] === state[key]);
    });
  }
}

function changeCrop() {
  cancelCapture();
  syncCrop();
}

function compose(composition, framing) {
  if (composition) {
    state.composition = composition;
    // 当前模拟人物约在 x=.5：保留左/右侧留白，使人物出现在相应三分线。
    state.crop.cx = composition === 'left' ? .62 : composition === 'right' ? .38 : .5;
  }
  if (framing) {
    state.framing = framing;
    state.crop.zoom = framing === 'half' ? 1.35 : 1;
    state.crop.cy = framing === 'half' ? .39 : .5;
  }
  changeCrop();
  notify('已更新数字裁剪示意；真实人物定位和构图闭环待接入。');
}

function cancelCapture() {
  if (state.capturePending) {
    state.epoch++;
    clearTimeout(state.timer);
    state.timer = null;
    state.capturePending = false;
    $('countdown-overlay').hidden = true;
    $('preview-state').textContent = '拍摄已取消';
    updateAvailability();
  }
}

async function stopAll() {
  state.epoch++;
  cancelCapture();
  state.stopped = true;
  state.guidePending = false;
  $('guide-done').hidden = true;
  state.recognition?.abort();
  window.speechSynthesis?.cancel();
  $('countdown-overlay').hidden = true;
  $('preview-state').textContent = '已停止';
  updateAvailability();
  // 停止请求独立直达控制端，不经过语音或构图逻辑。
  try {
    updateDevice(await deviceApi.stop());
    notify('已停止：倒计时和人物指导已取消，回初始位后恢复。');
  } catch (error) {
    state.online = false;
    $('service-status').textContent = '停止请求未确认';
    $('service-dot').classList.add('offline');
    updateAvailability();
    notify(`页面操作已取消；控制端停止未确认：${error.message}`, true);
  }
}

async function move(direction) {
  if (!state.online || state.stopped || state.busy || state.capturePending || state.guidePending) {
    notify('当前不能调整机位，请先完成指导、等待拍摄结束或回初始位。', true);
    return;
  }
  const epoch = state.epoch;
  state.busy = true;
  updateAvailability();
  $('preview-state').textContent = '模拟机位调整';
  try {
    const device = await deviceApi.move(direction);
    if (epoch !== state.epoch) return;
    updateDevice(device);
    $('preview-state').textContent = '模拟微调完成';
    log(device.message);
  } catch (error) {
    if (epoch === state.epoch) { $('preview-state').textContent = '调整暂停'; notify(error.message, true); }
  } finally {
    state.busy = false;
    updateAvailability();
  }
}

async function home() {
  if (state.busy || state.guidePending) return notify('请先完成当前操作或点击停止。');
  cancelCapture();
  const epoch = ++state.epoch;
  state.busy = true;
  updateAvailability();
  try {
    const device = await deviceApi.home();
    if (epoch !== state.epoch) return;
    state.stopped = false;
    updateDevice(device);
    $('preview-state').textContent = '等待拍摄';
    notify(device.message);
  } catch (error) { notify(error.message, true); }
  finally { state.busy = false; updateAvailability(); }
}

async function capture() {
  if (!state.online || state.stopped || state.busy || state.capturePending || state.guidePending || state.cameraPending || !demoImage.naturalWidth) {
    notify('暂时无法拍摄，请检查控制服务，完成当前操作或回初始位。', true);
    return;
  }
  if (state.photos.length >= 12) return notify('本次最多保留 12 张。请先下载，刷新页面后开启新一轮拍摄。');
  state.capturePending = true;
  const epoch = ++state.epoch;
  updateAvailability();
  try {
    const device = await deviceApi.status();
    if (epoch !== state.epoch) return;
    if (!device.connected || device.state !== 'IDLE') throw new Error('控制端尚未就绪，拍摄已取消');
    let remaining = Number($('delay').value);
    const tick = async () => {
      if (epoch !== state.epoch) return;
      if (remaining > 0) {
        $('countdown-overlay').textContent = remaining--;
        $('countdown-overlay').hidden = false;
        $('preview-state').textContent = '倒计时 · 请自行保持站稳';
        state.timer = setTimeout(tick, 1000);
        return;
      }
      try {
        const current = await deviceApi.status();
        if (epoch !== state.epoch) return;
        if (!current.connected || current.state !== 'IDLE') throw new Error('控制端状态变化，已取消拍摄');
        const original = document.createElement('canvas');
        original.width = preview.width;
        original.height = preview.height;
        original.getContext('2d').drawImage(preview, 0, 0);
        const photo = { id: Date.now(), original, crop: { ...state.crop }, time: new Date() };
        state.photos.unshift(photo);
        renderGallery();
        $('preview-state').textContent = '已拍摄';
        notify('已保存原片与裁剪结果，点击下方照片可编辑和下载。');
      } catch (error) { $('preview-state').textContent = '拍摄暂停'; notify(error.message, true); }
      finally {
        if (epoch === state.epoch) {
          state.capturePending = false;
          $('countdown-overlay').hidden = true;
          updateAvailability();
        }
      }
    };
    tick();
  } catch (error) { if (epoch === state.epoch) { cancelCapture(); notify(error.message, true); } }
}

function renderGallery() {
  $('gallery-empty').hidden = state.photos.length > 0;
  $('photo-count').textContent = state.photos.length;
  $('gallery-count').textContent = String(state.photos.length).padStart(2, '0');
  $('photo-list').replaceChildren();
  state.photos.forEach((photo, index) => {
    const card = document.createElement('article');
    card.className = 'photo-card';
    const button = document.createElement('button');
    button.setAttribute('aria-label', `编辑第 ${state.photos.length - index} 张照片，查看原片并下载`);
    const img = document.createElement('img');
    img.src = renderCrop(photo.original, photo.crop).toDataURL('image/jpeg', .85);
    img.alt = `第 ${state.photos.length - index} 张裁剪成片`;
    button.append(img);
    button.addEventListener('click', () => openPhoto(photo));
    const label = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = `作品 ${String(state.photos.length - index).padStart(2, '0')}`;
    const time = document.createElement('span');
    time.textContent = photo.time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    label.append(name, time);
    card.append(button, label);
    $('photo-list').append(card);
  });
}

function openPhoto(photo) {
  state.selected = photo;
  state.draft = { ...photo.crop };
  state.undo = [];
  const canvas = $('editor-canvas');
  canvas.width = photo.original.width;
  canvas.height = photo.original.height;
  canvas.getContext('2d').drawImage(photo.original, 0, 0);
  syncEditor();
  $('photo-dialog').showModal();
}

function syncEditor() {
  if (!state.selected) return;
  const { original } = state.selected;
  positionFrame($('editor-crop'), original.width, original.height, state.draft);
  $('editor-ratio').value = state.draft.ratio;
  $('editor-zoom').value = state.draft.zoom;
  const rect = cropRect(original.width, original.height, state.draft);
  $('photo-title').textContent = `原片与裁剪 · ${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  $('undo-crop').disabled = state.undo.length === 0;
}

function rememberCrop() { state.undo.push({ ...state.draft }); if (state.undo.length > 30) state.undo.shift(); }

function saveCrop() {
  state.selected.crop = { ...state.draft };
  renderGallery();
  notify('裁剪已保存，原片保持完整。');
}

function download(canvas, kind) {
  const photoId = state.selected.id;
  canvas.toBlob(blob => {
    if (!blob) return notify('导出失败，请重试。', true);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `LensMind-${photoId}-${kind}.jpg`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/jpeg', .95);
}

const guides = ['请看向镜头，轻轻放松肩膀。', '请将你的右肩稍稍向后转。', '请稍微抬起下巴，保持自然微笑。'];
function guide() {
  if (state.stopped || state.busy || state.capturePending) return notify('请先结束拍摄或恢复初始位。');
  if (state.guidePending) return notify('请先完成当前建议，再点击“已完成，继续”。');
  state.guide = (state.guide + 1) % guides.length;
  state.guidePending = true;
  const text = guides[state.guide];
  $('guide-text').textContent = `预设指导：${text}`;
  $('guide-done').hidden = false;
  $('preview-state').textContent = '人物指导 · 机位保持静止';
  updateAvailability();
  log(`人物指导（手动确认）：${text}`);
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(text);
    speech.lang = 'zh-CN';
    window.speechSynthesis.speak(speech);
  }
}

function runCommand(text) {
  if (!text.trim()) return;
  log(`你：${text}`);
  const command = parseCommand(text);
  switch (command.type) {
    case 'STOP': stopAll(); break;
    case 'HOME': home(); break;
    case 'CAPTURE': capture(); break;
    case 'MOVE': move(command.direction); break;
    case 'GUIDE': guide(); break;
    case 'ZOOM': state.crop.zoom = clamp(state.crop.zoom + command.delta, 1, 2.5); changeCrop(); notify('已调整数字裁剪，未移动机位。'); break;
    case 'COMPOSE': compose(command.composition, command.framing); break;
    default: notify(command.message); break;
  }
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('mic-button').addEventListener('click', () => {
    if (!SpeechRecognition) return notify('当前浏览器不支持语音识别，请使用文字输入，或尝试 Chrome。');
    if (state.listening) { state.recognition.stop(); return; }
    const recognition = new SpeechRecognition();
    state.recognition = recognition;
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.onstart = () => { state.listening = true; $('mic-button').classList.add('listening'); $('mic-button').setAttribute('aria-label', '结束语音识别'); };
    recognition.onend = () => { state.listening = false; $('mic-button').classList.remove('listening'); $('mic-button').setAttribute('aria-label', '开始语音识别'); };
    recognition.onresult = event => {
      const result = event.results[event.resultIndex];
      $('command-input').value = result[0].transcript;
      if (result.isFinal) runCommand(result[0].transcript);
    };
    recognition.onerror = event => { if (event.error !== 'aborted') notify(`语音识别未完成（${event.error}），可使用文字指令。`, true); };
    try { recognition.start(); } catch { notify('无法开启语音识别，请检查麦克风权限。', true); }
  });
}

async function toggleCamera() {
  cancelCapture();
  if (state.cameraPending) return;
  if (state.stream) { releaseCamera(); notify('已关闭摄像头，返回模拟场景。'); return; }
  if (!navigator.mediaDevices?.getUserMedia) return notify('无法访问摄像头，请通过 localhost 或 HTTPS 打开页面。', true);
  state.cameraPending = true;
  $('camera-button').disabled = true;
  updateAvailability();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1200 }, height: { ideal: 800 } }, audio: false });
    const video = $('camera-video');
    video.srcObject = state.stream;
    await video.play();
    // 固定画布大小，摄像头画面按比例完整放入，不镜像，不冒充末端摄像头。
    const draw = () => {
      if (!state.stream) return;
      const scale = Math.min(preview.width / video.videoWidth, preview.height / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      ctx.fillStyle = '#263b33'; ctx.fillRect(0, 0, preview.width, preview.height);
      ctx.drawImage(video, (preview.width - w) / 2, (preview.height - h) / 2, w, h);
      state.animation = requestAnimationFrame(draw);
    };
    state.stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { cancelCapture(); releaseCamera(); notify('摄像头连接中断，已取消拍摄并返回模拟场景。', true); }));
    draw();
    $('source-label').textContent = '◉ 电脑摄像头 · 未接入视觉分析';
    $('camera-button').textContent = '关闭摄像头，返回模拟场景';
    notify('电脑摄像头已开启。尚无人物检测与自动站稳判断，请自行确认画面后拍摄。');
  } catch { releaseCamera(); notify('摄像头开启失败，请检查权限或设备占用。', true); }
  finally { state.cameraPending = false; $('camera-button').disabled = false; updateAvailability(); }
}

function releaseCamera() {
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  cancelAnimationFrame(state.animation);
  $('camera-video').srcObject = null;
  $('source-label').textContent = '◉ 模拟场景 · 非实时摄像头';
  $('camera-button').textContent = '＋ 使用电脑摄像头';
  drawDemo();
}

// A 成员：页面事件与照片管理；B 成员替换 commands.js 和指导/视觉数据源。
document.querySelectorAll('[data-composition]').forEach(button => button.addEventListener('click', () => compose(button.dataset.composition)));
document.querySelectorAll('[data-framing]').forEach(button => button.addEventListener('click', () => compose(undefined, button.dataset.framing)));
document.querySelectorAll('[data-ratio]').forEach(button => button.addEventListener('click', () => { state.crop.ratio = button.dataset.ratio; changeCrop(); }));
document.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => move(button.dataset.direction)));
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { $('command-input').value = button.dataset.command; runCommand(button.dataset.command); }));
$('zoom').addEventListener('input', event => { state.crop.zoom = Number(event.target.value); changeCrop(); });
$('grid-toggle').addEventListener('change', event => { $('thirds-grid').hidden = !event.target.checked; });
$('frame-toggle').addEventListener('change', event => { $('live-crop').hidden = !event.target.checked; });
$('delay').addEventListener('change', cancelCapture);
$('capture-button').addEventListener('click', capture);
$('stop-button').addEventListener('click', stopAll);
document.querySelectorAll('[data-stop]').forEach(button => button.addEventListener('click', stopAll));
$('home-button').addEventListener('click', home);
$('camera-button').addEventListener('click', toggleCamera);
$('command-form').addEventListener('submit', event => { event.preventDefault(); runCommand($('command-input').value); });
$('guide-done').addEventListener('click', () => {
  state.guidePending = false;
  $('guide-done').hidden = true;
  $('guide-text').textContent = '已确认完成。可以拍摄，或再次请求一条动作建议。';
  $('preview-state').textContent = '等待拍摄';
  updateAvailability();
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('close-photo').addEventListener('click', () => $('photo-dialog').close());
$('save-crop').addEventListener('click', saveCrop);
$('editor-ratio').addEventListener('change', event => { rememberCrop(); state.draft.ratio = event.target.value; syncEditor(); });
$('editor-zoom').addEventListener('pointerdown', rememberCrop);
$('editor-zoom').addEventListener('keydown', rememberCrop);
$('editor-zoom').addEventListener('input', event => { state.draft.zoom = Number(event.target.value); syncEditor(); });
$('editor-crop').addEventListener('pointerdown', rememberCrop);
$('undo-crop').addEventListener('click', () => { if (state.undo.length) { state.draft = state.undo.pop(); syncEditor(); } });
$('download-original').addEventListener('click', () => download(state.selected.original, 'original'));
$('download-crop').addEventListener('click', () => download(renderCrop(state.selected.original, state.draft), 'crop'));
$('retake').addEventListener('click', () => { $('photo-dialog').close(); window.scrollTo({ top: 0, behavior: 'smooth' }); capture(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); $('photo-dialog').close(); $('help-dialog').close(); stopAll(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelCapture(); state.recognition?.abort(); } });
window.addEventListener('pagehide', releaseCamera);
attachDrag($('live-crop'), () => state.crop, () => ({ width: preview.width, height: preview.height }), changeCrop);
attachDrag($('editor-crop'), () => state.draft, () => ({ width: state.selected.original.width, height: state.selected.original.height }), syncEditor);
demoImage.onload = drawDemo;
demoImage.onerror = () => notify('模拟场景加载失败，请检查静态资源。', true);
demoImage.src = '/assets/demo-scene.svg';
syncCrop();
setupVoice();
updateAvailability();
log('欢迎来到灵眸。当前为模拟模式，真实机械臂、视觉模型尚未接入。');
pollStatus();
setInterval(pollStatus, 4000);
