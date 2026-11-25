import { deviceApi } from './api.js';
import { clamp, cropRect, renderCrop, positionFrame, attachDrag } from './crop.js';
import { parseCommand } from './commands.js?v=so101-pitch';

const $ = id => document.getElementById(id);
const preview = $('preview');
const ctx = preview.getContext('2d');
const movementControls = $('movement-controls');
const movementAnchor = movementControls.previousElementSibling;
const armView = $('so101-view');
const armImage = $('so101-arm-image');
const state = {
  device: null, online: false, stopped: false, stopPending: false, busy: false, capturePending: false,
  simulatedImage: null,
  epoch: 0, timer: null, stream: null, cameraPending: false, animation: null,
  composition: 'center', framing: 'half',
  crop: { ratio: '3:4', zoom: 1.15, cx: .5, cy: .48 },
  photos: [], selected: null, draft: null, undo: [],
  guide: -1, guidePending: false, recognition: null, listening: false,
};
let polling = false;
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

function setDepthControls(enabled) {
  const controls = [
    [$('move-top'), enabled ? 'FORWARD' : 'UP', enabled ? '前进' : '↑', enabled ? '相机前进' : '相机向上'],
    [$('move-left'), 'LEFT', enabled ? '左转' : '←', enabled ? '相机左转' : '相机向左'],
    [$('move-right'), 'RIGHT', enabled ? '右转' : '→', enabled ? '相机右转' : '相机向右'],
    [$('move-bottom'), enabled ? 'BACKWARD' : 'DOWN', enabled ? '后退' : '↓', enabled ? '相机后退' : '相机向下'],
  ];
  for (const [button, direction, text, label] of controls) {
    button.dataset.direction = direction;
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  movementControls.toggleAttribute('data-depth', enabled);
  $('camera-adjustments').hidden = !enabled;
  $('movement-hint').textContent = enabled ? '转向和俯仰 1°，平移和升降 5 mm' : '方向按预览画面左右。';
}

function poseLabel({
  cameraYawDegrees: yaw, cameraTravelMillimeters: distance, cameraElevationMillimeters: elevation, cameraPitchDegrees,
}) {
  const turn = yaw ? `${yaw > 0 ? '左转' : '右转'} ${Math.abs(yaw)}°` : '转向 0°';
  const travel = distance ? `${distance > 0 ? '前移' : '后退'} ${Math.abs(distance)} mm` : '前后 0 mm';
  const height = elevation ? `${elevation > 0 ? '上升' : '下降'} ${Math.abs(elevation)} mm` : '高度 0 mm';
  const pitch = Math.round(cameraPitchDegrees);
  const tilt = pitch ? `${pitch > 0 ? '抬头' : '低头'} ${Math.abs(pitch)}°` : '俯仰 0°';
  return `${turn} · ${travel} · ${height} · ${tilt}`;
}

function updateDevice(device) {
  state.device = device;
  state.online = device.connected;
  // 本地停止锁存到明确回初始位，避免较早的轮询结果覆盖停止状态。
  state.stopped = state.stopped || device.state === 'STOPPED';
  const so101 = device.so101;
  const connectedLabel = so101 ? 'SO-101 三维仿真已连接' : '模拟控制服务已连接';
  $('service-status').textContent = state.online ? (state.stopped ? '已停止 · 回初始位恢复' : connectedLabel) : '设备已断开';
  $('service-dot').classList.toggle('offline', !state.online || state.stopped);
  const position = so101 ? poseLabel(so101) : `X ${device.x} · Y ${device.y}`;
  if ($('position-label').textContent !== position) $('position-label').textContent = position;
  if (so101 && armView.hidden) {
    movementControls.parentElement.prepend(movementControls, armView);
    setDepthControls(true);
  } else if (!so101 && !armView.hidden) {
    movementAnchor.after(movementControls, armView);
    setDepthControls(false);
  }
  armView.hidden = !so101;
  if (so101 && armImage.getAttribute('src') !== so101.armView) armImage.src = so101.armView;
  if (state.stopped || !state.online) {
    cancelCapture();
    $('preview-state').textContent = state.stopped ? '已停止' : '连接中断';
  }
  updateAvailability();
  if (!state.stream) drawDemo();
}

async function syncDevice(device, epoch, { resume = false } = {}) {
  if (epoch !== state.epoch) return false;
  if (device.frame.id !== state.device?.frame.id) {
    const image = new Image();
    image.src = device.frame.src;
    const decoding = [image.decode()];
    if (device.so101) {
      const observer = new Image();
      observer.src = device.so101.armView;
      decoding.push(observer.decode());
    }
    await Promise.all(decoding);
    if (epoch !== state.epoch) return false;
    state.simulatedImage = image;
  }
  if (resume) state.stopped = false;
  updateDevice(device);
  return true;
}

function updateAvailability() {
  const moving = state.busy || state.device?.state === 'MOVING';
  const blocked = !state.online || state.stopped || moving || state.capturePending || state.guidePending || state.cameraPending;
  document.querySelectorAll('[data-direction]').forEach(button => { button.disabled = blocked; });
  $('capture-button').disabled = blocked || !(state.stream || state.simulatedImage);
  $('home-button').disabled = !state.online || moving || state.stopPending || state.capturePending || state.guidePending;
}

function markControlUnavailable() {
  state.online = false;
  cancelCapture();
  $('service-status').textContent = '控制服务未连接';
  $('service-dot').classList.add('offline');
  $('preview-state').textContent = '等待控制服务';
  updateAvailability();
}

async function pollStatus() {
  if (polling || state.busy || state.stopPending || state.capturePending) return;
  polling = true;
  const epoch = state.epoch;
  try {
    await syncDevice(await deviceApi.status(), epoch);
  } catch {
    if (epoch !== state.epoch) return;
    const wasOnline = state.online;
    markControlUnavailable();
    if (wasOnline) notify('无法同步设备状态或模拟画面，请检查网页和仿真服务。', true);
  } finally {
    polling = false;
  }
}

function drawDemo() {
  if (state.simulatedImage && !state.stream) {
    $('source-label').textContent = state.device?.so101 ? '◉ SO-101 三维仿真 · 腕部视角' : '◉ 模拟场景 · 非实时摄像头';
    ctx.drawImage(state.simulatedImage, 0, 0, preview.width, preview.height);
  }
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
  if (state.stopPending) return;
  state.stopPending = true;
  state.epoch++;
  cancelCapture();
  const epoch = state.epoch;
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
    if (!await syncDevice(await deviceApi.stop(), epoch)) return;
    notify('已停止：倒计时和人物指导已取消，回初始位后恢复。');
  } catch (error) {
    state.online = false;
    $('service-status').textContent = '停止请求未确认';
    $('service-dot').classList.add('offline');
    notify(`页面操作已取消；控制端停止未确认：${error.message}`, true);
  } finally {
    state.stopPending = false;
    updateAvailability();
  }
}

async function move(direction) {
  if (!state.online || state.stopped || state.busy || state.capturePending || state.guidePending || state.cameraPending) {
    notify('当前不能调整机位，请先完成指导、等待拍摄结束或回初始位。', true);
    return;
  }
  const epoch = ++state.epoch;
  state.busy = true;
  updateAvailability();
  $('preview-state').textContent = '模拟机位调整';
  try {
    const device = await deviceApi.move(direction);
    if (!await syncDevice(device, epoch)) return;
    $('preview-state').textContent = device.so101 ? device.message : '模拟微调完成';
    log(device.message);
  } catch (error) {
    if (epoch === state.epoch) {
      if (!error.status || error.status >= 500) markControlUnavailable();
      $('preview-state').textContent = '调整暂停';
      notify(error.message, true);
    }
  } finally {
    state.busy = false;
    updateAvailability();
  }
}

async function home() {
  if (state.busy || state.stopPending || state.guidePending) return notify('请先完成当前操作或点击停止。');
  cancelCapture();
  const epoch = ++state.epoch;
  state.busy = true;
  updateAvailability();
  try {
    const device = await deviceApi.home();
    if (!await syncDevice(device, epoch, { resume: true })) return;
    $('preview-state').textContent = '等待拍摄';
    notify(device.message);
  } catch (error) {
    if (epoch === state.epoch) {
      if (!error.status || error.status >= 500) markControlUnavailable();
      notify(error.message, true);
    }
  }
  finally { state.busy = false; updateAvailability(); }
}

async function capture() {
  if (!state.online || state.stopped || state.busy || state.capturePending || state.guidePending || state.cameraPending || !(state.stream || state.simulatedImage)) {
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
        if (current.frame.id !== device.frame.id) throw new Error('倒计时期间机位已变化，已取消拍摄');
        if (!await syncDevice(current, epoch)) return;
        const original = document.createElement('canvas');
        original.width = preview.width;
        original.height = preview.height;
        original.getContext('2d').drawImage(preview, 0, 0);
        const photo = { id: Date.now(), original, crop: { ...state.crop }, time: new Date() };
        state.photos.unshift(photo);
        renderGallery();
        $('preview-state').textContent = '已拍摄';
        notify('已保存原片与裁剪结果，点击下方照片可编辑和下载。');
      } catch (error) {
        if (epoch === state.epoch) { $('preview-state').textContent = '拍摄暂停'; notify(error.message, true); }
      }
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
  const command = parseCommand(text, { depthMovement: Boolean(state.device?.so101) });
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
syncCrop();
setupVoice();
updateAvailability();
log('欢迎来到灵眸。当前为模拟模式，真实机械臂、视觉模型尚未接入。');
pollStatus();
setInterval(pollStatus, 4000);
