import { cellBounds, gridLabel, gridPosition, intersectionArea } from './grid.js';

const PERSON_STILL_MS = 1000;
const KEEP_TRACK_MS = 4200;
const HOLD_LABEL_MS = 850;
const CONFIRM_FRAMES = 3;
const CONFIRM_MS = 400;
const MAX_PEOPLE = 8;
export const MAX_FRAME_AGE = 1500;
export const COMPOSITION_X = { left: 1 / 3, center: .5, right: 2 / 3 };
const COMPOSITION_HALF_WIDTH = 1 / 6;

// 坐标以未镜像的原始画面左上角为原点，单位为该方向上的画面比例。
export function fitFrame(sourceWidth, sourceHeight, previewWidth, previewHeight) {
  const scale = Math.min(previewWidth / sourceWidth, previewHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (previewWidth - width) / 2, y: (previewHeight - height) / 2, width, height };
}

function center(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const insideCrop = point => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;

export function cropVisionFrame(frame, crop) {
  if (!frame) return null;
  const project = box => box && ({
    x: (box.x - crop.x) / crop.width, y: (box.y - crop.y) / crop.height,
    width: box.width / crop.width, height: box.height / crop.height,
  });
  const clip = box => {
    if (!box) return null;
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const width = Math.min(1, box.x + box.width) - x;
    const height = Math.min(1, box.y + box.height) - y;
    return width > 0 && height > 0 ? { ...box, x, y, width, height } : null;
  };
  return {
    ...frame,
    width: frame.width * crop.width, height: frame.height * crop.height,
    faces: frame.faces?.map(project) ?? frame.faces,
    people: frame.people?.map(tracked => {
      const person = clip(project(tracked.person));
      const pose = Object.fromEntries(Object.entries(tracked.person.pose ?? {}).map(([name, point]) => [name, {
        x: (point.x - crop.x) / crop.width, y: (point.y - crop.y) / crop.height,
      }]));
      return { ...tracked, person, pose, face: project(tracked.face), position: person && center(person),
        occupancy: person ? person.width * person.height : 0 };
    }),
  };
}

export function compositionRegions(target) {
  return target.cells ? target.cells.map(cellBounds)
    : [{ x: COMPOSITION_X[target.composition] - COMPOSITION_HALF_WIDTH, y: 0, width: COMPOSITION_HALF_WIDTH * 2, height: 1 }];
}

function mostlyInArea(boxes, target) {
  const regions = compositionRegions(target);
  const area = boxes.reduce((total, box) => total + box.width * box.height, 0);
  const covered = boxes.reduce((total, box) => total + regions.reduce((sum, region) => sum + intersectionArea(box, region), 0), 0);
  return area > 0 && covered > area / 2 + 1e-10;
}

export function framingHint(analysis, framing, targets) {
  if (framing !== 'half' && framing !== 'full') return '';
  const half = framing === 'half';
  const required = half ? '从头顶到腰胯' : '从头顶到双脚';
  const people = (analysis?.people ?? []).filter(person => person.person && (!targets.size || targets.has(person.id)));
  if (!people.length) return `请让人物${required}入镜。`;
  if (!Array.isArray(analysis.poses)) return '正在等待姿态检测，请确认本机已准备姿态模型。';
  if (!Array.isArray(analysis.faces)) return '正在等待人脸检测，请确认本机已准备人脸模型。';
  for (const person of people) {
    const label = people.length > 1 || targets.size ? `人物 ${person.id}，` : '';
    const { nose, leftShoulder, rightShoulder, leftHip, rightHip } = person.pose ?? {};
    if (![nose, leftShoulder, rightShoulder, leftHip, rightHip].every(point => point && insideCrop(point))) {
      return `${label}请让${required}都进入裁剪框。`;
    }
    const shoulders = Math.min(leftShoulder.y, rightShoulder.y);
    const hips = Math.max(leftHip.y, rightHip.y);
    const face = person.face;
    // 用独立的人脸检测和关节顺序排除近距离时模型推测出的肩胯。
    if (!face || nose.y >= shoulders || hips - shoulders < face.height
        || nose.x < face.x - .15 * face.width || nose.x > face.x + 1.15 * face.width
        || nose.y < face.y || nose.y > face.y + face.height) {
      return `${label}请面向镜头，让${required}都清楚入镜。`;
    }
    const headTop = Math.min(face.y - .12 * face.height, nose.y - .65 * (shoulders - nose.y));
    if (!insideCrop({ x: face.x, y: face.y }) || !insideCrop({ x: face.x + face.width, y: face.y + face.height })) {
      return `${label}请把头部完整留在裁剪框内。`;
    }
    if (headTop < .015) return `${label}请给头顶留一点空间。`;
    if (half) {
      if (1 - hips > .55 * Math.max(.08, hips - shoulders)) return `${label}请把裁剪框下边缘收紧到腰胯附近，保留完整上半身。`;
    } else {
      const lower = ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftToe', 'rightToe'];
      if (!lower.every(name => person.pose[name] && insideCrop(person.pose[name]))
          || Math.max(person.pose.leftToe.y, person.pose.rightToe.y, person.pose.leftHeel.y, person.pose.rightHeel.y) > .99) {
        return `${label}请把双腿和双脚完整留在裁剪框内。`;
      }
    }
  }
  return '';
}

export function capturePositionHint(analysis, composition, targets, { headTarget, bodyTarget, framing, skipPosition, now = Date.now() } = {}) {
  if (skipPosition && framing !== 'half' && framing !== 'full') return '';
  if (analysis?.status === 'error') return '人物分析暂不可用，恢复后可拍摄。';
  if (!analysis?.timestamp || now - analysis.timestamp > MAX_FRAME_AGE) return '等待人物分析更新后可拍摄。';
  const frameHint = framingHint(analysis, framing, targets);
  if (frameHint || skipPosition) return frameHint;
  const people = analysis.people ?? [];
  const visibleBodies = people.flatMap(tracked => tracked.person ? [tracked.person] : []);
  if (headTarget) {
    if (!analysis.faces) return '正在等待头部定位，请确认本机已安装人脸模型。';
    const visibleFaces = analysis.faces.filter(face => insideCrop(center(face)));
    if (visibleFaces.length > 1 || visibleBodies.length > 1) return '多人同框时请指定人物编号，例如「人物1的头在右下角」。';
    return headPositionHint(visibleFaces[0] ?? analysis.faces[0], headTarget);
  }
  if (targets.size) {
    return pendingPersonTarget(analysis, targets)?.hint ?? '';
  }
  if (!people.length) return '等人物出现在取景画面中。';
  if (!visibleBodies.length) return '请让人物进入当前裁剪框。';
  return mostlyInArea(visibleBodies, bodyTarget ?? { composition })
    ? '' : '请让人物的大部分进入所选构图区域。';
}

export function pendingPersonTarget(analysis, targets) {
  const people = analysis?.people ?? [];
  for (const [id, target] of targets) {
    const person = people.find(item => item.id === id);
    let hint = '';
    if (!person) hint = `等待人物 ${id} 回到画面，或清除该人物的目标。`;
    else if (target.part === 'head') hint = analysis.faces ? headPositionHint(person.face, target, `人物 ${id} 的`)
      : '正在等待头部定位，请确认本机已安装人脸模型。';
    else if (!person.person) hint = `请让人物 ${id} 进入当前裁剪框。`;
    else if (!mostlyInArea([person.person], target)) hint = `请让人物 ${id} 的大部分进入目标区域。`;
    if (hint) return { id, target, person, hint };
  }
  return null;
}

function headPositionHint(face, target, prefix = '') {
  if (!face) return `暂未看清${prefix}头部，请让脸部朝向镜头。`;
  const point = center(face);
  if (!insideCrop(point)) return `请让${prefix}头部进入当前裁剪框。`;
  const inside = target.cells ? gridPosition(point, target.cells).inside
    : Math.abs(point.x - COMPOSITION_X[target.composition]) <= COMPOSITION_HALF_WIDTH;
  return inside ? '' : `请让${prefix}头部进入目标区域。`;
}

export function liveCompositionCue(analysis, composition, targets, { headTarget, bodyTarget, framing, skipPosition, now = Date.now() } = {}) {
  if (!analysis?.timestamp || now - analysis.timestamp > MAX_FRAME_AGE || analysis.status === 'error') return '';
  if (skipPosition && framing !== 'half' && framing !== 'full') return '';
  const frameHint = framingHint(analysis, framing, targets);
  if (frameHint) return frameHint.startsWith('正在等待') ? '' : frameHint;
  const hint = capturePositionHint(analysis, composition, targets, { headTarget, bodyTarget, skipPosition, now });
  if (!hint) return '构图已到位，可以拍了。';
  const people = analysis.people ?? [];
  if (headTarget) {
    const visibleFaces = analysis.faces?.filter(face => insideCrop(center(face))) ?? [];
    if (visibleFaces.length !== 1 || people.filter(person => person.person).length > 1) return '';
    return directionCue(center(visibleFaces[0]), headTarget);
  }
  if (targets.size) {
    const unmet = pendingPersonTarget(analysis, targets);
    if (!unmet) return '';
    const { id, target, person } = unmet;
    const subject = `人物 ${id}，`;
    if (!person) return analysis.occluded?.includes(id) ? '' : `${subject}请回到取景画面。`;
    if (target.part === 'head') {
      if (!analysis.faces) return '';
      if (!person.face) return `${subject}请稍微转向镜头，让脸露出来。`;
      const point = center(person.face);
      if (!insideCrop(point)) return `${subject}请把头挪进裁剪框。`;
      return directionCue(point, target, subject);
    }
    return person.person ? directionCue(person.position, target, subject) : `${subject}请挪进裁剪框。`;
  }
  if (people.length !== 1) return '';
  return people[0].position ? directionCue(people[0].position, bodyTarget ?? { composition }) : '请往取景框里挪一点。';
}

function directionCue(point, target, subject = '') {
  const offset = target.cells ? gridPosition(point, target.cells) : { x: COMPOSITION_X[target.composition] - point.x, y: 0 };
  if (Math.abs(offset.x) <= .015 && Math.abs(offset.y) <= .015) {
    const area = target.cells ? gridLabel(target.cells) : '金色引导线标出的区域';
    return `${subject}请让人物更多地进入${area}。`;
  }
  const direction = Math.abs(offset.x) >= Math.abs(offset.y) ? (offset.x > 0 ? '右侧' : '左侧') : (offset.y > 0 ? '下方' : '上方');
  const part = target.part === 'head' ? '把头往' : '往';
  return `${subject}请${part}画面${direction}挪一点。`;
}

function assignFaces(people, faces) {
  for (const face of faces) {
    const point = center(face);
    const candidates = [];
    for (const person of people) {
      const box = person.person;
      const relX = (point.x - box.x) / box.width;
      const relY = (point.y - box.y) / box.height;
      if (relX < -.15 || relX > 1.15 || relY < -.15 || relY > 1.1) continue;
      const cost = Math.abs(relX - .5) + Math.abs(relY - .16);
      candidates.push({ person, cost });
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const [best, second] = candidates;
    if (best && !best.person.face && (!second || second.cost - best.cost >= .12)) best.person.face = face;
  }
}

export function composeAdvice(frame, target) {
  const { person, width, height } = frame;
  const position = center(person);
  const targetX = COMPOSITION_X[target.composition];
  const inArea = mostlyInArea([person], target);
  const grid = target.cells ? gridPosition(position, target.cells) : null;
  const offset = grid ? -grid.x : position.x - targetX;
  const horizontal = grid ? (inArea ? '人物大部分已进入目标区域' : '人物大部分尚未进入目标区域')
    : inArea ? '位置接近目标' : offset < 0 ? '人物偏左' : offset > 0 ? '人物偏右' : '人物仍跨出目标区域';
  const explicitFraming = target.framing === 'half' || target.framing === 'full';
  const ratio = person.width * width / (person.height * height);
  const topClipped = person.y < .015;
  const bottomClipped = person.y + person.height > .98;
  const tooSmall = person.height < (target.framing === 'full' ? .62 : .50);
  const framing = !explicitFraming ? '' : tooSmall ? '人物占比过小'
    : topClipped ? '头顶留白不足'
    : target.framing === 'full'
      ? (bottomClipped || ratio > .56 ? '画面偏紧，请检查是否拍到脚部' : '全身取景比例接近目标，请确认脚部在画面内')
      : (ratio < .56 && !bottomClipped ? '取景偏远，可尝试半身裁剪' : '半身取景比例接近目标，请确认腰部边界');

  let adjustment = null;
  if (!inArea && grid && !grid.inside) {
    const x = grid.x < 0 ? '左' : '右';
    const y = grid.y < 0 ? '上' : '下';
    const dominant = Math.abs(grid.x) >= Math.abs(grid.y)
      ? (grid.x < 0 ? 'SUBJECT_LEFT' : 'SUBJECT_RIGHT')
      : (grid.y < 0 ? 'SUBJECT_UP' : 'SUBJECT_DOWN');
    const direction = [Math.abs(grid.x) > .015 ? x : '', Math.abs(grid.y) > .015 ? y : ''].join('');
    adjustment = { type: dominant, step: 'SMALL', text: `请让人物在画面中稍向${direction}移动。` };
  } else if (!inArea && offset < -.015) {
    adjustment = { type: 'SUBJECT_RIGHT', step: 'SMALL', text: '请让人物在画面中稍向右并重新检查。' };
  } else if (!inArea && offset > .015) {
    adjustment = { type: 'SUBJECT_LEFT', step: 'SMALL', text: '请让人物在画面中稍向左并重新检查。' };
  }
  if (!adjustment && explicitFraming && tooSmall) adjustment = { type: 'ENLARGE_SUBJECT', step: 'SMALL', text: '可以小幅增加人物占比，再检查新画面。' };
  if (!adjustment && explicitFraming && !tooSmall && (topClipped || (target.framing === 'full' && (bottomClipped || ratio > .56)))) {
    adjustment = { type: 'ADD_MARGIN', step: 'SMALL', text: '可以小幅留出空间，再检查新画面。' };
  }
  if (!adjustment && target.framing === 'half' && !tooSmall && !topClipped && ratio < .56 && !bottomClipped) {
    adjustment = { type: 'ENLARGE_SUBJECT', step: 'SMALL', text: '可以小幅调整数字裁剪，再检查新画面。' };
  }
  return { position, horizontal, framing, adjustment };
}

function remainsStill(previous, box) {
  const a = center(previous);
  const b = center(box);
  return Math.hypot(a.x - b.x, a.y - b.y) <= .025
    && Math.abs(previous.width - box.width) <= .04
    && Math.abs(previous.height - box.height) <= .04;
}

function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

function uniquePeople(boxes) {
  const people = [];
  for (const box of [...boxes].sort((a, b) => b.confidence - a.confidence)) {
    if (people.every(person => overlap(person, box) < .58)) people.push(box);
  }
  return people.slice(0, MAX_PEOPLE);
}

function matchCost(track, person, timestamp, confirmed) {
  const elapsed = timestamp - track.timestamp;
  const a = center(track.person);
  const b = center(person);
  const lookAhead = elapsed <= HOLD_LABEL_MS ? Math.min(elapsed, 400) : 0;
  const limit = n => Math.max(-.16, Math.min(.16, n));
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const predicted = Math.hypot(b.x - a.x - limit(track.velocity.x * lookAhead), b.y - a.y - limit(track.velocity.y * lookAhead));
  const displacement = Math.min(predicted, distance + .06);
  const sizeChange = Math.abs(person.width - track.person.width) + Math.abs(person.height - track.person.height);
  const radius = confirmed ? (elapsed <= HOLD_LABEL_MS ? .34 : .23) : .21;
  if (displacement > radius || sizeChange > .65) return Infinity;
  return displacement + .26 * sizeChange + .12 * Math.min(1, elapsed / KEEP_TRACK_MS) - .025 * overlap(track.person, person);
}

function matchPeople(tracks, detections, timestamp, confirmed) {
  const costs = tracks.map(track => detections.map(person => matchCost(track, person, timestamp, confirmed)));
  const memo = tracks.map(() => new Map());
  // 每帧最多八个框。一次选择总代价最低的一对一匹配，避免先匹配的框抢走另一人的编号。
  function best(index, remaining) {
    if (index === tracks.length || !remaining) return { cost: .72 * (tracks.length - index), detection: -1 };
    if (memo[index].has(remaining)) return memo[index].get(remaining);
    let result = { cost: .72 + best(index + 1, remaining).cost, detection: -1 };
    for (const [detection, cost] of costs[index].entries()) {
      const bit = 1 << detection;
      if (!(remaining & bit) || !Number.isFinite(cost)) continue;
      const total = cost + best(index + 1, remaining ^ bit).cost;
      if (total < result.cost) result = { cost: total, detection };
    }
    memo[index].set(remaining, result);
    return result;
  }
  const matches = new Map();
  let remaining = (1 << detections.length) - 1;
  for (const [index, track] of tracks.entries()) {
    const { detection } = best(index, remaining);
    if (detection < 0) continue;
    matches.set(detections[detection], track);
    remaining ^= 1 << detection;
  }
  return matches;
}

function updateTrack(track, person, timestamp) {
  const position = center(person);
  const elapsed = timestamp - track.timestamp;
  const previous = center(track.person);
  const velocity = elapsed > 0 && elapsed <= HOLD_LABEL_MS ? {
    x: .25 * track.velocity.x + .75 * (position.x - previous.x) / elapsed,
    y: .25 * track.velocity.y + .75 * (position.y - previous.y) / elapsed,
  } : { x: 0, y: 0 };
  if (!track.anchor || elapsed > MAX_FRAME_AGE || !remainsStill(track.anchor.person, person)) {
    track.anchor = { person, timestamp };
    track.samples = 0;
  }
  track.samples++;
  track.person = person;
  track.timestamp = timestamp;
  track.velocity = velocity;
  return {
    id: track.id,
    person,
    position,
    occupancy: person.width * person.height,
    stable: track.samples >= 3 && timestamp - track.anchor.timestamp >= PERSON_STILL_MS,
  };
}

export function createVisionTracker() {
  let seen = false;
  let lastTimestamp = 0;
  let tentative = [];
  const tracks = new Map();

  const resetStability = () => {
    tentative = [];
    for (const track of tracks.values()) {
      track.anchor = null;
      track.samples = 0;
    }
  };

  return {
    resetStability,
    update(frame, target) {
      if (frame.timestamp <= lastTimestamp) return null;
      lastTimestamp = frame.timestamp;
      const raw = frame.people ?? (frame.person ? [frame.person] : []);
      const detections = uniquePeople(raw.map((person, index) => frame.poses?.[index]
        ? { ...person, pose: frame.poses[index] } : person));
      for (const [id, track] of tracks) {
        if (frame.timestamp - track.timestamp > KEEP_TRACK_MS) tracks.delete(id);
      }
      const matches = matchPeople([...tracks.values()], detections, frame.timestamp, true);
      const visibleTracks = new Set(matches.values());
      for (const track of tracks.values()) {
        if (visibleTracks.has(track)) continue;
        track.anchor = null;
        track.samples = 0;
      }
      const people = [...matches].map(([person, track]) => updateTrack(track, person, frame.timestamp));
      const unmatched = detections.filter(person => !matches.has(person)
        && people.every(known => overlap(known.person, person) < .45));
      const pending = matchPeople(tentative.filter(track => frame.timestamp - track.timestamp <= MAX_FRAME_AGE),
        unmatched, frame.timestamp, false);
      tentative = [];
      const ordered = unmatched.sort((a, b) => center(a).x - center(b).x || center(a).y - center(b).y);
      for (const person of ordered) {
        const track = pending.get(person) ?? {
          person, timestamp: frame.timestamp, firstSeen: frame.timestamp, hits: 0, samples: 0, velocity: { x: 0, y: 0 },
        };
        track.hits++;
        const reading = updateTrack(track, person, frame.timestamp);
        const available = Array.from({ length: MAX_PEOPLE }, (_, index) => index + 1)
          .find(id => !tracks.has(id) && !target.pinnedIds?.has(id));
        if (track.hits >= CONFIRM_FRAMES && frame.timestamp - track.firstSeen >= CONFIRM_MS && available) {
          track.id = available;
          tracks.set(available, track);
          people.push({ ...reading, id: available });
          visibleTracks.add(track);
        } else {
          tentative.push(track);
        }
      }
      people.sort((a, b) => a.id - b.id);
      if (frame.faces?.length) assignFaces(people, frame.faces);
      const occluded = [...tracks.values()].filter(track =>
        !visibleTracks.has(track) && frame.timestamp - track.timestamp <= HOLD_LABEL_MS).map(track => track.id);
      if (!people.length) {
        const status = occluded.length ? 'reacquiring' : tentative.length ? 'acquiring' : seen ? 'lost' : 'empty';
        return { ...frame, people, occluded, detected: false, stable: false, status };
      }
      seen = true;
      const stable = !occluded.length && !tentative.length && people.every(person => person.stable);
      const primary = people.reduce((best, person) => person.person.confidence > best.person.confidence ? person : best);
      return {
        ...frame, people, occluded, detected: true, stable, status: stable ? 'stable' : 'moving',
        occupancy: primary.occupancy,
        ...composeAdvice({ ...frame, person: primary.person }, target),
      };
    },
  };
}

// 摄像头打开才取帧，同一时间最多请求一帧，关闭后取消请求并丢弃迟到的结果。
export function startVision(video, getTarget, onReading) {
  const tracker = createVisionTracker();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  let frameId = 0;
  let lastVideoTime = -1;
  let lastReadingAt = 0;
  let running = true;
  let sampling = false;
  let request = null;
  let failureReported = false;

  const timer = setInterval(async () => {
    if (document.hidden) return;
    if (lastReadingAt && Date.now() - lastReadingAt > MAX_FRAME_AGE) {
      lastReadingAt = 0;
      tracker.resetStability();
      onReading({ status: 'waiting', stable: false });
    }
    if (video.readyState < 2 || sampling || video.currentTime === lastVideoTime) return;
    sampling = true;
    lastVideoTime = video.currentTime;
    const timestamp = Date.now();
    const id = ++frameId;
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    let timeout;
    try {
      context.drawImage(video, 0, 0, width, height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .72));
      if (!running) return;
      if (!jpeg) throw new Error('无法生成分析画面。');
      request = new AbortController();
      timeout = setTimeout(() => request.abort(), 4500);
      const target = getTarget();
      const query = new URLSearchParams({ frameId: id, timestamp });
      const checkPose = target.framing === 'half' || target.framing === 'full';
      if (target.detectHeads || checkPose) query.set('head', 'true');
      if (checkPose) query.set('pose', 'true');
      const response = await fetch(`/api/vision/person?${query}`, {
        method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' }, signal: request.signal,
      });
      if (response.status === 429) return;
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '人物分析服务暂不可用。');
      if (!running || document.hidden || result.frameId !== id || result.timestamp !== timestamp) return;
      // 首次模型预热可能较慢，只使用新近的检测结果判断构图位置。
      if (Date.now() - timestamp > MAX_FRAME_AGE) return;
      const analysis = tracker.update(result, getTarget());
      if (analysis) {
        lastReadingAt = timestamp;
        failureReported = false;
        onReading(analysis);
      }
    } catch (error) {
      if (running && !failureReported) {
        lastReadingAt = 0;
        failureReported = true;
        tracker.resetStability();
        onReading({ status: 'error', stable: false, message: error.name === 'AbortError' ? '人物分析超时，正在重试。' : error.message });
      }
    } finally {
      clearTimeout(timeout);
      request = null;
      sampling = false;
    }
  }, 250);

  return () => {
    running = false;
    clearInterval(timer);
    request?.abort();
  };
}
