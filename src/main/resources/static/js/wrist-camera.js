function cameraName(label) {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '').trim().toLowerCase();
}

export async function openWristCamera(devices, expectedLabel) {
  const expected = cameraName(expectedLabel);
  const video = { width: { ideal: 1200 }, height: { ideal: 800 } };
  const cameraList = async () => (await devices.enumerateDevices()).filter(device => device.kind === 'videoinput');
  const exactCamera = cameras => {
    const matches = cameras.filter(device => device.deviceId && cameraName(device.label) === expected);
    if (matches.length > 1) throw new Error('检测到多个同名腕部摄像头，请只保留拍摄用的那一只。');
    return matches[0];
  };
  let cameras = await cameraList();
  let selected = exactCamera(cameras);
  if (selected) return devices.getUserMedia({ video: { ...video, deviceId: { exact: selected.deviceId } }, audio: false });
  if (!cameras.some(device => device.label)) {
    // The browser may hide device names until the user grants camera access.
    const permissionStream = await devices.getUserMedia({ video, audio: false });
    let reusePermissionStream = false;
    try {
      cameras = await cameraList();
      selected = exactCamera(cameras);
      const track = permissionStream.getVideoTracks()[0];
      reusePermissionStream = Boolean(track && selected && selected.deviceId === track.getSettings().deviceId &&
        cameraName(track.label) === expected);
      if (reusePermissionStream) return permissionStream;
      if (selected) return await devices.getUserMedia({ video: { ...video, deviceId: { exact: selected.deviceId } }, audio: false });
    } finally {
      if (!reusePermissionStream) permissionStream.getTracks().forEach(track => track.stop());
    }
  }
  throw new Error(`找不到腕部摄像头「${expectedLabel}」，请检查 USB 连接和浏览器摄像头权限。`);
}
