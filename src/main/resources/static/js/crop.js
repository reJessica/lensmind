// 纯数字裁剪：所有坐标为原片归一化坐标，独立于机械臂控制。
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2.5;
export const CROP_RATIOS = ['original', '1:1', '4:3', '3:4', '16:9', '9:16'];
export const cropRatioLabel = ratio => ratio === 'original' ? '原比例' : ratio;

export function cropRect(width, height, crop) {
  const ratio = crop.ratio === 'original' ? width / height : crop.ratio.split(':').map(Number).reduce((a, b) => a / b);
  let w = width;
  let h = w / ratio;
  if (h > height) { h = height; w = h * ratio; }
  w /= crop.zoom;
  h /= crop.zoom;
  const x = clamp(crop.cx * width - w / 2, 0, width - w);
  const y = clamp(crop.cy * height - h / 2, 0, height - h);
  return { x, y, w, h };
}

export function renderCrop(original, crop, result = document.createElement('canvas')) {
  const { x, y, w, h } = cropRect(original.width, original.height, crop);
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  if (result.width !== width) result.width = width;
  if (result.height !== height) result.height = height;
  const context = result.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.drawImage(original, x, y, w, h, 0, 0, width, height);
  return result;
}

export function cropRegion(width, height, crop) {
  const { x, y, w, h } = cropRect(width, height, crop);
  return { x: x / width, y: y / height, width: w / width, height: h / height };
}

export function positionRegion(element, region) {
  Object.assign(element.style, {
    left: `${region.x * 100}%`, top: `${region.y * 100}%`,
    width: `${region.width * 100}%`, height: `${region.height * 100}%`,
  });
}

export function resizeCrop(width, height, crop, corner, dx, dy) {
  const { x, y, w, h } = cropRect(width, height, crop);
  const sx = corner.endsWith('e') ? 1 : -1;
  const sy = corner.startsWith('s') ? 1 : -1;
  const anchorX = sx > 0 ? x : x + w;
  const anchorY = sy > 0 ? y : y + h;
  const maxScale = Math.min(crop.zoom / MIN_ZOOM, (sx > 0 ? width - anchorX : anchorX) / w,
    (sy > 0 ? height - anchorY : anchorY) / h);
  const desiredScale = 1 + (sx * dx * w + sy * dy * h) / (w * w + h * h);
  const scale = clamp(desiredScale, crop.zoom / MAX_ZOOM, maxScale);
  return {
    zoom: clamp(crop.zoom / scale, MIN_ZOOM, MAX_ZOOM),
    cx: (anchorX + sx * w * scale / 2) / width,
    cy: (anchorY + sy * h * scale / 2) / height,
  };
}

export function attachDrag(element, getCrop, getSize, onChange, onStart) {
  let drag = null;
  const change = (next, first) => {
    const crop = getCrop();
    if (Object.entries(next).every(([key, value]) => Math.abs(crop[key] - value) < 1e-8)) return false;
    if (first) onStart?.();
    Object.assign(crop, next);
    onChange();
    return true;
  };
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const crop = getCrop();
    const { width, height } = getSize();
    const rect = cropRect(width, height, crop);
    // 从实际框中心开始，避免边缘裁剪时拖动发生跳跃。
    drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY, corner: event.target.closest('[data-corner]')?.dataset.corner,
      crop: { ...crop, cx: (rect.x + rect.w / 2) / width, cy: (rect.y + rect.h / 2) / height }, changed: false,
    };
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  element.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const bounds = element.parentElement.getBoundingClientRect();
    const { width, height } = getSize();
    const dx = (event.clientX - drag.x) / bounds.width;
    const dy = (event.clientY - drag.y) / bounds.height;
    const rect = cropRect(width, height, drag.crop);
    const next = drag.corner ? resizeCrop(width, height, drag.crop, drag.corner, dx * width, dy * height) : {
      cx: clamp(drag.crop.cx + dx, rect.w / width / 2, 1 - rect.w / width / 2),
      cy: clamp(drag.crop.cy + dy, rect.h / height / 2, 1 - rect.h / height / 2),
    };
    if (change(next, !drag.changed)) drag.changed = true;
  });
  for (const type of ['pointerup', 'lostpointercapture', 'pointercancel']) {
    element.addEventListener(type, event => { if (drag?.id === event.pointerId) drag = null; });
  }
  element.addEventListener('keydown', event => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    const corner = event.target.dataset.corner;
    if (!direction || !corner || drag) return;
    event.preventDefault();
    const { width, height } = getSize();
    const bounds = element.parentElement.getBoundingClientRect();
    const step = event.shiftKey ? 16 : 4;
    change(resizeCrop(width, height, getCrop(), corner,
      direction[0] * step * width / bounds.width, direction[1] * step * height / bounds.height), true);
  });
}
