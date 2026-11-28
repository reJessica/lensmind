import { GRID_NAMES, gridLabel } from './grid.js';

const $ = id => document.getElementById(id);
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

async function request(path, method = 'GET', body, signal) {
  let response;
  try {
    response = await fetch(`/api/ai/${path}`, {
      method, signal, cache: 'no-store',
      ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接本机模型服务，请检查灵眸是否正在运行。');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    throw Object.assign(new Error(result?.message ?? '本机模型服务暂时不可用。'), { status: response.status });
  }
  return result;
}

function jpeg(source, width, height, x = 0, y = 0) {
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .82);
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

function render(result) {
  $('ai-summary').textContent = result.feedback || result.summary;
  $('ai-observations').replaceChildren(...result.observations.map(item => node('li', `${item.name} · ${item.location}`)));
  $('ai-steps').replaceChildren(...result.steps.map(step => node('li', step)));
  $('ai-targets').replaceChildren(...result.targets.map(target => {
    const card = node('div');
    card.className = 'ai-target';
    const visual = node('div');
    visual.className = 'ai-target-grid';
    visual.setAttribute('aria-hidden', 'true');
    visual.replaceChildren(...GRID_NAMES.map((name, index) => {
      const cell = node('span');
      cell.title = name;
      cell.classList.toggle('filled', target.cells.includes(index));
      return cell;
    }));
    const label = node('div');
    const positions = gridLabel(target.cells);
    const names = target.cells.map(index => GRID_NAMES[index]).join('、');
    label.append(node('strong', `${target.name} · ${positions}`), node('small', names), node('p', target.advice));
    card.append(visual, label);
    return card;
  }));
  const document = result.controlPlan;
  if (result.feedback || document) $('analysis-tools').open = true;
  $('ai-control-plan').hidden = !document;
  $('ai-plan-json').textContent = document ? JSON.stringify(document.plan, null, 2) : '';
  if (document) {
    $('ai-plan-download').href = document.downloadUrl;
    $('ai-plan-download').download = document.fileName;
  } else {
    $('ai-plan-download').removeAttribute('href');
  }
  $('ai-result').hidden = false;
}

export function isAiCommand(text, commandType) {
  if (commandType === 'STOP' || commandType === 'GUIDE_DONE') return false;
  if (/^(?:请)?(?:AI\b|问模型|请模型|让模型)/i.test(text.trim())) return true;
  if (/^(?:请)?(?:分析|看看|看一下|识别|对照|模仿).*(?:画面|取景|背景|构图|参考图|示例图|这张图)/.test(text)) return true;
  if (commandType !== 'CLARIFY') return false;
  return /背景|参考图|示例图/.test(text) || /(?:让|把|将)[^，。；]+(?:在|放到|放在|移到|安排到)[^，。；]*[格分]/.test(text);
}

function needsImage(text) {
  return /画面|当前取景|背景|参考图|示例图|这张图|我的(?:姿势|表情|站位|动作)|帮我看|给我动作建议/.test(text);
}

export function setupAi(getScene, onAdvice) {
  const connectionStatus = $('ai-connection-status');
  const status = $('ai-status');
  const tools = $('analysis-tools');
  let connection = null;
  let changingConnection = false;
  let reference = '';
  let referenceVersion = 0;
  let loadingReference = false;
  let pending = null;
  let sceneVersion = 0;
  let resultUsesScene = false;
  let expiryTimer;

  function updateConnection(result) {
    connection = result.connected ? result : null;
    clearTimeout(expiryTimer);
    $('ai-disconnect').hidden = !connection;
    $('ai-model-status').textContent = connection ? `模型已连接 · ${connection.model}（${connection.host}）` : '';
    $('ai-model-status').hidden = !connection;
    $('settings-model-status').textContent = connection ? `${connection.model} · ${connection.host}` : '基础指令仍可使用。';
    $('settings-connection-badge').textContent = connection ? '已连接' : '未连接';
    $('settings-connection-badge').dataset.connected = String(Boolean(connection));
    $('assistant-privacy').hidden = !connection;
    connectionStatus.textContent = connection
      ? `已连接 ${connection.host}，密钥由本机临时保管，有效至 ${new Date(connection.expiresAt).toLocaleTimeString('zh-CN')}；输入框留空即可继续使用。`
      : '模型未连接。';
    if (connection) expiryTimer = setTimeout(() => {
      cancel('模型连接已过期，请重新连接。');
      updateConnection({ connected: false });
    }, Math.max(0, Date.parse(connection.expiresAt) - Date.now()));
  }

  function setChanging(value) {
    changingConnection = value;
    $('ai-connect').disabled = value;
    $('ai-disconnect').disabled = value;
    for (const id of ['llm-profile', 'ai-provider', 'ai-base-url', 'ai-model', 'ai-key', 'reset-preferences']) $(id).disabled = value;
  }

  function updateAnalyze() {
    $('ai-analyze').disabled = !!pending || loadingReference;
    $('ai-analyze').textContent = reference ? '对照参考图分析' : '分析当前画面';
  }

  function cancel(message) {
    if (!pending) return;
    const active = pending;
    pending = null;
    active.controller.abort();
    if (!active.localRequest) status.textContent = message;
    updateAnalyze();
  }

  async function refreshConnection() {
    if (changingConnection) return;
    setChanging(true);
    try { updateConnection(await request('session')); }
    catch (error) { connectionStatus.textContent = error.message; }
    finally { setChanging(false); }
  }

  function clearKey() { $('ai-key').value = ''; }

  $('ai-connect-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (changingConnection) return;
    setChanging(true);
    cancel('已取消显示上一次分析，请在连接后重新分析。');
    $('ai-result').hidden = true;
    status.textContent = '';
    connectionStatus.textContent = '密钥已提交并清空输入框，正在用测试图片验证模型…';
    const details = { baseUrl: $('ai-base-url').value, model: $('ai-model').value, apiKey: $('ai-key').value };
    try {
      const result = request('session', 'POST', details);
      clearKey();
      details.apiKey = '';
      updateConnection(await result);
    } catch (error) {
      connectionStatus.textContent = error.message + ' 本次密钥输入已清空，请重新填写后重试。' + (connection ? ' 上一次连接仍然可用。' : '');
    } finally { setChanging(false); }
  });
  $('ai-disconnect').addEventListener('click', async () => {
    if (changingConnection) return;
    setChanging(true);
    clearKey();
    cancel('已取消显示上一次分析。');
    $('ai-result').hidden = true;
    try {
      updateConnection(await request('session', 'DELETE'));
      status.textContent = '已断开模型连接。';
    } catch (error) { connectionStatus.textContent = error.message; }
    finally { setChanging(false); }
  });

  function setReference(data, filename = '') {
    reference = data;
    const thumbnail = $('ai-thumbnail');
    if (data) thumbnail.src = data;
    else thumbnail.removeAttribute('src');
    thumbnail.hidden = !data;
    const name = $('ai-reference-name');
    name.textContent = filename;
    name.title = filename;
    name.hidden = !data;
    $('ai-reference-action').textContent = data ? '更换参考图' : '选择参考图';
    $('ai-remove-reference').hidden = !data;
    $('ai-result').hidden = true;
    updateAnalyze();
  }

  $('ai-reference-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const version = ++referenceVersion;
    cancel('');
    setReference('');
    loadingReference = true;
    updateAnalyze();
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > MAX_REFERENCE_BYTES) {
        throw new Error('请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片。');
      }
      const image = await createImageBitmap(file).catch(() => { throw new Error('参考图无法打开，请换一张图片。'); });
      try {
        if (version !== referenceVersion) return;
        setReference(jpeg(image, image.width, image.height), file.name);
        status.textContent = '已选择参考图。';
      } finally { image.close(); }
    } catch (error) {
      if (version === referenceVersion) {
        event.target.value = '';
        status.textContent = error.message;
      }
    } finally {
      if (version === referenceVersion) {
        loadingReference = false;
        updateAnalyze();
      }
    }
  });
  $('ai-remove-reference').addEventListener('click', () => {
    referenceVersion++;
    cancel('');
    loadingReference = false;
    $('ai-reference-file').value = '';
    setReference('');
    status.textContent = '已移除参考图。';
  });

  async function analyze(prompt, { assistant = false, pose = false, localRequest = false } = {}) {
    if (!assistant || pose) tools.open = true;
    if (pending) cancel('正在处理最新一条指令…');
    const withImage = !localRequest && (!assistant || pose || needsImage(prompt));
    if ((withImage && loadingReference) || changingConnection) {
      status.textContent = '请等待当前操作完成，再请求分析。';
      return;
    }
    if (!connection) {
      status.textContent = '看图分析需要先到「设置」连接模型。语音和文字的基础指令仍可使用。';
      return;
    }
    const source = withImage ? getScene() : null;
    if (!source && !assistant) {
      status.textContent = '请先点「开启电脑摄像头」，等画面出现后再分析。';
      return;
    }
    const active = { controller: new AbortController(), localRequest, sceneOnly: !assistant || pose };
    const initialSceneVersion = sceneVersion;
    pending = active;
    updateAnalyze();
    $('ai-result').hidden = true;
    status.textContent = localRequest ? '' : source ? (reference ? '正在对照当前画面和参考图…' : '正在分析当前画面…') : '模型正在理解你的输入…';
    const capturedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    try {
      const scene = source ? jpeg(source.source, source.width, source.height, source.x, source.y) : null;
      const result = await request('analyze', 'POST', {
        connectionId: connection.id, prompt, ...(assistant && { mode: 'assistant' }),
        ...(scene && { scene, ...(reference && { reference }) }),
      }, active.controller.signal);
      if (pending !== active) return;
      pending = null;
      updateAnalyze();
      if (localRequest && !result.feedback && !result.controlPlan) return;
      const cropChanged = initialSceneVersion !== sceneVersion;
      const sceneChanged = Boolean(source) && cropChanged;
      const confirmation = onAdvice(result, { pose: pose && Boolean(source), applySettings: assistant && !localRequest, cropChanged, sceneChanged });
      if (!sceneChanged || confirmation) {
        resultUsesScene = Boolean(source) && !sceneChanged && !result.settings;
        const reply = sceneChanged ? { summary: confirmation, steps: [], observations: [], targets: [] } : result;
        render(confirmation ? { ...reply, summary: confirmation } : reply);
      }
      status.textContent = sceneChanged ? '画幅已变化，可以按当前画幅重新分析。' : source ? `取景时间 ${capturedAt}。` : '';
    } catch (error) {
      if (pending !== active) return;
      if (error.status === 409) updateConnection({ connected: false });
      if (!localRequest) status.textContent = `摄影模型 LLM：${error.message}`;
    } finally {
      if (pending === active) {
        pending = null;
        updateAnalyze();
      }
    }
  }

  $('ai-analyze').addEventListener('click', () => analyze($('command-input').value.trim()));
  refreshConnection();
  return {
    cancel,
    clearKey,
    refreshConnection,
    get connected() { return Boolean(connection); },
    get pending() { return Boolean(pending && !pending.localRequest); },
    invalidateScene() {
      sceneVersion++;
      const message = '裁剪画幅已变化，可以重新分析。';
      if (pending?.sceneOnly) cancel(message);
      if (resultUsesScene && !$('ai-result').hidden) {
        $('ai-result').hidden = true;
        status.textContent = message;
      }
    },
    command: analyze,
  };
}
