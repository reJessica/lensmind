# 接口约定 V0.2

下列设备接口为同源 JSON REST API。所有设备状态都显式返回 `mode: "MOCK"`。`connected: true` 表示模拟器可用。

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
- 拍摄页的「停止」先取消页面倒计时并调用 `/api/device/stop`，仅当返回 `MOCK` 和 `STOPPED` 时才自动调用 `/api/device/home`。复位返回已连接、`IDLE` 且坐标清零后，网页恢复快门。直接调用停止接口仍会保持停止锁定。
- 当前状态全局共享：同一个服务的多个标签页会看到相同的模拟设备坐标。
- 默认绑定 `127.0.0.1`，未做认证/CORS；当前仅用于本地开发。若未来对外部署，需要先设计设备控制权限。

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

## 待共同确定（尚未实现的接口）

不要按以下内容直接调用 API；这是下一阶段讨论输入。

1. **图像源：** 末端摄像头采用 MJPEG、WebRTC 还是其他传输；提供图像分辨率、时间戳、未镜像方向和相机标定。
2. **视觉数据扩展：** 当前本地人物框已带帧号、时间戳和置信度。团队后端仍需约定关键点、自动判断动作完成及跨服务的帧时效。
3. **构图请求：** 构图目标、半身/全身、采用机位还是裁剪、任务 ID；每次小步移动后使用新帧验证。
4. **设备状态：** `MOVING/IDLE/STOPPED/DISCONNECTED/OUT_OF_RANGE`、当前任务 ID、错误、实际停止确认；停止直达控制端，取消当前与排队任务。
5. **拍摄流程：** 控制端停止确认 + 人物稳定判断 → 倒计时；明显移动、目标丢失、断连时取消；拍摄使用明确时间戳的相机原帧。
6. **人物指导：** 一次一条，带完成判断；指导期间保持机械臂静止。方向按被摄者自身左右。
7. **图片管理：** 若需服务端存储，约定原片/成片 ID、原图不可覆盖、下载接口、删除与保留期限。

“放大一点”默认数字裁剪；“相机靠近一点”需要后续真实空间规划，目前会明确提示未支持。不要将预览画面方向直接等同于某个舵机关节方向。
