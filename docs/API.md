# 接口约定 V0.2

当前已实现设备接口与下文的 AI 接口，均由 Spring Boot 提供。设备状态显式返回 `mode: "MOCK"`，不会连接真实硬件。AI 的 `MOCK/LIVE` 模式与设备模拟模式独立；AI 使用 LIVE 不代表设备是真实硬件。

## 已实现的设备接口

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/device/status` | 无 | 查询模拟状态 |
| POST | `/api/device/move` | `{"direction":"LEFT","step":1}` | 上下左右瞬时模拟微调 |
| POST | `/api/device/home` | `{}` | 模拟回初始位，同时解除停止锁定 |
| POST | `/api/device/stop` | `{}` | 独立停止入口，后续 move 返回 409 |

响应示例：

```json
{
  "mode": "MOCK",
  "connected": true,
  "state": "IDLE",
  "x": 0,
  "y": 0,
  "message": "模拟控制服务就绪，真实机械臂未接入"
}
```

- 当前 `state` 仅 `IDLE`、`STOPPED`；`x/y` 是模拟单位，范围 [-20, 20]，不是机械臂关节角度。
- `direction`：`LEFT`、`RIGHT`、`UP`、`DOWN`，按未镜像预览画面表达。`step` 必填，整数 1～5，前端固定使用 1。
- 参数无效返回 400；越界、停止后移动返回 409。失败不改变位置。采用 Spring Boot 标准错误响应，前端显示 `message`，兼容 `detail`。
- 模拟操作是同步、瞬时完成，无待执行队列。停止会锁定后续移动；回初始位恢复。真实运动必须在控制端实现限位、速度校验、状态机、队列取消和硬件停止。
- 当前状态全局共享：同一个服务的多个标签页会看到相同的模拟设备坐标。
- 默认绑定 `127.0.0.1`，未做认证/CORS；当前仅用于本地开发。若未来对外部署，需要先设计设备控制权限。

## 前端模块接口

`commands.js` 的 `parseCommand(text)` 返回 `STOP/HOME/CAPTURE/MOVE/GUIDE/ZOOM/COMPOSE/CLARIFY` 类型；组员一可对接组长提供的后端模型结果，但模型不能直接发关节角或绕过控制端。新增 `ai-client.js` 提供调用封装，现有工作台尚未自动切换到后端模型。

`crop.js` 的裁剪配置：

```json
{ "ratio": "3:4", "zoom": 1.15, "cx": 0.5, "cy": 0.48 }
```

`cx/cy` 是原图归一化中心，`zoom` 当前为 1～2.5，裁剪矩形会限制在原图范围。`cropRect` 计算矩形，`renderCrop` 生成成片，**没有设备接口调用**。原图 canvas 始终独立保留。修改编辑草稿后，点“保存裁剪”更新缩略图；“下载成片”直接导出当前草稿。

## AI 接口（已实现，组长模块）

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/ai/status` | 无 | 模式、模型配置是否齐全、进程调用次数与上限；不返回密钥 |
| POST | `/api/ai/command` | JSON：`text`，可选 `composition` / `framing` | 结构化指令意图，不执行动作 |
| POST | `/api/ai/vision` | multipart：`image`、`frameId`、`capturedAt`、`composition`、`framing` | 单帧人物/构图分析、一条指导 |
| POST | `/api/ai/asr` | multipart：`audio` | 录音转写文字，不执行指令 |
| POST | `/api/ai/tts` | JSON：`text`（1～160 字符） | WAV/MP3 音频流 |

默认 `MOCK` 不访问外部模型；设置 `LENSMIND_AI_MODE=LIVE` 后才会调用配置的服务。

**真实验证状态：** `qwen3.5-27b` 已通过文字解析与 CC0 测试人像分析；ASR/TTS 已实现协议适配和本机假服务测试。2026-11-20 已确认当前平台文档列有语音接口，但现有 Key 调用 `tts-1`、`gpt-4o-mini-tts`、`whisper-1` 均返回 HTTP 503 / `model_not_found`（default 分组无可用通道）。需要提供方确认可用分组/通道，不一定需要另外的语音平台。

随后新增 UniAPI 语音平台：独立密钥鉴权/模型列表成功，`whisper-1` 已通过本后端真实中文 WAV 转写验证；`tts-1` 与 `gpt-4o-mini-tts` 的短句合成均提示上游满载，尚未真实合成成功。上段 503 仅指旧汇云平台，不代表 UniAPI 不支持语音。

### 通用 JSON 响应

```json
{
  "requestId": "唯一请求ID",
  "mode": "LIVE",
  "source": "MODEL",
  "model": "qwen3.5-27b",
  "promptVersion": "lensmind-v1",
  "data": {},
  "warnings": ["结果只作建议，不执行设备动作"]
}
```

- `mode` 是本模块配置的 `MOCK/LIVE`；`source` 才表示结果来自 `MOCK` 固定示例、`RULE` 本地规则或 `MODEL` 真实调用。
- 停止/否定等本地规则在 LIVE 下也不调用模型。页面停止必须立即走 `/api/device/stop`，不应等待 AI 接口。
- `status.models.*.configured` 只表示 URL、模型 ID、Key 三项已填写，不证明模型存在、已开通、协议兼容或网络可达。
- JSON 错误包含 `code` 和中文 `message`。错误不会伪装成成功或静默降级为 MOCK。

### 指令

请求：

```json
{"text":"请把人物安排在画面右侧，拍成半身","composition":"center","framing":"full"}
```

`data` 示例：

```json
{"type":"COMPOSE","direction":null,"step":null,"composition":"right","framing":"half","zoomDelta":null,"message":"已理解为右侧半身构图"}
```

- `text` 1～300 字符；`composition`：`center/left/right`；`framing`：`half/full`。不适用字段返回 null。
- `type`：`STOP/HOME/CAPTURE/MOVE/ZOOM/COMPOSE/GUIDE/CLARIFY`。
- MOVE 仅允许 `LEFT/RIGHT/UP/DOWN` 且 `step=1`；需明确机位意图，由控制端再次校验。
- ZOOM 的 `zoomDelta` 非零且绝对值不超过 0.25，仅代表数字放大增量。
- 模型不会调用设备接口，也不会声称实际动作或拍照已经完成。前端仍需处理倒计时、停止、状态锁定等流程。

### 图片与原始帧

- `image`：JPEG/PNG，最大 4 MB；边长最多 4096，总像素最多 1200 万。按字节解码检查，不接受远程 URL 或伪造后缀。
- 后端在内存中重编码为 JPEG、去除元数据、最长边缩至最多 1024，再发送给视觉服务。原始上传文件不保存。
- `frameId`：1～100 字符，原始帧唯一标识；`capturedAt`：ISO-8601 时间；`composition` 与 `framing` 必填。
- `data` 包含原始 `frameId/capturedAt/width/height`、目标构图/景别，以及 `analysis`。
- `analysis.personDetected` 可为 true/false/null；`personBox` 可为 null，否则是整个原图的归一化 `x/y/width/height`（左上角坐标）。它是模型粗略估计，不是精确检测器输出。
- `assessment/suggestion/guidance` 分别是分析、构图建议、一条动作指导；无人时不返回人物动作指导。
- `stability` 固定为 `UNKNOWN`：单帧无法证明站稳。该模块不自动执行机位建议，不负责连续帧稳定性判断。
- 静态图片也可测试，因此接口允许历史时间戳；联调执行动作前，调用方必须核验帧时效、是否已停止/换目标，不能直接执行旧帧的建议。

### 语音

- ASR 首版仅支持 0.1～15 秒、8～48 kHz、16-bit、1～2 声道的 PCM WAV，文件最大 3 MB；推荐 16 kHz 单声道。不能将 WebM 改后缀当 WAV 上传。
- ASR 支持 `asr-protocol=OPENAI_AUDIO`（multipart 上传 WAV，读取 JSON `text`）与 `QWEN_CHAT`（Qwen `chat/completions` 的 `input_audio`）。默认 UniAPI `https://api.uniapi.io/v1/audio/transcriptions`、`whisper-1`、`OPENAI_AUDIO`。
- ASR `data` 为 `{"text":"识别文字","language":"zh"}`；前端显示转写后再请求指令解析，转写本身不执行动作。
- ASR 保留原始转写（可能含繁体），后续 command 接口归一化“相機/鏡頭/別動/縮小”等常见控制词；这不是通用繁简转换器。
- TTS 支持 `OPENAI_AUDIO`（`audio/speech` JSON → 音频）与 `DASHSCOPE`（Qwen 原生 generation → OSS 音频），需配置匹配地址/模型/音色。原生 TTS 下载不附带模型 Key，只接受受限 OSS 域名的 HTTPS 下载。
- TTS 默认 UniAPI `https://api.uniapi.io/v1/audio/speech`、`tts-1`、`alloy` 音色。语音密钥来自独立的 `lensmind.uniapi-key` / `LENSMIND_UNIAPI_KEY`，可被单独 ASR/TTS 密钥配置覆盖，不复用原文字平台 Key。
- TTS 响应头 `X-LensMind-Mode: MOCK/LIVE`、`X-LensMind-Audio: tone-only/speech`；MOCK 只返回提示音，不是语音合成。MOCK ASR 返回固定示例文字，不是真实识别。
- 新增 `ai-client.js` 的 `encodeWav` 可将 Web Audio 单声道 PCM 编码为 WAV；它不采集麦克风，也不重采样。原有浏览器 ASR/TTS 保留供组员一选择接入。

### 成本与限制

- 默认每进程最多尝试 8 次真实模型调用，文字/视觉/ASR/TTS 合计；失败/超时尝试也计数，无自动重试。
- 同时最多 2 次调用；超时默认 60 秒；图片最多 1024 边长，文字模型输出最多 700 tokens，TTS 输入最多 160 字符。
- 这只是调用量控制，不是人民币金额限制；重启会重置计数，多个进程各自计数。实际费用以供应商账单为准。
- `MODEL_NOT_CONFIGURED` → 503；`LIVE_CALL_LIMIT` / `AI_BUSY` → 429；供应商失败或结构化内容无效 → 502；超时 → 504；输入无效 → 400。
- 供应商返回 429 时进一步区分：`PROVIDER_BUSY`（上游满载）、`PROVIDER_QUOTA_EXHAUSTED`（明确提示余额/额度不足）、`PROVIDER_RATE_LIMITED`（其他限流），本地均返回 503，不向前端泄漏供应商原始响应，也不自动重试。

配置、实际样例与组员交接见 [MODEL_HANDOFF.md](MODEL_HANDOFF.md)。

## 待共同确定（尚未实现的联动能力）

不要按以下内容直接调用 API；这是下一阶段讨论输入。

1. **图像源：** 末端摄像头采用 MJPEG、WebRTC 还是其他传输；提供图像分辨率、时间戳、未镜像方向和相机标定。
2. **视觉数据：** 统一归一化人物框、关键点、置信度、目标是否丢失、是否稳定；带 frameId/timestamp，过期结果不得驱动运动。
3. **构图请求：** 构图目标、半身/全身、采用机位还是裁剪、任务 ID；每次小步移动后使用新帧验证。
4. **设备状态：** `MOVING/IDLE/STOPPED/DISCONNECTED/OUT_OF_RANGE`、当前任务 ID、错误、实际停止确认；停止直达控制端，取消当前与排队任务。
5. **拍摄流程：** 控制端停止确认 + 人物稳定判断 → 倒计时；明显移动、目标丢失、断连时取消；拍摄使用明确时间戳的相机原帧。
6. **人物指导：** 一次一条，带完成判断；指导期间保持机械臂静止。方向按被摄者自身左右。
7. **图片管理：** 若需服务端存储，约定原片/成片 ID、原图不可覆盖、下载接口、删除与保留期限。

“放大一点”默认数字裁剪；“相机靠近一点”需要后续真实空间规划，目前会明确提示未支持。不要将预览画面方向直接等同于某个舵机关节方向。
