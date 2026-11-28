# 接口约定 V0.2

当前已实现设备接口与下文的 AI 接口，均由 Spring Boot 提供。设备状态显式返回 `mode: "MOCK"`，不会连接真实硬件。AI 的 `MOCK/LIVE` 模式与设备模拟模式独立；AI 使用 LIVE 不代表设备是真实硬件。

## 已实现的设备接口

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/device/status` | 无 | 查询模拟状态 |
| POST | `/api/device/move` | `{"direction":"LEFT","step":1}` | 二维上下左右微调，三维转向、平移、升降和俯仰 |
| POST | `/api/device/home` | `{}` | 模拟回初始位，同时解除停止锁定 |
| POST | `/api/device/stop` | `{}` | 独立停止入口，后续 move 返回 409 |
| GET | `/api/device/calibration` | 无 | 查询拍摄前校准要求和就绪状态 |
| POST | `/api/device/calibration/start` | `{}` | 记录旧文件状态，开启手动校准任务 |
| POST | `/api/device/calibration/verify` | `{}` | 核验本次新生成的六轴文件 |

校准接口返回 `required`、`ready`、`phase`、`message` 和供本机操作的 `command`。默认 `DISABLED`，开启后进入 `REQUIRED`、`PENDING`、`VERIFIED`，缺少配置时为 `UNCONFIGURED`。新增的 `revision` 是已核验文件的标记，其余状态下为空。页面用它关联当前页面的中立位确认，并在快门和倒计时结束时复查。启用选项见 README。所有校准接口均只处理任务状态和文件。串口由操作员运行的独立脚本访问。

`wristCamera` 提供腕部 USB 摄像头的配置名称，空字符串沿用普通取景。配置后，浏览器仅使用指定设备的媒体流供预览、分析与拍照。

当 `LENSMIND_DEVICE_BACKEND=so101` 时，状态返回 `mode: "SO101"`，状态值为 `UNARMED`、`IDLE`、`MOVING`、`STOPPING`、`STOPPED` 或 `FAULT`。校准核验和腕部设备配置完成后，本地页面通过 `POST /api/device/arm` 申请接管，控制端核验当前姿态接近采样中立位并确认舵机保持力。移动只接受 `{"direction":"LEFT","step":1,"source":"voice"}` 或 `RIGHT`。一步为 6 个编码器刻度。控制端拒绝超出示范区间、未接管或正在移动时提交的请求。停止保持当前位置并锁定语音移动。仿真接口调用兼容原字段。

`STOPPED` 时，操作员可通过 `POST /api/device/arm` 明确恢复。仍由舵机稳定保持时，控制端核对当前位置、目标、扭矩和工作范围，只解除指令锁定。舵机卸力时，需托稳并确认采样中立位后按首次接管流程恢复。采样不稳返回 409，允许重试。

实机工作范围仍受左右转向示范端点与每个舵机的校准限位约束。肩部俯仰、肘、腕和夹爪可相对采样中立位偏差 ±24 编码器刻度。超出时返回偏差最大的关节及其刻度值。控制端接管时保持现场确认的当前姿态。

首次接管时，底座朝向允许偏离采样中立位 ±12 编码器刻度。超出时按现场采样的左右符号提示手动修正方向和角度。

网页「取消实机操控」沿用 `POST /api/device/stop`，同时关闭本页语音监听并清除中立位确认。控制端确认停稳后保持当前机位，重新接管仍需确认。

实机状态的 `torqueHeld` 表示已知的扭矩保持状态。故障时为 `null`。本机操作员确认已托稳后可发起 `POST /api/device/release`，请求体须为 JSON `{"supported":true}`。实机端仅在 `STOPPED` 且运动反馈确认静止时解除扭矩。成功后确认六轴卸力，返回 `STOPPED` 与 `torqueHeld: false`。关闭网页只请求停止。

实机批量反馈不可用时，控制端在同一连接中改用逐轴读取该寄存器。逐轴读取也失败时，控制端保持故障锁定并返回具体寄存器或姿态原因。

响应示例：

```json
{
  "mode": "MOCK",
  "connected": true,
  "state": "IDLE",
  "x": 0,
  "y": 0,
  "message": "模拟控制服务就绪，真实机械臂未接入",
  "frame": {
    "id": "cf3ef4d3-e7e2-4124-83df-9e8241446a23",
    "timestamp": "2026-11-25T08:00:00Z",
    "width": 1200,
    "height": 800,
    "src": "data:image/svg+xml;base64,<画面数据>"
  }
}
```

- 默认二维模式的 `state` 为 `IDLE` 或 `STOPPED`，`x/y` 是范围 [-20, 20] 的模拟坐标。三维模式范围和单位见下文。
- 二维模式的 `direction` 为 `LEFT`、`RIGHT`、`UP`、`DOWN`，按未镜像预览画面表达。`step` 必填，整数 1～5，前端固定使用 1。
- 参数无效返回 400；越界、停止后移动返回 409。失败不改变位置。采用 Spring Boot 标准错误响应，前端显示 `message`，兼容 `detail`。
- 二维模拟操作同步完成。两种模式都在停止后锁定移动，回初始位恢复。真实运动必须在控制端实现限位、速度校验、状态机、队列取消和硬件停止。
- 当前状态全局共享：同一个服务的多个标签页会看到相同的模拟设备坐标。
- 默认绑定 `127.0.0.1`，未做认证/CORS；当前仅用于本地开发。若未来对外部署，需要先设计设备控制权限。

### 模拟相机原始帧

- 四个设备接口的成功响应都包含可直接使用的 `frame`。机位与帧来自同一次设备快照，原有路径、请求参数和状态字段继续兼容。调用方可用 `GET /api/device/status` 读取当前原始帧，或直接使用微调响应中的新帧。
- `frame.src` 是完整的图片 Data URL，二维模拟为 SVG，三维腕部视角为 PNG。网页可直接用作图片源，后端可解码逗号后的 Base64 数据。画面为 1200 × 800，未镜像，原点在左上角，像素横向向右、纵向向下。二维模拟向左一格时，固定场景在图像里向右偏移 3 像素。
- `frame.id` 是帧 UUID，`frame.timestamp` 是帧生成时的 UTC ISO 8601 时间。机位变动时生成新帧。状态查询、停止和被拒绝的移动都保留原帧。回初始位实际改变坐标时生成新帧。
- 模拟预览使用原始帧绘制画布，拍照保存同一画布的像素。辅助线、裁剪框和界面提示为网页独立图层。电脑摄像头模式继续使用本地视频画面。

### SO-101 三维仿真

- 设置 `LENSMIND_DEVICE_BACKEND=mujoco` 后，Spring Boot 将原有路径转发到本机 MuJoCo 服务。成功响应继续使用 `mode: "MOCK"`。三维响应的 `so101` 包含底座关节角度 `shoulderPanDegrees`、镜头转向角 `cameraYawDegrees`（左为正）、镜头俯仰 `cameraPitchDegrees`（上仰为正）、相对初始位前后位移 `cameraTravelMillimeters`（靠近为正）、相对初始位高度 `cameraElevationMillimeters`（升高为正）、镜头中心的世界坐标 `cameraPositionMeters`（米，XYZ）和外部视角 `armView`（480 × 320 JPEG Data URL）。
- `POST /api/device/move` 的 `step` 为 1～5 的整数。`LEFT`、`RIGHT` 每步转向 1°，允许左右各 20°。`FORWARD`、`BACKWARD` 每步沿镜头的水平朝向移动 5 mm，允许前后各 40 mm。`UP`、`DOWN` 每步沿世界坐标 Z 轴移动 5 mm，允许升降各 30 mm。`PITCH_UP`、`PITCH_DOWN` 每步抬头或低头 1°，允许各 10°，求解时维持镜头中心和偏航角。转向保留俯仰、前后位移和高度，平移维持镜头偏航和俯仰。原有 `x` 仍表示模拟底座关节角度，`y` 保持 0。无效方向返回 400，越界或无法达到组合目标返回 409 并保留当前帧。
- 动作提交时同时更新机位、腕部原始帧和外部视角。正在生成画面时可查询到 `MOVING` 和上一次已提交的机位。停止可立即锁定该机位，丢弃尚未提交的帧和机位并拒绝后续移动（409）。服务没有待执行动作队列。回初始位恢复模型零位。
- MuJoCo 断连或超时返回 503，渲染失败返回 502。网页依据错误暂停操作和拍摄。

## 人物检测接口

`POST /api/vision/person?frameId=1&timestamp=1795400000000` 接收单张 `Content-Type: image/jpeg` 的未镜像画面。帧号从 1 递增，时间戳为摄像头采样时的 Unix 毫秒。最长边 640 像素，单帧最大 256 KiB。网页在开启摄像头时最多约每 250 毫秒采样一次，而且每次等待上一帧完成。

```json
{
  "frameId": 1,
  "timestamp": 1795400000000,
  "width": 480,
  "height": 320,
  "person": { "x": 0.21, "y": 0.10, "width": 0.22, "height": 0.78, "confidence": 0.93 },
  "people": [
    { "x": 0.21, "y": 0.10, "width": 0.22, "height": 0.78, "confidence": 0.93 },
    { "x": 0.62, "y": 0.15, "width": 0.20, "height": 0.73, "confidence": 0.89 }
  ]
}
```

`width/height` 为请求图像的像素尺寸，人物框原点在左上角，`x/y/width/height` 对原始画面宽高分别归一化到 0～1。`people` 含最多 8 个置信度至少 0.45 的框，按置信度降序返回。原有 `person` 字段仍返回置信度最高的框。无人时返回 `people: []` 和 `person: null`。参数或 JPEG 无效返回 400，文件过大返回 413，视觉服务正忙返回 429，模型缺失或加载/推理失败返回 503。图像帧仅保留在请求内存中。

请求附加 `head=true` 时，同一帧额外返回 `faces: [{ "x": 0.75, "y": 0.73, "width": 0.11, "height": 0.1, "confidence": 0.9 }]`。`faces` 使用相同的归一化坐标，通过本机 YuNet 检测最多 8 个可见脸框。`[]` 表示未检测到脸，`null` 表示未请求或该帧的脸部定位不可用。旧调用方可继续使用原有 `person` 和 `people` 字段。

请求附加 `pose=true` 时，响应的 `poses` 与 `people` 下标一一对应。每项为 `{ "nose": {"x": 0.5, "y": 0.2}, "leftHip": {...} }` 形式的映射，键为鼻尖、左右肩、胯、膝、踝、跟和足尖，坐标归一化到原始画面。置信不足的点省略，`{}` 表示该框没有确认的点，`null` 表示未请求或姿态模型暂不可用。旧调用方可继续忽略该字段。姿态推理在本机完成。

## 摄影模型接口

这些端点只接受来自本机工作台的请求。使用 HTTPS 调用 OpenAI 兼容的 Chat Completions 接口，模型需支持文字和图片输入。默认允许的基础地址如下，模型名称以该服务商提供的视觉模型为准。

| 服务商 | API 基础地址 |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| 硅基流动 | `https://api.siliconflow.cn/v1` |
| 阿里云百炼（中国内地） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 上海交通大学「致远一号」 | `https://models.sjtu.edu.cn/api/v1` |

使用「致远一号」时，按学校指南填写支持图片输入的模型调用名 `qwen`，并在校园网或交大 VPN 下连接。[交我算 API 使用文档](https://apps.hpc.sjtu.edu.cn/posts/claw-guide-sjtu-api)

本机部署者可使用 `LENSMIND_AI_ALLOWED_HOSTS` 覆盖默认列表，填写逗号分隔的可信域名。只接受精确域名，禁用上游重定向。使用 Windows 浏览器输入密钥时，通过本机工作台窗口提交。密钥仅存在本机服务的内存会话中，断开连接、服务重启或 30 分钟有效期结束后需重新填写。

| 方法与路径 | 输入 | 成功结果 |
| --- | --- | --- |
| `GET /api/ai/session` | 无 | `{ "connected": false }` 或连接状态、`id`、`model`、`host`、`expiresAt` |
| `POST /api/ai/session` | JSON，必填 `baseUrl`、`model`、`apiKey` | 用生成的色块测试视觉接口后返回连接状态和标识，密钥不在响应中 |
| `DELETE /api/ai/session` | 无 | `{ "connected": false }`，清除服务端会话 |
| `POST /api/ai/analyze` | JSON，必填 `connectionId`、`scene`，可选 `prompt`、`reference` | `summary`、`observations`、`targets`、`steps` |
| `POST /api/ai/analyze`（`mode: "assistant"`） | 必填 `connectionId` 和非空 `prompt`，看图时可附 `scene` 与可选 `reference` | 同上，另可含 `settings` |

`settings` 可包括 `framing`（`half/full/any`）、`composition`（`left/center/right`）、`cells`（格号数组）、`part: "head"`、`zoom`（`in/out`）和可选的 `ratio`（`original/1:1/4:3/3:4/16:9/9:16`，原有调用兼容）。仅对应用户明确要求的画面设置。常用且明确的目标、景别、比例和放大缩小由页面直接应用，模型回传的设置不会覆盖它们。等待模型时手动调整了裁剪框，较晚返回的比例和缩放也不会覆盖手调结果。快门、停止、机位等操作由前端处理。纯文字请求不需要摄像头，已连接的模型收到的是最终转写文字或用户提交的文字。

`connectionId` 对应当前连接状态的 `id`。`scene` 是当前裁剪框内未镜像的摄像头快照，`reference` 是可选参考图。两者采用 `data:image/jpeg;base64,` 编码，每张编码后最多 120 万字符。网页接受不超过 10 MB 的 JPG、PNG、WebP 参考图，缩放到最长边 1024 像素后转成 JPEG。`prompt` 最多 500 字符，省略时分析整个裁剪画幅，有参考图时对照两张图。图片仅在主动请求时交给配置的服务商，项目不写入磁盘。

```json
{
  "summary": "人物可稍向画面右侧站，树需要调整取景以移入左上区域。",
  "observations": [{ "name": "树", "location": "画面中央偏左" }],
  "targets": [
    { "name": "树", "cells": [0, 1, 3, 4], "advice": "调整镜头取景，让树冠进入左上区域。" },
    { "name": "人物", "cells": [4, 5, 7, 8], "advice": "向画面右侧挪一步。" }
  ],
  "steps": ["先调整取景，再请人物确认站位。"]
}
```

`cells` 是期望区域，按画面从左上到右下逐行编号 0～8。当前观测位置用 `observations` 单独表示。返回建议用于展示和可选的浏览器朗读，不调用控制端或触发拍照。摄影助手的文字、语音和分析按钮共用一个输入。连接模型并开启摄像头后，主动发出的看图或动作建议请求使用此接口，自动构图播报仍使用本机的 `/api/vision/person`。停止、关闭相机或切换参考图时页面会丢弃待返回的建议。已发送给服务商的请求仍可能处理完成。现有本机人物检测、拍摄和设备接口保持兼容。

错误返回 `{ "message": "…" }`，其中 400 表示输入无效或域名未启用，403 表示来源不符合本机要求，409 表示会话过期或连接已变更，413 表示请求过大，415 表示非 JSON 请求，502 表示服务商拒绝请求或响应无效，503 表示额度或限流，504 表示超时。错误不会把服务商原始响应透传到浏览器。

## 前端模块接口

`commands.js` 的 `parseCommand(text)` 接收文字或已转写的中文语音，返回 `STOP/HOME/CAPTURE/RETAKE/MOVE/CAMERA_DISTANCE/GUIDE/ZOOM/COMPOSE/CLARIFY`。例如「居中的半身照」返回 `{ "type": "COMPOSE", "composition": "center", "framing": "half" }`。「相机靠近一点」返回 `{ "type": "CAMERA_DISTANCE", "direction": "NEARER" }`，当前界面显示意图提示。 `CLARIFY` 的 `message` 用于追问。

「选择人物2」返回 `{ "type": "SELECT_PERSON", "id": 2 }`。「人物1左三分，人物2右三分」返回 `{ "type": "POSITION_PEOPLE", "targets": [{ "id": 1, "composition": "left" }, { "id": 2, "composition": "right" }] }`。一次指令的全部目标编号可见时才更新位置。

「人物1左下四格，人物2中上一格」返回 `{ "type": "POSITION_PEOPLE", "targets": [{ "id": 1, "cells": [3, 4, 6, 7] }, { "id": 2, "cells": [1] }] }`。格号按画面从左上到右下逐行以 0～8 编码，语音里的「第1格」对应索引 0。「中上一格」返回 `{ "type": "POSITION_SELECTED", "cells": [1] }`，适用于当前选中的人物。「让人物的头在右下角」返回 `{ "type": "POSITION_HEAD", "part": "head", "cells": [8] }`。有编号时在相应 `targets` 项加 `"part": "head"`。「清除头部目标」返回 `CLEAR_HEAD_TARGET`。左右、上下均以未镜像取景画面为准。

「我需要拍一张人物在右下四格的半身照」返回 `{ "type": "POSITION_BODY", "cells": [4, 5, 7, 8], "framing": "half" }`，同时应用人物目标与裁剪景别。独立的「拍摄」返回 `CAPTURE` 并进入原有拍摄流程。免按键模式会在播报时暂停识别，播报结束后恢复监听，快门只响应明确的拍摄指令。

「我要拍一张左下四格的照片」返回 `{ "type": "POSITION_BODY", "cells": [3, 4, 6, 7] }`。「一比一画幅」返回 `{ "type": "RATIO", "ratio": "1:1" }`。比例和目标可在一句话内设置，例如「1:1，让人物的头在右上角」。目标和景别的设置不会改变裁剪中心或缩放倍数。开启麦克风后，实时构图朗读在用户提交构图要求后才启用。

`vision.js` 的 `createVisionTracker().update(frame, target)` 接收检测接口结果及 `{ composition, framing }`，输出帧号、时间戳、人物框、`detected`、`position`（中心坐标）、`occupancy`（人物框面积占比）、`stable`、构图文字和可选 `adjustment`。调整意图的 `type` 有 `SUBJECT_LEFT`、`SUBJECT_RIGHT`、`ENLARGE_SUBJECT`、`ADD_MARGIN`，幅度为 `SMALL`，方向以画面为准。网页仅显示建议。连续至少 1 秒的有效人物框用于估算稳定性。状态 `empty` 表示尚未检测到过人物，`lost` 表示先前检测到的人离开。设备 REST 接口保持原有调用方式。

跟踪器将逐帧检测列表转换为 `people: [{ id, person, position, occupancy, stable }]`，同时返回短暂看不清的编号列表 `occluded`。先去掉高度重叠框，再进行一对一位置匹配，新人物连续至少 3 帧、且持续至少 400 毫秒后才分配编号。旧轨迹保留约 4 秒，构图目标通过 `target.pinnedIds.has(id)` 保留编号，闲置编号在 1～8 内回收。服务器视觉响应和设备 REST 调用保持兼容。

拍摄启动时使用不超过 1.5 秒的检测结果。`framing: "half"` 检查头顶到腰胯及裁剪框下缘，`full` 检查头顶到双脚，`any` 不检查景别。取景和语音使用相同的景别门槛。构图辅助还把人物框换算至当前裁剪框，人物整体目标按可见面积与目标区域交集超过 50% 判断。多个选中的九宫格合并为目标区，居中或三分预设的目标区为参考线两侧各 1/6 画幅宽度的竖条。没有独立目标的多人取景按框内可见的人物检测面积合计判断。

头部目标按脸框中心在裁剪框中的位置判断，脸部中心在框外时不满足。单人无编号时可直接使用框内唯一的脸框，画面里只有脸也可满足目标。为编号设置头部目标时，用同帧原始人物框与脸框关联，多人重叠且无法可靠关联时提示调整。`stable` 供界面提示。倒计时启动后，人物位置和视觉服务的变化不影响到点取景，停止、摄像头断开和控制端异常仍可取消。

「手动拍摄」沿用景别、倒计时、设备状态检查和裁剪流程，可由用户自行判断人物位置。切换到选片页或首页会关闭电脑摄像头、取消倒计时和待处理的取景任务。设备、视觉和模型原有 REST 请求保持兼容。

`crop.js` 的裁剪配置：

```json
{ "ratio": "3:4", "zoom": 1.15, "cx": 0.5, "cy": 0.48 }
```

`cx/cy` 是原图归一化中心，`zoom` 当前为 1～2.5，裁剪矩形会限制在原图范围。`cropRect` 计算像素矩形，取景、九宫格、目标和成片从同一矩形生成。「原比例」使用相机取景的比例。拖动裁剪角时固定对角并保持比例。`renderCrop` 可绘制到新的画布或复用传入的预览画布，预览与下载共用裁剪计算。原图 canvas 独立保留。「本次拍摄」显示已保存成片。「调整裁剪」用单独草稿生成实时预览，点「保存裁剪」更新本页成片并切换到成片视图。「查看原片」显示原图。只有点下载才在浏览器生成 JPEG 文件，照片不经服务端保存。

## AI 接口（已实现，组长模块）

本节接口供独立调用和后续页面联调。工作台侧「摄影助手」使用前文的临时模型会话接口。

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

「放大一点」使用数字裁剪。「相机靠近一点」在三维仿真中触发镜头前移。实机前后移动仍需独立的空间规划和标定。
