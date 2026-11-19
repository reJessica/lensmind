// C 成员：设备通信统一入口。未来可在此接 WebSocket 状态推送。
async function request(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`/api/device/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || data.detail || `请求失败（${response.status}）`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('控制服务响应超时，请检查连接');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const deviceApi = {
  status: () => request('status'),
  move: (direction, step = 1) => request('move', { direction, step }),
  home: () => request('home', {}),
  stop: () => request('stop', {}),
};
