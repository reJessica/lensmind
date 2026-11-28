import { deviceApi } from './api.js';
import { attachDrag, clamp, CROP_RATIOS, cropRatioLabel, cropRegion, MAX_ZOOM, MIN_ZOOM, positionRegion, renderCrop } from './crop.js';
import { isSpokenShutter, parseCommand } from './commands.js';
import { capturePositionHint, COMPOSITION_X, composeAdvice, compositionRegions, cropVisionFrame, fitFrame, liveCompositionCue, pendingPersonTarget, startVision } from './vision.js';
import { gridLabel } from './grid.js';
import { isAiCommand, setupAi } from './ai.js';
import { createSpeechInput, createVoiceGuide } from './voice.js';
import { setupSettings } from './settings.js';
import { setupCloudSpeech, createCloudSpeechInput, routeSpeechInput } from './cloud-speech.js';
import { isCloudTts } from './model-presets.js';

const $ = id => document.getElementById(id);
const preview = $('preview');
const ctx = preview.getContext('2d');
const video = $('camera-video');
const stopButtons = document.querySelectorAll('[data-stop]');
const state = {
  device: null, online: false, stopped: false, stopPhase: null, stopIssue: '', stopResetConfirmed: false,
  deviceAction: null, capturePending: false, simulatedImage: null,
  epoch: 0, timer: null, stream: null, cameraPending: false, cameraRequest: 0, animation: null,
  page: null, captureMode: 'assisted',
  composition: 'center', framing: 'any', sceneTarget: null,
  crop: { ratio: '3:4', zoom: 1.15, cx: .5, cy: .48 },
  photos: [], selected: null, draft: null, undo: [],
  guide: -1, guidePending: false, guidanceRequested: false, vision: null, stopVision: null,
  selectedPerson: null, peopleTargets: new Map(),
};
const positionLabels = { center: '居中', left: '左三分', right: '右三分' };
const framingLabels = { any: '不限景别', half: '半身', full: '全身' };
const demoImage = new Image();
function cameraCropSource() {
  if (!state.stream || video.readyState < 2 || !video.videoWidth) return null;
  const crop = liveCropRegion();
  return { source: video, x: crop.x * video.videoWidth, y: crop.y * video.videoHeight,
    width: crop.width * video.videoWidth, height: crop.height * video.videoHeight };
}
const ai = setupAi(cameraCropSource, receiveAdvice);
const cloud = setupCloudSpeech();
const speechHandlers = {
  onState: showMicrophoneStatus,
  onText: text => { $('command-input').value = text; },
  onCommand: runCommand,
};
const browserSpeech = createSpeechInput({
  Recognition: window.SpeechRecognition || window.webkitSpeechRecognition,
  ...speechHandlers,
});
const cloudSpeech = createCloudSpeechInput({ cloud, ...speechHandlers });
const speech = routeSpeechInput(browserSpeech, cloudSpeech);
const voice = createVoiceGuide({
  synthesis: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance,
  useCloud: () => isCloudTts($('settings-tts-model').value),
  synthesize: cloud.synthesize,
  onError: error => setVoiceEnabled(false, error?.message || '语音播报不可用，可以查看文字提示或稍后重试。'),
  onPlayback: speech.playback,
  onStatus: (phase, message) => {
    const busy = phase === 'loading' || phase === 'playing';
    $('settings-voice-preview').textContent = busy ? '取消试听' : '试听播报';
    $('settings-voice-preview').setAttribute('aria-busy', String(busy));
    const cloudTts = isCloudTts($('settings-tts-model').value);
    const messages = {
      loading: cloudTts ? '正在请求云端合成，可能需要等待约 60 秒；可点击取消，请勿重复提交。' : '正在启动浏览器播报…',
      playing: '正在播放；如听不到声音，请检查系统音量、标签页静音和音频输出设备。',
      ended: '播报已结束。', cancelled: '已取消等待或播放；已发送的云端请求仍可能计费。',
    };
    $('settings-voice-preview-status').textContent = phase === 'error' ? `试听失败：${message}` : messages[phase] || '';
  },
});
const settings = setupSettings({
  onChange: applyPreferences,
  onPreviewVoice: () => {
    if (voice.busy) { voice.cancel(); return; }
    setVoiceEnabled(true);
    voice.speak('你好，我是灵眸。请看向镜头，放松肩膀。');
  },
  voiceAvailable: () => voice.available, speechAvailable: () => speech.available,
  onSpeechChange: () => { speech.stop(); setVoiceEnabled(false); },
});
let toastTimer;
let polling = false;
const stopLabels = {
  ready: '停止', stopping: '正在停止', resetting: '已停止，复位中', stopped: '已停止', restored: '已停止，已复位',
};

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

function showPage(focus = true) {
  const requested = location.hash.slice(1);
  const page = ['studio', 'gallery', 'settings'].includes(requested) ? requested : 'home';
  if (page === state.page) return;
  const leavingStudio = state.page === 'studio';
  if (state.page === 'settings') { ai.clearKey(); cloud.clearKey(); setVoiceEnabled(false); }
  state.page = page;
  if (page !== 'gallery') $('photo-dialog').close();
  if (leavingStudio) {
    cancelCapture();
    speech.stop();
    setVoiceEnabled(false);
    ai.cancel('已离开拍摄页，停止等待模型回复。');
    clearGuide();
    if (state.stream || state.cameraPending) releaseCamera();
  }
  for (const section of document.querySelectorAll('[data-page]')) section.hidden = section.id !== page;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('stop-button').hidden = $('help-stop').hidden = page !== 'studio' && page !== 'settings';
  document.title = `${$(`${page}-title`).textContent} · 灵眸 LensMind`;
  if (page === 'gallery') {
    setText($('review-copy'), leavingStudio ? '拍摄已结束。点成片查看、调整裁剪或下载。' : '点成片可以查看大图、调整裁剪或下载。');
  }
  if (page === 'settings') { settings.refresh(); ai.refreshConnection(); cloud.refresh(); }
  updateAvailability();
  if (focus) {
    $(`${page}-title`).focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

function setCaptureMode(mode) {
  if (mode === state.captureMode || state.capturePending) return;
  state.captureMode = mode;
  $('studio').dataset.captureMode = mode;
  for (const button of document.querySelectorAll('button[data-capture-mode]')) {
    button.setAttribute('aria-pressed', button.dataset.captureMode === mode);
  }
  const manual = mode === 'manual';
  if (manual) clearGuide();
  voice.reset();
  setText($('shoot-mode-copy'), manual ? '自行调整画幅和裁剪框。选择半身或全身时仍会检查景别。' : '摄像头取景时，人物位置和所选景别都达标后可以拍摄。');
  updateAvailability();
}

async function loadDeviceImage(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

async function syncDevice(device, epoch) {
  if (epoch !== state.epoch) return false;
  const changedFrame = device.frame?.id !== state.device?.frame?.id;
  const armSource = device.so101?.armView;
  const armImage = $('so101-arm-image');
  const [image, observer] = await Promise.all([
    changedFrame && device.frame ? loadDeviceImage(device.frame.src) : null,
    armSource && armSource !== armImage.getAttribute('src') ? loadDeviceImage(armSource) : null,
  ]);
  if (epoch !== state.epoch) return false;
  if (changedFrame) state.simulatedImage = image;
  if (observer) armImage.src = observer.src;
  if (!armSource) armImage.removeAttribute('src');
  updateDevice(device);
  return true;
}

function updateDevice(device) {
  state.device = device;
  state.online = device.connected;
  if (!state.online) state.stopResetConfirmed = false;
  // 停止保持锁定，直到收到复位确认。
  state.stopped = state.stopped || device.state === 'STOPPED';
  $('service-status').textContent = state.stopIssue || (state.online ? (state.stopped ? '已停止' : '模拟控制服务已连接') : '设备已断开');
  $('service-dot').classList.toggle('offline', !state.online || state.stopped);
  const so101 = device.so101;
  const deviceTools = $('device-tools');
  if (so101 && !deviceTools.hasAttribute('data-so101')) deviceTools.open = true;
  deviceTools.toggleAttribute('data-so101', Boolean(so101));
  $('so101-view').hidden = !so101;
  $('camera-adjustments').hidden = !so101;
  for (const [id, normal, simulation, label] of [
    ['move-top', 'UP', 'FORWARD', '镜头前进'], ['move-bottom', 'DOWN', 'BACKWARD', '镜头后退'],
  ]) {
    const button = $(id);
    button.dataset.direction = so101 ? simulation : normal;
    button.setAttribute('aria-label', so101 ? label : normal === 'UP' ? '相机向上' : '相机向下');
  }
  $('position-label').textContent = so101
    ? `转向 ${Math.round(so101.cameraYawDegrees)}° · 前后 ${so101.cameraTravelMillimeters} mm · 高度 ${so101.cameraElevationMillimeters} mm · 俯仰 ${Math.round(so101.cameraPitchDegrees)}°`
    : `X ${device.x} · Y ${device.y}`;
  if (state.stopped || !state.online) {
    cancelCapture();
    $('preview-state').textContent = state.stopped ? '已停止' : '连接中断';
  }
  updateAvailability();
  if (!state.stream) drawDemo();
}

function updateAvailability() {
  renderStopButtons();
  settings.updateDevice(state.device, state.online);
  const blocked = state.page !== 'studio' || !state.online || Boolean(state.stopped || state.stopPhase || state.deviceAction || state.capturePending || state.guidePending || state.cameraPending);
  const positionHint = state.capturePending ? '' : currentPositionHint();
  document.querySelectorAll('[data-direction]').forEach(button => { button.disabled = blocked; });
  document.querySelectorAll('button[data-capture-mode]').forEach(button => { button.disabled = state.capturePending; });
  $('capture-button').disabled = blocked || Boolean(positionHint);
  $('home-button').disabled = !state.online || Boolean(state.stopPhase || state.deviceAction || state.capturePending || state.guidePending);
  const hint = state.stopPhase === 'stopping' ? '正在停止并取消本次拍摄。'
    : state.stopPhase === 'resetting' ? '模拟机位正在复位，完成后可以继续拍。'
    : state.stopIssue ? `${state.stopIssue}。请检查控制服务，再点右上角的按钮重试。`
    : state.stopped ? (state.device?.mode === 'MOCK' ? '模拟机位已停止。点击「停止」可重新复位。' : '控制端已停止，请确认设备状态。')
    : !state.online ? '等控制服务连接后可拍摄。'
    : state.guidePending ? '请先点击「已完成，继续」。' : positionHint;
  setText($('capture-hint'), hint);
  $('capture-hint').classList.toggle('stop-hint', state.stopped || Boolean(state.stopPhase));
  $('capture-hint').hidden = !hint;
}

function renderStopButtons() {
  const status = state.stopPhase || (state.stopIssue ? 'failed'
    : state.online && state.stopped ? 'stopped' : state.online && state.stopResetConfirmed ? 'restored' : 'ready');
  const label = state.stopIssue || stopLabels[status];
  for (const button of stopButtons) {
    const text = button.querySelector('[data-stop-label]');
    if (button.dataset.stop === status && text.textContent === label) continue;
    button.dataset.stop = status;
    setText(text, label);
    setText(button.querySelector('[data-stop-icon]'), status === 'restored' || status === 'stopped' ? '✓' : status === 'failed' ? '!' : '■');
    if (state.stopPhase) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    const action = status === 'failed' ? '点击重试' : '停止当前操作';
    button.title = state.stopPhase ? label : action;
    button.setAttribute('aria-label', status === 'ready' || state.stopPhase ? label : `${label}。${action}`);
  }
}

function liveCropRegion() {
  return cropRegion(preview.width, preview.height, state.crop);
}

function positionOptions() {
  const target = state.sceneTarget;
  return { headTarget: target?.part === 'head' ? target : null, bodyTarget: target?.part !== 'head' ? target : null,
    framing: state.framing, skipPosition: state.captureMode === 'manual' };
}

function currentPositionHint(analysis = cropVisionFrame(state.vision, liveCropRegion())) {
  return state.stream ? capturePositionHint(analysis, state.composition, state.peopleTargets, positionOptions()) : '';
}

const visiblePeople = () => state.vision?.people ?? [];
const personName = id => `人物 ${id}`;
const percent = n => `${Math.round(n * 100)}%`;
const targetName = target => target?.cells?.length ? gridLabel(target.cells) : positionLabels[target?.composition];
const targetLabel = target => target?.part === 'head' ? `头部 · ${targetName(target)}` : targetName(target);

function missingTargets() {
  return [...state.peopleTargets.keys()].filter(id => !visiblePeople().some(person => person.id === id));
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function updatePeopleList(container, ids, create, update) {
  const existing = new Map([...container.children].map(node => [Number(node.dataset.personId), node]));
  for (const [index, id] of ids.entries()) {
    const node = existing.get(id) ?? create(id);
    node.dataset.personId = id;
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null);
    update(node, id);
    existing.delete(id);
  }
  existing.forEach(node => node.remove());
}

function personButton(id, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.addEventListener('click', () => selectPerson(id));
  return button;
}

function selectPerson(id) {
  state.selectedPerson = id;
  renderPeople();
}

function setPersonPositions(targets, framing) {
  if (!state.stream) { notify('请先打开电脑摄像头，再选择画面中的人物。'); return false; }
  if (targets.some(target => targetName(target) && !visiblePeople().some(person => person.id === target.id))) {
    notify('请使用画面上当前可见的人物编号。');
    return false;
  }
  state.sceneTarget = null;
  for (const { id, ...target } of targets) {
    if (targetName(target)) state.peopleTargets.set(id, target);
    else state.peopleTargets.delete(id);
  }
  state.selectedPerson = targets[0].id;
  updateGoal(framing);
  notify([targets.map(target => `${personName(target.id)} ${targetLabel(target) ?? '已清除目标'}`).join('、'), framingLabels[framing]].filter(Boolean).join(' · '));
  return true;
}

function setSceneTarget(target, framing) {
  const inCrop = cropVisionFrame(state.vision, liveCropRegion())?.people?.filter(person => person.person) ?? [];
  if (target && inCrop.length > 1) {
    if (!inCrop.some(person => person.id === state.selectedPerson)) {
      notify('请先选择裁剪框内的人物，或在指令中说出人物编号。');
      return false;
    }
    return setPersonPositions([{ id: state.selectedPerson, ...target }], framing);
  }
  if (target) state.peopleTargets.clear();
  state.sceneTarget = target;
  updateGoal(framing);
  notify(target ? `已设置${[targetLabel(target), framingLabels[framing]].filter(Boolean).join(' · ')}` : '已清除画面目标。');
  return true;
}

function togglePersonCell(cell) {
  const id = state.selectedPerson;
  const target = state.peopleTargets.get(id) ?? state.sceneTarget;
  const cells = new Set(target?.cells);
  if (!cells.delete(cell)) cells.add(cell);
  setPersonPositions([{ id, part: target?.part, cells: [...cells].sort((a, b) => a - b) }]);
}

function renderTarget(frame, target, personId) {
  const line = $('person-target-line');
  line.hidden = !target?.composition;
  if (!line.hidden) {
    line.style.left = `${(frame.x + COMPOSITION_X[target.composition] * frame.width) * 100}%`;
    line.style.top = `${frame.y * 100}%`;
    line.style.height = `${frame.height * 100}%`;
  }
  const area = $('person-target-area');
  const regions = target ? compositionRegions(target) : [];
  area.hidden = regions.length === 0;
  updatePeopleList(area, target?.cells ?? regions.map(() => -1), () => document.createElement('div'), (node, cell) => {
    const bounds = regions[target?.cells?.indexOf(cell) ?? 0];
    positionRegion(node, { x: frame.x + bounds.x * frame.width, y: frame.y + bounds.y * frame.height,
      width: bounds.width * frame.width, height: bounds.height * frame.height });
    const cells = target.cells ?? [];
    node.style.setProperty('--top', cells.includes(cell - 3) ? '0' : '2px');
    node.style.setProperty('--right', cell % 3 < 2 && cells.includes(cell + 1) ? '0' : '2px');
    node.style.setProperty('--bottom', cells.includes(cell + 3) ? '0' : '2px');
    node.style.setProperty('--left', cell % 3 > 0 && cells.includes(cell - 1) ? '0' : '2px');
  });
  const goal = $('composition-goal');
  const label = [personId && personName(personId), targetLabel(target), state.framing !== 'any' && framingLabels[state.framing]].filter(Boolean).join(' · ');
  goal.hidden = !label;
  if (label) {
    positionRegion(goal, frame);
    setText(goal.firstElementChild, `目标 · ${label}`);
  }
}

function renderPeople() {
  const analysis = state.vision;
  const region = liveCropRegion();
  const cropped = cropVisionFrame(analysis, region);
  const people = visiblePeople();
  const visible = new Map(people.map(person => [person.id, person]));
  const occluded = new Set(analysis?.occluded);
  const ids = [...new Set([...visible.keys(), ...occluded, ...state.peopleTargets.keys()])].sort((a, b) => a - b);
  if (!ids.includes(state.selectedPerson)) state.selectedPerson = people[0]?.id ?? ids[0] ?? null;
  const selected = visible.get(state.selectedPerson);
  const inCrop = new Map(cropped?.people?.filter(person => person.person).map(person => [person.id, person]));
  const selectedInCrop = inCrop.get(state.selectedPerson);
  const target = state.peopleTargets.get(state.selectedPerson);
  const { headTarget } = positionOptions();
  const faces = analysis?.faces ?? [];
  const peopleList = $('vision-people');
  peopleList.hidden = ids.length === 0;
  updatePeopleList(peopleList, ids, id => personButton(id, 'vision-person'), (node, id) => {
    const position = targetLabel(state.peopleTargets.get(id));
    const presence = visible.has(id) ? (inCrop.has(id) ? null : '画幅外') : occluded.has(id) ? '暂未看清' : '已离开';
    setText(node, [personName(id), position, presence].filter(Boolean).join(' · '));
    node.setAttribute('aria-pressed', id === state.selectedPerson);
  });

  updatePeopleList($('person-overlays'), people.map(person => person.id), id => {
    const box = document.createElement('div');
    box.className = 'person-box';
    const button = personButton(id, 'person-box-label');
    button.textContent = personName(id);
    box.append(button);
    return box;
  }, (box, id) => {
    const { person } = visible.get(id);
    box.classList.toggle('is-selected', id === state.selectedPerson);
    box.firstElementChild.setAttribute('aria-pressed', id === state.selectedPerson);
    positionRegion(box, person);
  });

  const showFaces = headTarget || [...state.peopleTargets.values()].some(goal => goal.part === 'head');
  updatePeopleList($('head-overlays'), showFaces ? faces.map((_, index) => index) : [], () => {
    const marker = document.createElement('div');
    marker.className = 'head-box';
    return marker;
  }, (node, index) => positionRegion(node, faces[index]));
  const speakingTarget = state.guidanceRequested && state.captureMode === 'assisted' && cropped
    ? pendingPersonTarget(cropped, state.peopleTargets) : null;
  const paintedTarget = state.sceneTarget ?? speakingTarget?.target ?? target
    ?? (state.captureMode === 'assisted' && state.stream && !state.peopleTargets.size ? { composition: state.composition } : null);
  renderTarget(region, paintedTarget, speakingTarget?.id ?? (target ? state.selectedPerson : null));

  $('vision-head-target').hidden = !state.sceneTarget;
  setText($('vision-head-label'), state.sceneTarget ? `目标 · ${targetLabel(state.sceneTarget)}` : '');
  $('vision-positions').hidden = state.selectedPerson === null;
  const editorTarget = target ?? state.sceneTarget;
  setText($('vision-selected'), state.sceneTarget ? '画面构图位置' : state.selectedPerson === null ? ''
    : `${personName(state.selectedPerson)}的${target?.part === 'head' ? '头部' : '构图'}位置`);
  for (const button of $('vision-positions').querySelectorAll('[data-person-position]')) {
    const position = button.dataset.personPosition;
    button.disabled = position ? !selected : !target;
    if (position) button.setAttribute('aria-pressed', position === editorTarget?.composition);
  }
  for (const button of $('vision-positions').querySelectorAll('[data-person-cell]')) {
    button.disabled = !selected;
    button.setAttribute('aria-pressed', Boolean(editorTarget?.cells?.includes(Number(button.dataset.personCell))));
  }
  const metrics = selectedInCrop ? `画幅内中心 ${percent(selectedInCrop.position.x)} / ${percent(selectedInCrop.position.y)} · 面积占比 ${percent(selectedInCrop.occupancy)}` : '';
  setText($('vision-metrics'), metrics);
  let advice = analysis?.message || '';
  if (headTarget || target?.part === 'head') {
    advice = advice || (currentPositionHint(cropped) ? '头部位置按裁剪框内的脸部中心判断。' : '头部目标已达成，可以开始拍摄。');
  } else if (selectedInCrop && (target || inCrop.size === 1)) {
    const description = composeAdvice({ ...cropped, person: selectedInCrop.person }, {
      composition: state.composition, framing: state.framing, ...state.sceneTarget, ...target,
    });
    advice = [description.horizontal, description.framing, description.adjustment?.text].filter(Boolean).join(' · ');
  } else if (selected && !selectedInCrop) {
    advice = `${personName(selected.id)}在裁剪框外，可以移动裁剪框或调整取景。`;
  } else if (selected) {
    advice = `为${personName(selected.id)}选一个位置或多选九宫格，也可以说「人物${selected.id}左下四格」。`;
  } else if (target && analysis?.status !== 'error') {
    advice = `${personName(state.selectedPerson)}暂时不在画面里。可以等人物回来，或清除目标。`;
  }
  setText($('vision-advice'), advice);
}

function showVisionReading(analysis) {
  const previousStatus = state.vision?.status;
  state.vision = analysis;
  const labels = {
    loading: '正在加载人物检测', waiting: '等待新画面', empty: '未检测到人物',
    acquiring: '正在确认人物', reacquiring: '正在重新确认人物',
    lost: '目标丢失', moving: '位置实时更新', stable: '已站稳', error: '人物检测暂不可用',
  };
  const missing = missingTargets();
  const count = visiblePeople().length;
  $('vision-summary').hidden = !analysis;
  const missingLabel = missing.length && missing.every(id => analysis?.occluded?.includes(id)) ? '暂未看清' : '不在画面中';
  const label = !analysis ? '' : count
    ? `已检测到 ${count} 人 · ${missing.length ? missing.map(personName).join('、') + missingLabel : labels[analysis.status]}`
    : positionOptions().headTarget && analysis.faces?.length ? `检测到 ${analysis.faces.length} 个头部位置` : labels[analysis.status];
  setText($('vision-status'), label);
  renderPeople();
  if (voice.enabled && state.guidanceRequested && state.page === 'studio' && state.stream && state.online
      && !state.stopped && !state.capturePending && !state.guidePending && !state.deviceAction && !ai.pending) {
    const cropped = cropVisionFrame(analysis, liveCropRegion());
    voice.observe(liveCompositionCue(cropped, state.composition, state.peopleTargets, positionOptions()));
  } else voice.observe('');
  if (analysis?.status === 'lost' && previousStatus !== 'lost') log('目标丢失，等待人物回到画面。');
  updateAvailability();
}

async function pollStatus() {
  if (polling || state.stopPhase || state.deviceAction || state.capturePending) return;
  polling = true;
  const epoch = state.epoch;
  try {
    await syncDevice(await deviceApi.status(), epoch);
  } catch {
    if (epoch !== state.epoch) return;
    const wasOnline = state.online;
    state.online = false;
    state.stopResetConfirmed = false;
    voice.reset();
    cancelCapture();
    $('service-status').textContent = '控制服务未连接';
    $('service-dot').classList.add('offline');
    $('preview-state').textContent = '等待控制服务';
    updateAvailability();
    if (wasOnline) notify('控制服务断开，拍摄已取消。请检查 Spring Boot 服务。', true);
  } finally {
    polling = false;
  }
}

function drawDemo() {
  if (state.stream) return;
  if (state.simulatedImage) {
    const frame = state.device.frame;
    setPreviewSize(frame.width, frame.height);
    ctx.drawImage(state.simulatedImage, 0, 0);
    return;
  }
  if (!demoImage.complete || !demoImage.naturalWidth) return;
  ctx.fillStyle = '#c8c9b9';
  ctx.fillRect(0, 0, preview.width, preview.height);
  const x = -(state.device?.x || 0) * 3;
  const y = (state.device?.y || 0) * 3;
  // 留出边缘余量，仅表现模拟机位变化，不执行真实坐标转换。
  ctx.drawImage(demoImage, -60 + x, -40 + y, 1320, 880);
}

function syncCrop() {
  const region = liveCropRegion();
  positionRegion($('live-crop'), region);
  positionRegion($('thirds-grid'), region);
  setText($('crop-zoom'), `${state.crop.zoom.toFixed(2)}×`);
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
  renderPeople();
  updateAvailability();
}

function changeCrop() {
  cancelCapture();
  voice.observe('');
  ai.invalidateScene();
  syncCrop();
}

function updateGoal(framing, positionRequested = false) {
  if (framing) state.framing = framing;
  state.guidanceRequested = voice.enabled && (positionRequested || Boolean(state.sceneTarget)
    || state.peopleTargets.size > 0 || state.framing !== 'any');
  cancelCapture();
  voice.reset();
  syncCrop();
}

function compose(composition, framing) {
  if (composition) {
    state.composition = composition;
    state.sceneTarget = null;
    state.peopleTargets.clear();
  }
  updateGoal(framing, Boolean(composition));
  notify(`已设置${[positionLabels[composition], framingLabels[framing]].filter(Boolean).join(' · ')}。`);
}

function setRatio(ratio) {
  if (state.crop.ratio === ratio) return;
  state.crop.ratio = ratio;
  changeCrop();
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
  if (state.stopPhase) return;
  const pendingAction = state.deviceAction;
  state.epoch++;
  state.stopPhase = 'stopping';
  state.stopIssue = '';
  state.stopResetConfirmed = false;
  state.stopped = true;
  cancelCapture();
  const epoch = state.epoch;
  ai.cancel('已停止等待 AI 分析，可在准备好后再次请求。');
  clearGuide();
  speech.stop();
  if (voice.enabled) setVoiceEnabled(false, '语音指导已停止，可再次开启。');
  $('countdown-overlay').hidden = true;
  setText($('preview-state'), '正在停止');
  updateAvailability();
  // 停止请求独立直达控制端，不经过语音或构图逻辑。
  try {
    const stopped = await deviceApi.stop();
    if (!stopped.connected || stopped.state !== 'STOPPED') throw new Error('控制端未返回已停止状态');
    if (!await syncDevice(stopped, epoch)) return;
    if (stopped.mode !== 'MOCK' || stopped.so101) {
      notify('已停止，倒计时和人物指导已取消。');
      return;
    }
    state.stopPhase = 'resetting';
    setText($('preview-state'), '模拟机位复位中');
    updateAvailability();
    // 等先前已发出的操作收尾，避免较晚执行的模拟微调覆盖复位。
    if (pendingAction) await pendingAction.catch(() => {});
    const restored = await deviceApi.home();
    if (restored.mode !== 'MOCK' || !restored.connected || restored.state !== 'IDLE' || restored.x !== 0 || restored.y !== 0) {
      throw new Error('控制端未确认模拟机位已回到初始位置');
    }
    state.stopped = false;
    state.stopResetConfirmed = true;
    if (!await syncDevice(restored, epoch)) return;
    setText($('preview-state'), '等待拍摄');
    notify('已取消当前操作，模拟机位已复位。可以继续拍摄。');
  } catch (error) {
    const failure = state.stopPhase === 'resetting' ? '模拟机位复位未确认' : '控制端停止未确认';
    state.stopIssue = failure;
    setText($('service-status'), failure);
    $('service-dot').classList.add('offline');
    setText($('preview-state'), failure);
    notify(`${failure}：${error.message}`, true);
  } finally {
    state.stopPhase = null;
    updateAvailability();
  }
}

async function move(direction) {
  if (!state.online || state.stopped || state.deviceAction || state.capturePending || state.guidePending) {
    notify('当前不能调整机位，请等待拍摄、指导或复位完成。', true);
    return;
  }
  const epoch = ++state.epoch;
  voice.cancel();
  state.stopResetConfirmed = false;
  const action = state.deviceAction = deviceApi.move(direction);
  updateAvailability();
  $('preview-state').textContent = '模拟机位调整';
  try {
    const device = await action;
    if (epoch !== state.epoch) return;
    if (!await syncDevice(device, epoch)) return;
    $('preview-state').textContent = device.so101 ? device.message : '模拟微调完成';
    log(device.message);
  } catch (error) {
    if (epoch === state.epoch) { $('preview-state').textContent = '调整暂停'; notify(error.message, true); }
  } finally {
    state.deviceAction = null;
    updateAvailability();
  }
}

async function home() {
  if (state.stopPhase || state.deviceAction || state.guidePending) return notify('请等待当前操作完成。');
  cancelCapture();
  const epoch = ++state.epoch;
  state.stopResetConfirmed = false;
  const action = state.deviceAction = deviceApi.home();
  updateAvailability();
  try {
    const device = await action;
    if (epoch !== state.epoch) return;
    state.stopped = false;
    state.stopIssue = '';
    if (!await syncDevice(device, epoch)) return;
    $('preview-state').textContent = '等待拍摄';
    notify(device.message);
  } catch (error) { if (epoch === state.epoch) notify(error.message, true); }
  finally { state.deviceAction = null; updateAvailability(); }
}

async function capture() {
  if (state.page !== 'studio') return;
  if (!state.online || state.stopped || state.deviceAction || state.capturePending || state.guidePending || state.cameraPending || (!state.stream && !state.simulatedImage && !demoImage.naturalWidth)) {
    notify('暂时无法拍摄，请检查控制服务或等待当前操作完成。', true);
    return;
  }
  const positionHint = currentPositionHint();
  if (positionHint) return notify(positionHint, true);
  if (state.photos.length >= 12) return notify('本次最多保留 12 张。请先下载，刷新页面后开启新一轮拍摄。');
  voice.cancel();
  ai.cancel('已开始拍摄，可在下一次取景时重新分析。');
  state.stopResetConfirmed = false;
  state.capturePending = true;
  const epoch = ++state.epoch;
  updateAvailability();
  try {
    const device = await deviceApi.status();
    if (epoch !== state.epoch) return;
    if (!device.connected || device.state !== 'IDLE') throw new Error('控制端尚未就绪，拍摄已取消');
    if (!await syncDevice(device, epoch)) return;
    const deadline = performance.now() + Number($('delay').value) * 1000;
    const tick = async () => {
      if (epoch !== state.epoch) return;
      const timeLeft = deadline - performance.now();
      if (timeLeft > 0) {
        const remaining = Math.ceil(timeLeft / 1000);
        $('countdown-overlay').textContent = remaining;
        $('countdown-overlay').hidden = false;
        $('preview-state').textContent = '拍摄倒计时';
        state.timer = setTimeout(tick, timeLeft - (remaining - 1) * 1000);
        return;
      }
      try {
        const current = await deviceApi.status();
        if (epoch !== state.epoch) return;
        if (!current.connected || current.state !== 'IDLE') throw new Error('控制端状态变化，已取消拍摄');
        if (!state.stream && current.frame?.id !== device.frame?.id) throw new Error('倒计时期间机位已变化，已取消拍摄');
        if (state.stream && video.readyState < 2) throw new Error('摄像头画面不可用，已取消拍摄');
        $('countdown-overlay').hidden = true;
        const original = document.createElement('canvas');
        original.width = preview.width;
        original.height = preview.height;
        const context = original.getContext('2d');
        if (state.stream) drawCameraFrame(context);
        else context.drawImage(preview, 0, 0);
        const photo = { id: Date.now(), original, crop: { ...state.crop } };
        state.photos.unshift(photo);
        renderGallery();
        $('preview-state').textContent = '已拍摄';
        notify('已拍摄。可以继续拍，或点「完成拍摄」去选片。');
      } catch (error) {
        if (epoch === state.epoch) { $('preview-state').textContent = '拍摄暂停'; notify(error.message, true); }
      }
      finally {
        if (epoch === state.epoch) {
          state.capturePending = false;
          state.timer = null;
          $('countdown-overlay').hidden = true;
          updateAvailability();
        }
      }
    };
    tick();
  } catch (error) { if (epoch === state.epoch) { cancelCapture(); notify(error.message, true); } }
}

function retake() {
  $('photo-dialog').close();
  capture();
}

function renderGallery() {
  $('gallery-empty').hidden = state.photos.length > 0;
  $('photo-count').textContent = state.photos.length;
  $('gallery-count').textContent = String(state.photos.length).padStart(2, '0');
  setText($('shot-count'), `本次已拍 ${state.photos.length} 张`);
  $('photo-list').replaceChildren();
  state.photos.forEach((photo, index) => {
    const number = state.photos.length - index;
    const card = document.createElement('article');
    card.className = 'photo-card';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'photo-card-preview';
    button.setAttribute('aria-label', `查看第 ${number} 张成片`);
    const img = document.createElement('img');
    img.id = `photo-thumbnail-${photo.id}`;
    img.src = renderCrop(photo.original, photo.crop).toDataURL('image/jpeg', .85);
    img.alt = `第 ${number} 张裁剪成片`;
    button.append(img);
    button.addEventListener('click', () => openPhoto(photo));
    const label = document.createElement('div');
    label.className = 'photo-card-info';
    const name = document.createElement('span');
    name.textContent = `作品 ${String(number).padStart(2, '0')}`;
    const viewOriginal = document.createElement('button');
    viewOriginal.type = 'button';
    viewOriginal.setAttribute('aria-label', `查看原片，作品 ${number}`);
    viewOriginal.textContent = '查看原片';
    viewOriginal.addEventListener('click', () => openPhoto(photo, 'original'));
    label.append(name, viewOriginal);
    card.append(button, label);
    $('photo-list').append(card);
  });
}

function openPhoto(photo, view = 'crop') {
  state.selected = photo;
  state.draft = { ...photo.crop };
  state.undo = [];
  const canvas = $('editor-canvas');
  canvas.width = photo.original.width;
  canvas.height = photo.original.height;
  $('editor-stage').style.setProperty('--photo-ratio', canvas.width / canvas.height);
  canvas.getContext('2d').drawImage(photo.original, 0, 0);
  showPhotoView(view);
  $('photo-dialog').showModal();
  document.querySelector(`[data-photo-view="${view}"]`).focus();
}

function photoCrop() {
  return $('photo-dialog').dataset.view === 'edit' ? state.draft : state.selected.crop;
}

function showPhotoView(view) {
  $('photo-dialog').dataset.view = view;
  for (const button of document.querySelectorAll('[data-photo-view]')) {
    button.setAttribute('aria-pressed', button.dataset.photoView === view);
  }
  const editing = view === 'edit';
  $('photo-source').hidden = view === 'crop';
  $('photo-crop-preview').hidden = view === 'original';
  $('editor-crop').hidden = !editing;
  $('editor-grid').hidden = !editing || !$('grid-toggle').checked;
  $('editor-controls').hidden = !editing;
  $('download-original').hidden = view !== 'original';
  $('download-crop').hidden = view === 'original';
  setText($('photo-status'), '');
  syncEditor();
}

function syncEditor() {
  if (!state.selected) return;
  const { original } = state.selected;
  const view = $('photo-dialog').dataset.view;
  if (view === 'edit') {
    const region = cropRegion(original.width, original.height, state.draft);
    positionRegion($('editor-crop'), region);
    positionRegion($('editor-grid'), region);
    $('editor-ratio').value = state.draft.ratio;
    $('editor-zoom').value = state.draft.zoom;
    $('undo-crop').disabled = state.undo.length === 0;
  }
  const displayed = view === 'original' ? original : renderCrop(original, photoCrop(), $('cropped-canvas'));
  if (view !== 'original') displayed.style.setProperty('--crop-ratio', displayed.width / displayed.height);
  const title = { crop: '裁剪成片', edit: '调整裁剪', original: '原片' }[view];
  setText($('photo-title'), `${title} · ${displayed.width} × ${displayed.height}`);
}

function rememberCrop() { state.undo.push({ ...state.draft }); if (state.undo.length > 30) state.undo.shift(); }

function saveCrop() {
  const { id } = state.selected;
  state.selected.crop = { ...state.draft };
  state.undo = [];
  showPhotoView('crop');
  $(`photo-thumbnail-${id}`).src = $('cropped-canvas').toDataURL('image/jpeg', .85);
  setText($('photo-status'), '已更新「本次拍摄」里的成片。请点「下载成片」保存到本机。');
  document.querySelector('[data-photo-view="crop"]').focus();
}

function download(canvas, kind) {
  const photoId = state.selected.id;
  canvas.toBlob(blob => {
    if (!blob) return setText($('photo-status'), '导出失败，请重试。');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `LensMind-${photoId}-${kind}.jpg`;
    anchor.click();
    if (state.selected?.id === photoId) setText($('photo-status'), '已发起下载，可在浏览器的下载记录中查看文件位置。');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/jpeg', .95);
}

const guides = ['请看向镜头，轻轻放松肩膀。', '请将你的右肩稍稍向后转。', '请稍微抬起下巴，保持自然微笑。'];

function clearGuide() {
  if (state.guidePending) {
    voice.cancel();
    setText($('preview-state'), '等待拍摄');
  }
  state.guidePending = false;
  $('guide-done').hidden = true;
  $('guide-panel').hidden = true;
}

function showGuide(text, fromModel = false) {
  state.stopResetConfirmed = false;
  state.guidePending = true;
  $('guide-panel').hidden = false;
  setText($('guide-text'), `${fromModel ? '模型建议' : '动作建议'} · ${text}`);
  $('guide-done').hidden = false;
  $('preview-state').textContent = '人物指导 · 机位保持静止';
  updateAvailability();
  log(`人物指导（手动确认）：${text}`);
  voice.speak(text);
}

function guide(text) {
  if (state.stopped || state.deviceAction || state.capturePending) return notify('请等待拍摄或复位完成。');
  if (state.guidePending) return notify('完成当前建议后，可以说「已完成」或点「已完成，继续」。');
  state.guide = (state.guide + 1) % guides.length;
  showGuide(guides[state.guide]);
}

function completeGuide() {
  if (!state.guidePending) return notify('当前没有待确认的动作建议。');
  clearGuide();
  updateAvailability();
  notify('已完成动作指导，请继续取景。');
  voice.speak('收到，动作指导完成。');
}

function applyAssistantSettings(settings, cropChanged) {
  if (!settings) return '';
  const framing = Object.hasOwn(framingLabels, settings.framing) ? settings.framing : undefined;
  const composition = Object.hasOwn(positionLabels, settings.composition) ? settings.composition : undefined;
  const cells = Array.isArray(settings.cells) && settings.cells.length > 0 && settings.cells.length <= 9
    && settings.cells.every(cell => Number.isInteger(cell) && cell >= 0 && cell <= 8) ? [...new Set(settings.cells)] : null;
  const part = settings.part === 'head' ? 'head' : undefined;
  const applied = [];
  if (!cropChanged && CROP_RATIOS.includes(settings.ratio)) {
    setRatio(settings.ratio);
    applied.push(`${cropRatioLabel(state.crop.ratio)}画幅`);
  }
  if (cells || (part && composition)) {
    const target = cells ? { cells, part } : { composition, part };
    if (setSceneTarget(target, framing)) applied.push(targetLabel(target), framingLabels[framing]);
  } else if (composition || framing) {
    compose(composition, framing);
    applied.push(positionLabels[composition], framingLabels[framing]);
  }
  if (!cropChanged && (settings.zoom === 'in' || settings.zoom === 'out') && zoomCrop(settings.zoom === 'in' ? .15 : -.15)) {
    applied.push(`${state.crop.zoom.toFixed(2)} 倍数字裁剪`);
  }
  return applied.filter(Boolean).join(' · ');
}

function receiveAdvice(result, { pose, applySettings, cropChanged, sceneChanged }) {
  const canApply = state.page === 'studio' && !document.hidden && !state.stopped && !state.capturePending && !state.deviceAction;
  const confirmation = applySettings && result.settings
    ? (canApply ? applyAssistantSettings(result.settings, cropChanged) : '') : null;
  if (confirmation !== null) {
    const summary = confirmation ? `当前设置：${confirmation}。` : cropChanged ? '取景已手动调整，继续使用当前设置。' : '当前画幅和构图设置保持原样。';
    if (canApply && confirmation) voice.speak(summary);
    return summary;
  }
  if (!canApply || sceneChanged) return null;
  const text = result.steps[0] || result.summary;
  if (pose && !state.guidePending) showGuide(text, true);
  else if (!state.guidePending) {
    const hint = /(?:现在|可以|直接|开始)\s*拍(?:照|摄|了)/.test(result.summary) ? currentPositionHint() : '';
    voice.speak(hint || result.summary);
  }
  return null;
}

function zoomCrop(delta) {
  const zoom = clamp(state.crop.zoom + delta, MIN_ZOOM, MAX_ZOOM);
  if (zoom === state.crop.zoom) {
    notify(delta > 0 ? '数字裁剪已放到最大。' : '数字裁剪已缩到最小。');
    return false;
  }
  state.crop.zoom = zoom;
  changeCrop();
  notify('已调整数字裁剪，未移动机位。');
  return true;
}

function runCommand(text) {
  if (state.page !== 'studio' || !text.trim()) return;
  const command = parseCommand(text, { depthMovement: Boolean(state.device?.so101) });
  log(`你：${text}`);
  const directShutter = isSpokenShutter(text) && (command.type === 'CAPTURE' || command.type === 'RETAKE');
  const question = /[?？]|怎么|如何|能不能|为什么|什么时候|什么样|是什么/.test(text);
  const directControl = directShutter || command.type === 'GUIDE_DONE' || (!question && ['STOP', 'MOVE', 'HOME', 'CAMERA_DISTANCE'].includes(command.type));
  if (directControl) return executeCommand(command, text);
  const localRequest = !question && !isAiCommand(text, command.type) && ['POSITION_PEOPLE', 'POSITION_BODY',
    'POSITION_HEAD', 'POSITION_SELECTED', 'SELECT_PERSON', 'CLEAR_HEAD_TARGET', 'ZOOM', 'COMPOSE', 'RATIO'].includes(command.type);
  if (ai.connected && !(command.type === 'GUIDE' && /预设|本地/.test(text))) {
    if (localRequest) executeCommand(command, text);
    const pose = command.type === 'GUIDE' && !/参考图|示例图/.test(text) && !state.guidePending && !state.capturePending;
    return ai.command(text, { assistant: true, pose, localRequest });
  }
  if (isAiCommand(text, command.type)) return ai.command(text);
  if (command.type === 'CAPTURE' || command.type === 'RETAKE') return notify('准备好时请直接说「拍摄」或「重拍」。');
  if (command.type === 'STOP') return notify('需要取消倒计时时，可以直接说「停止」。');
  executeCommand(command, text);
}

function executeCommand(command, text) {
  if (command.ratio) setRatio(command.ratio);
  switch (command.type) {
    case 'STOP': stopAll(); break;
    case 'HOME': home(); break;
    case 'CAPTURE': capture(); break;
    case 'RETAKE': retake(); break;
    case 'MOVE': move(command.direction); break;
    case 'CAMERA_DISTANCE': notify(`已理解相机需要${command.direction === 'NEARER' ? '靠近' : '远离'}，当前演示只支持上下左右微调。`); break;
    case 'SELECT_PERSON':
      if (visiblePeople().some(person => person.id === command.id)) selectPerson(command.id);
      else notify('请使用画面上当前可见的人物编号。');
      break;
    case 'POSITION_PEOPLE': setPersonPositions(command.targets, command.framing); break;
    case 'POSITION_HEAD': {
      const { type, framing, ratio, ...target } = command;
      setSceneTarget(target, framing);
      break;
    }
    case 'POSITION_BODY': setSceneTarget({ cells: command.cells }, command.framing); break;
    case 'CLEAR_HEAD_TARGET':
      if (state.sceneTarget?.part === 'head') setSceneTarget(null);
      else if (state.peopleTargets.get(state.selectedPerson)?.part === 'head') setPersonPositions([{ id: state.selectedPerson }]);
      else notify('当前没有选中的头部目标。');
      break;
    case 'POSITION_SELECTED':
      if (state.selectedPerson === null) setSceneTarget({ cells: command.cells });
      else setPersonPositions([{ id: state.selectedPerson, cells: command.cells }]);
      break;
    case 'GUIDE': guide(text); break;
    case 'GUIDE_DONE': completeGuide(); break;
    case 'ZOOM': zoomCrop(command.delta); break;
    case 'COMPOSE': compose(command.composition, command.framing); break;
    case 'RATIO': notify(`当前画幅为 ${cropRatioLabel(state.crop.ratio)}。`); break;
    default: notify(command.message); break;
  }
  if (command.ratio) voice.speak(`当前画幅为 ${cropRatioLabel(state.crop.ratio).replace(':', ' 比 ')}。`);
}

function setVoiceEnabled(enabled, message = '') {
  state.guidanceRequested = false;
  voice.setEnabled(enabled);
  setText($('voice-status'), message);
  $('voice-status').hidden = !message;
}

function applyPreferences(preferences) {
  $('thirds-grid').hidden = !preferences.grid;
  $('editor-grid').hidden = !preferences.grid || $('photo-dialog').dataset.view !== 'edit';
  $('live-crop').hidden = !preferences.frame;
  voice.configure({ rate: preferences.voiceRate, volume: preferences.voiceVolume });
  $('mic-button').disabled = !speech.available;
  const enabled = speech.handsFree && preferences.voiceEnabled;
  if (voice.enabled !== enabled) setVoiceEnabled(enabled);
  cancelCapture();
}

function showMicrophoneStatus({ handsFree, listening, message }) {
  const mic = $('mic-button');
  const micLabel = handsFree ? '关闭语音' : '开启语音';
  mic.classList.toggle('listening', listening);
  mic.setAttribute('aria-label', micLabel);
  mic.title = micLabel;
  mic.setAttribute('aria-pressed', handsFree);
  if (!handsFree && message) setVoiceEnabled(false);
  const provider = $('settings-asr-model').value === 'browser' ? '浏览器' : '云端';
  const status = message || (handsFree ? (listening ? `${provider}正在听，可以说「拍摄」「停止」或「清空」。` : '正在开启麦克风…') : '');
  setText($('mic-status'), status);
  $('mic-status').hidden = !status;
}

function setupVoice() {
  const mic = $('mic-button');
  if (!voice.available) {
    setVoiceEnabled(false, '当前浏览器不支持语音播报，可以查看文字提示。');
  }
  if (!speech.available) {
    mic.disabled = true;
    speech.stop('当前浏览器不支持语音识别，可以使用文字输入。');
  }
  mic.addEventListener('click', () => {
    const opening = !speech.handsFree;
    setVoiceEnabled(opening && settings.preferences.voiceEnabled, !voice.available ? '当前浏览器不支持语音播报，可以查看文字提示。' : '');
    speech.toggleHandsFree();
  });
}

function setPreviewSize(width, height) {
  if (width === preview.width && height === preview.height) return;
  preview.width = width;
  preview.height = height;
  $('viewfinder').style.aspectRatio = `${width} / ${height}`;
  setText($('resolution'), `${width} × ${height}`);
  ai.invalidateScene();
  syncCrop();
}

function fitCameraPreview() {
  if (!state.stream || !video.videoWidth || !video.videoHeight) return;
  const { width, height } = fitFrame(video.videoWidth, video.videoHeight,
    Math.min(1200, video.videoWidth), Math.min(1200, video.videoHeight));
  setPreviewSize(Math.round(width), Math.round(height));
}

function drawCameraFrame(context) {
  context.drawImage(video, 0, 0, context.canvas.width, context.canvas.height);
}

async function toggleCamera() {
  if (state.page !== 'studio') return;
  cancelCapture();
  if (state.cameraPending) return;
  if (state.stream) { releaseCamera(); notify('已关闭摄像头，返回模拟场景。'); return; }
  if (!navigator.mediaDevices?.getUserMedia) return notify('无法访问摄像头，请通过 localhost 或 HTTPS 打开页面。', true);
  const request = ++state.cameraRequest;
  state.cameraPending = true;
  $('camera-button').disabled = true;
  setText($('shoot-source-copy'), '正在等待摄像头权限。');
  updateAvailability();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1200 }, height: { ideal: 800 } }, audio: false });
    if (request !== state.cameraRequest) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    state.stream = stream;
    video.srcObject = state.stream;
    await video.play();
    if (request !== state.cameraRequest) return;
    fitCameraPreview();
    const draw = () => {
      if (!state.stream) return;
      if (video.readyState >= 2) drawCameraFrame(ctx);
      state.animation = requestAnimationFrame(draw);
    };
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (state.stream !== stream) return;
      cancelCapture();
      releaseCamera();
      notify('摄像头连接中断，已取消拍摄并返回模拟场景。', true);
    }));
    draw();
    $('source-label').textContent = '◉ 电脑摄像头';
    $('camera-button').textContent = '关闭摄像头';
    setText($('shoot-source-copy'), '当前使用电脑摄像头。');
    showVisionReading({ status: 'loading', stable: false });
    state.stopVision = startVision(video, () => ({
      composition: state.composition, framing: state.framing, pinnedIds: state.peopleTargets,
      detectHeads: state.sceneTarget?.part === 'head' || [...state.peopleTargets.values()].some(target => target.part === 'head'),
    }), showVisionReading);
    notify('电脑摄像头已开启。');
  } catch {
    if (request === state.cameraRequest) {
      releaseCamera();
      notify('摄像头开启失败，请检查权限或设备占用。', true);
    }
  } finally {
    if (request === state.cameraRequest) {
      state.cameraPending = false;
      $('camera-button').disabled = false;
      updateAvailability();
    }
  }
}

function releaseCamera() {
  state.cameraRequest++;
  state.cameraPending = false;
  $('camera-button').disabled = false;
  voice.reset();
  clearGuide();
  ai.cancel('摄像头已关闭，已停止等待 AI 分析。');
  ai.invalidateScene();
  state.stopVision?.();
  state.stopVision = null;
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  cancelAnimationFrame(state.animation);
  video.srcObject = null;
  state.peopleTargets.clear();
  state.selectedPerson = null;
  showVisionReading(null);
  setPreviewSize(1200, 800);
  $('source-label').textContent = '◉ 模拟场景 · 非实时摄像头';
  $('camera-button').textContent = '开启电脑摄像头';
  setText($('shoot-source-copy'), '当前使用演示画面。');
  drawDemo();
}

// A 成员：页面事件与照片管理；B 成员替换 commands.js 和指导/视觉数据源。
document.querySelectorAll('button[data-capture-mode]').forEach(button => {
  button.addEventListener('click', () => setCaptureMode(button.dataset.captureMode));
});
document.querySelectorAll('[data-composition]').forEach(button => button.addEventListener('click', () => compose(button.dataset.composition)));
document.querySelectorAll('[data-framing]').forEach(button => button.addEventListener('click', () => compose(undefined, button.dataset.framing)));
document.querySelectorAll('[data-person-position]').forEach(button => button.addEventListener('click', () => {
  setPersonPositions([{ id: state.selectedPerson, composition: button.dataset.personPosition, part: state.peopleTargets.get(state.selectedPerson)?.part }]);
}));
document.querySelectorAll('[data-person-cell]').forEach(button => button.addEventListener('click', () => {
  togglePersonCell(Number(button.dataset.personCell));
}));
document.querySelectorAll('[data-ratio]').forEach(button => button.addEventListener('click', () => setRatio(button.dataset.ratio)));
document.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => move(button.dataset.direction)));
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { $('command-input').value = button.dataset.command; runCommand(button.dataset.command); }));
$('capture-button').addEventListener('click', capture);
$('clear-head-target').addEventListener('click', () => setSceneTarget(null));
stopButtons.forEach(button => button.addEventListener('click', stopAll));
$('home-button').addEventListener('click', home);
$('camera-button').addEventListener('click', toggleCamera);
$('command-clear').addEventListener('click', () => {
  const input = $('command-input');
  input.value = '';
  input.focus();
});
$('command-form').addEventListener('submit', event => { event.preventDefault(); runCommand($('command-input').value); });
$('guide-done').addEventListener('click', completeGuide);
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('help-start').addEventListener('click', () => $('help-dialog').close());
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('close-photo').addEventListener('click', () => $('photo-dialog').close());
document.querySelectorAll('[data-photo-view]').forEach(button => {
  button.addEventListener('click', () => showPhotoView(button.dataset.photoView));
});
$('save-crop').addEventListener('click', saveCrop);
$('editor-ratio').addEventListener('change', event => { rememberCrop(); state.draft.ratio = event.target.value; syncEditor(); });
$('editor-zoom').addEventListener('pointerdown', rememberCrop);
$('editor-zoom').addEventListener('keydown', rememberCrop);
$('editor-zoom').addEventListener('input', event => { state.draft.zoom = Number(event.target.value); syncEditor(); });
$('undo-crop').addEventListener('click', () => { if (state.undo.length) { state.draft = state.undo.pop(); syncEditor(); } });
$('download-original').addEventListener('click', () => download(state.selected.original, 'original'));
$('download-crop').addEventListener('click', () => download(renderCrop(state.selected.original, photoCrop()), 'crop'));
$('retake').addEventListener('click', () => { $('photo-dialog').close(); location.hash = 'studio'; });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !['studio', 'settings'].includes(state.page)) return;
  event.preventDefault();
  if (event.repeat) return;
  $('help-dialog').close();
  stopAll();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  cancelCapture();
  const hadHandsFree = speech.handsFree;
  speech.stop(hadHandsFree ? '切到后台时已关闭语音。' : '');
  setVoiceEnabled(false);
});
window.addEventListener('pagehide', () => { ai.clearKey(); cloud.clearKey(); speech.stop(); setVoiceEnabled(false); releaseCamera(); });
video.addEventListener('resize', fitCameraPreview);
attachDrag($('live-crop'), () => state.crop, () => ({ width: preview.width, height: preview.height }), changeCrop);
attachDrag($('editor-crop'), () => state.draft, () => ({ width: state.selected.original.width, height: state.selected.original.height }), syncEditor, rememberCrop);
demoImage.onload = drawDemo;
demoImage.onerror = () => notify('模拟场景加载失败，请检查静态资源。', true);
demoImage.src = '/assets/demo-scene.svg';
syncCrop();
setupVoice();
applyPreferences(settings.preferences);
cloud.refresh();
window.addEventListener('hashchange', () => showPage());
showPage(false);
updateAvailability();
log('欢迎来到灵眸。当前显示模拟场景，打开电脑摄像头后可体验人物分析。');
pollStatus();
setInterval(pollStatus, 4000);
