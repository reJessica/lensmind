// 纯数字裁剪：所有坐标为原片归一化坐标，独立于机械臂控制。
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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

export function renderCrop(original, crop) {
  const { x, y, w, h } = cropRect(original.width, original.height, crop);
  const result = document.createElement('canvas');
  result.width = Math.max(1, Math.round(w));
  result.height = Math.max(1, Math.round(h));
  result.getContext('2d').drawImage(original, x, y, w, h, 0, 0, result.width, result.height);
  return result;
}

export function positionFrame(element, width, height, crop) {
  const { x, y, w, h } = cropRect(width, height, crop);
  Object.assign(element.style, {
    left: `${x / width * 100}%`, top: `${y / height * 100}%`,
    width: `${w / width * 100}%`, height: `${h / height * 100}%`,
  });
}

export function attachDrag(element, getCrop, getSize, onChange) {
  let drag = null;
  element.addEventListener('pointerdown', event => {
    const crop = getCrop();
    const { width, height } = getSize();
    const rect = cropRect(width, height, crop);
    // 从实际框中心开始，避免边缘裁剪时拖动发生跳跃。
    drag = { x: event.clientX, y: event.clientY, cx: (rect.x + rect.w / 2) / width, cy: (rect.y + rect.h / 2) / height };
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  element.addEventListener('pointermove', event => {
    if (!drag) return;
    const bounds = element.parentElement.getBoundingClientRect();
    const crop = getCrop();
    const { width, height } = getSize();
    const rect = cropRect(width, height, crop);
    crop.cx = clamp(drag.cx + (event.clientX - drag.x) / bounds.width, rect.w / width / 2, 1 - rect.w / width / 2);
    crop.cy = clamp(drag.cy + (event.clientY - drag.y) / bounds.height, rect.h / height / 2, 1 - rect.h / height / 2);
    onChange();
  });
  element.addEventListener('pointerup', () => { drag = null; });
  element.addEventListener('lostpointercapture', () => { drag = null; });
  element.addEventListener('pointercancel', () => { drag = null; });
}
