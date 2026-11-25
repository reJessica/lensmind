# 灵眸 LensMind

多模态感知驱动的交互式智能摄影系统。当前仓库为 **V0.2 协作起步框架**，面向室内单人定点人像，使用 Spring Boot 托管原生 Web 前端。

![摄影工作台预览](docs/preview.png)

## 快速开始

需要 **JDK 17 或以上**；仓库自带 Maven Wrapper，无需另装 Maven、Node.js 或数据库。首次运行需要联网下载 Maven 与依赖。

```bash
cd /你的路径/lensmind
./mvnw spring-boot:run
```

Windows 使用 `mvnw.cmd spring-boot:run`。浏览器访问 <http://localhost:8080>。如果提示没有 Java，请安装 JDK 并配置 `JAVA_HOME`，或在 IDE 里选择项目 JDK。

```bash
# 测试、打包
./mvnw test
./mvnw package
java -jar target/lensmind-0.0.1-SNAPSHOT.jar
```

默认仅监听本机。端口可通过 `PORT=8081 ./mvnw spring-boot:run` 修改。摄像头与麦克风需要 localhost 或 HTTPS，以及浏览器授权。不要直接双击 HTML；页面依赖同源 `/api` 接口。

## 当前可以体验

- 摄影工作台：取景、九宫格、裁剪框、设置面板、照片列表与交互记录；支持桌面和移动窄屏。
- 模拟取景：仓库内置 SVG 插画，无外部图片或 CDN 依赖；也可主动授权使用电脑摄像头（不是机械臂末端相机）。
- 数字构图：居中、左右三分、半身/全身示意；比例原比例、1:1、4:3、3:4、16:9、9:16；拖动裁剪框、数字放大。
- 指令入口：文字输入、快捷指令、浏览器语音识别（浏览器支持情况与在线服务可用性会影响识别）。规则解析器支持“居中半身照”“放大一点”“相机向左一点”“动作建议”“拍照”“停止”等。
- 模拟机位：上下左右单步微调、回初始位、停止；接口校验步长和模拟边界。停止后需回初始位再继续移动。
- 人物指导：每次一条预设建议，浏览器可朗读；用户手动确认后才恢复机位操作与拍摄。
- 拍摄：0/3/5 秒倒计时；照片保留原片，支持裁剪编辑、撤销、重拍、分别下载原片/成片。
- 停止：按钮或 Esc 取消倒计时与指导，独立发送 `/api/device/stop`。页面切到后台会取消倒计时。

**演示边界：** 尚未连接真实 SO-101、香橙派和末端摄像头。后端文字/图像模型接口已实现并通过 Qwen3.5-27B 样例验证，现有工作台尚待组员一对接；页面构图选项仍是数字裁剪示意，没有自动视觉控制闭环。人物框是模型粗略估计，不是精确检测器；尚无姿态检测与连续帧站稳判断。模拟坐标不是关节角度或真实距离。

**当前开发方向：** 先完成模型、前端与摄像头/机械臂仿真之间的联动。现有插画和内存坐标模拟器是接口起点，尚不代表已完成三维仿真。真实硬件接入留作后续扩展，不属于组员二当前的必交内容。

照片仅存在当前浏览器标签页内存，最多 12 张，**刷新或关闭页面会丢失**，请先下载。没有数据库、登录或照片持久化存储。AI 分析接口接收的图片/音频只在内存处理；LIVE 下会将请求中的媒体发送给配置的模型供应商。原有工作台尚未自动上传相机画面；浏览器语音识别可能使用浏览器提供方的在线服务。

## 后端模型模块（组长部分）

- `GET /api/ai/status`：查看模式、配置与调用次数，不暴露密钥。
- `POST /api/ai/command`：文字意图解析，只返回结构化建议，不执行设备动作。
- `POST /api/ai/vision`：上传单帧 JPEG/PNG，返回人物位置粗估、构图分析和一条动作指导；稳定性固定为 UNKNOWN。
- `POST /api/ai/asr`：默认接 UniAPI `whisper-1`，真实中文短录音转写已通过；保留 Qwen ASR 可选协议。
- `POST /api/ai/tts`：默认接 UniAPI `tts-1`，后端协议和音频校验已实现；真实合成当前被供应商上游满载阻挡，尚未获得语音。

默认 `MOCK` 完全不访问外部模型；模拟 ASR 是固定文字，模拟 TTS 只是提示音。真实调用请在 Git 已忽略的 `config/ai-local.properties` 中配置密钥，再显式设置 `LENSMIND_AI_MODE=LIVE`。可参考 `config/ai-local.example.properties`，不要覆盖已有本机配置。

当前已验证平台 `https://zgc.apihy.com/v1` 的 `qwen3.5-27b`：文字构图意图和 CC0 头肩人像分析各成功一次；首次 30 秒请求超时后，将超时调整为 60 秒。未做大规模效果评测。

2026-11-20 补查原汇云平台：文档有语音接口，但当前 Key 的 `default` 分组对已测语音模型均返回 503 / `model_not_found`。随后按用户提供的另一个接口接入 UniAPI，独立使用本机 `lensmind.uniapi-key`（或环境变量 `LENSMIND_UNIAPI_KEY`），不会把原文字模型 Key 发给新平台。

[UniAPI 官方音频文档](https://docs.uniapi.ai/docs/use/api/audio)列有 Whisper 与 TTS；当前 Key 可查询到 217 个模型。通过本后端上传 2.78 秒本机系统语音测试录音，`whisper-1` 正确返回“請看向鏡頭,放鬆肩膀。”。ASR 保留原始转写，指令解析会归一化常见繁体控制词。TTS 的 `tts-1` 与 `gpt-4o-mini-tts` 共 4 次短句尝试均返回 429 / `api_limit`，供应商明确提示“当前分组上游负载已饱和”；目前停止测试，没有自动重试或将本地系统语音冒充云端 TTS。

独立复测语音可运行 `python3 scripts/smoke_ai.py --live --speech-only`（需先启动 LIVE 服务，最多 TTS 与 ASR 各一次）；TTS 失败时不会继续转写。完整配置和限制见交接文档。

TTS 备选核查：当前 UniAPI 列表还包含 MiniMax `speech-02-turbo`、`speech-2.6-turbo`，以及 Gemini TTS 等。另用 Gemini `gemini-2.5-flash-preview-tts` 的原生接口尝试一次中文短句，同样返回 429 / 上游满载，未获得音频。MiniMax 尚未真实测试，需先确认 UniAPI 对应调用协议，不能直接把模型 ID 填进现有 OpenAI TTS 配置就认定可用。

默认每进程最多尝试 8 次真实调用，并发 2，无自动重试。调用次数限制不是金额预算，重启会清零，费用以供应商账单为准。浏览器侧新客户端 `js/ai-client.js` 已提供，现有 `app.js` 尚未自动切换。

交接与接入示例见 [docs/MODEL_HANDOFF.md](docs/MODEL_HANDOFF.md)，接口字段见 [docs/API.md](docs/API.md)，测试图片来源见 [docs/samples/ATTRIBUTION.md](docs/samples/ATTRIBUTION.md)。

## 目录与分工

| 人员 | 主要职责 | 对接与交付 |
| --- | --- | --- |
| 组长 | 模型选型、提示词和参数调试、模型后端接入、效果测试 | 通过 Spring Boot 提供文字/图像分析接口，返回指令解析、构图建议、人物指导等结果；具体能力按阶段实现并标注 |
| 组员一 | 前端与整体体验 | 完善取景、语音/文字输入、状态反馈、倒计时、拍照、裁剪与下载；对接模型和仿真接口，完成页面侧联调 |
| 组员二 | 摄像头与机械臂仿真、模拟连接 | 提供模拟视频/原始帧、模拟连接、机位调整、回初始位、停止及异常状态；保留未来真实设备适配边界 |

首阶段共同目标：**模拟取景 → 用户提出要求 → 后端调用模型 → 仿真机位调整 → 页面反馈 → 拍照、裁剪和下载**。这是开发目标，当前已实现范围以「当前可以体验」为准。

三人先约定图像/原始帧格式、模型分析结果、调整意图与设备状态。模型由后端调用，密钥不进入前端；前端统一对接后端和仿真接口。

```text
src/main/java/com/example/lensmind/
  LensmindApplication.java       Spring Boot 入口
  api/DeviceController.java      模拟设备 REST API（组员二）
  api/AiController.java          模型与语音 REST API（组长）
  ai/                           模型协议、媒体处理、结果校验与调用限额（组长）
  control/DeviceGateway.java     设备适配接口（组员二）
  control/MockDeviceGateway.java 内存模拟器（组员二继续扩展仿真）
src/main/resources/
  application.properties        端口等运行配置
  prompts/                      可独立调试的文字/视觉提示词（组长）
  static/
    index.html                  工作台页面（组员一）
    css/style.css               响应式样式（组员一）
    js/app.js                   页面、摄像头、倒计时和照片管理（组员一）
    js/crop.js                  无损数字裁剪（组员一）
    js/commands.js              前端解析占位（组员一对接组长的模型接口）
    js/api.js                   设备接口客户端（组员一与组员二协作）
    js/ai-client.js             模型接口封装与 WAV 编码（供组员一对接）
    assets/                    项目自带的图标和模拟插画
src/test/java/                  启动与模拟控制测试
docs/                           接口约定与开发任务
config/                         模型本机配置示例（真实密钥文件不提交）
scripts/                        模型列表查询、少量接口验证脚本（Python 3）
.github/                        CI、PR 模板
```

接口与后续边界见 [docs/API.md](docs/API.md)，三人任务和联调顺序见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

## AI 协作与文档更新规则

组员使用 AI 开发前，先让 AI 阅读根目录 [AGENT.md](AGENT.md)。[AGENTS.md](AGENTS.md) 是供支持该文件名的工具自动发现的入口；不自动加载项目规则的工具，需要在任务开始时显式要求其阅读。

**每次更新项目，都必须同步更新本 README，并在下方「更新记录」标明日期、更新人、修改内容和验证情况。** 功能、启动方式或限制变化时还要修改对应正文，不能只追加日志。一次完整任务可以合并记录，但不能覆盖其他人的历史记录。只读咨询不需要修改文档。

更新人填写实际姓名或团队昵称；AI 辅助时一并注明助手名称。身份未提供时如实标记待补充，不能猜测署名。详细要求见 [AGENT.md](AGENT.md)。

## 上传 GitHub / 团队协作

仓库已初始化时不需要再次 `git init`。先检查当前分支、远程和修改，避免混入本地文件：

```bash
git status
git remote -v
git switch -c feat/studio-scaffold
git add .
git commit -m "feat: add LensMind photography studio scaffold"
git push -u origin feat/studio-scaffold
```

然后在 GitHub 提交 Pull Request 合入 `main`。若项目已经有你希望使用的个人开发分支，可继续在该分支提交。组员各自创建功能分支并通过 PR 合并，不要多人直接覆盖主分支。CI 在 push/PR 时执行 Java 17 下的 Maven 测试。

可选：安装 Node.js 20+ 后运行 `node --test tests/frontend.test.mjs`，检查裁剪边界与指令语义。CI 会自动执行；应用启动仍然只需要 Java。

`.gitignore` 已排除构建输出、IDE 配置、照片、本地环境变量和日志；不要提交模型密钥、设备密码、照片或录音。

## 更新记录

按更新日期倒序排列；同一天的新记录放在前面。

| 日期 | 更新人 | 修改范围 | 更新内容 | 验证情况 |
| --- | --- | --- | --- | --- |
| 2026-11-20 | Codex（AI 辅助，按组长要求） | TTS 备选核查 / 交接 | 补充 MiniMax、Gemini 等 TTS 候选，记录 Gemini 原生语音接口的独立短句测试；保留现有默认配置，不自动切换或重试。 | Gemini 2.5 Flash Preview TTS 单次请求返回 429 / 上游满载，未获得音频；MiniMax 未测试；文档链接及差异空白检查通过，未重新运行代码测试。 |
| 2026-11-20 | Codex（AI 辅助，按组长要求） | UniAPI 语音接入 / 错误反馈 / 交接 | 新增 OpenAI multipart ASR 协议与 UniAPI 独立密钥配置，默认 Whisper/tts-1；保留 Qwen 语音协议；区分上游满载、限流和余额不足；处理常见繁体控制词；新增语音单独验证与多平台模型查询，更新交接说明。 | 22 项 Java 测试通过；UniAPI 鉴权和列表查询成功，后端真实 Whisper 转写通过；TTS 的 4 次短句请求均被上游满载拒绝，未获得云端语音；检查 Python 语法、链接与密钥忽略规则。 |
| 2026-11-20 | Codex（AI 辅助，按组长要求） | 语音可用性核查 / 交接 | 补查 99 个完整模型条目与平台音频文档；明确文档列有语音接口，但当前 Key 的 default 分组没有已测语音模型的可用通道；同步接口说明与交接文档。 | tts-1、gpt-4o-mini-tts、whisper-1 各一次请求均返回 HTTP 503 / model_not_found；未获得音频或转写结果，无自动重试；检查文档链接与差异空白，未重新运行代码测试。 |
| 2026-11-19 | Codex（AI 辅助，按组长要求） | 后端模型 / 语音适配 / 交接 | 新增 Qwen 文字与单帧视觉接口、独立提示词、输入/输出校验、调用限额、ASR/TTS 协议适配、前端调用封装与 WAV 工具、CC0 测试人像及模型交接文档；现有页面和设备接口保留。 | 16 项 Java 测试通过；前端模块语法与 WAV 编码检查通过；真实 Qwen 文字/图片样例通过，另有一次超时；外部 ASR/TTS 服务尚待提供与验证。 |
| 2026-11-19 | Codex（AI 辅助，按组长要求） | 团队分工 / 仿真范围 / 文档 | 明确组长负责模型调试与后端接入、组员一负责前端和整体体验、组员二负责摄像头与机械臂仿真及模拟连接；同步 AGENT、README 和协作指南，真实硬件接入列为后续扩展。 | 已检查三份文档的分工一致性、相关本地链接与差异空白；纯文档修改，未重新运行代码测试。 |
| 2026-11-19 | Codex（AI 辅助，成员身份待补充） | 协作规范 / 文档 | 新增项目级 `AGENT.md` 与自动发现入口 `AGENTS.md`；明确每次更新必须维护 README 并标注更新人；同步开发指南与 PR 模板。 | 已检查文档规则一致性、相关本地链接与差异空白；纯文档修改，未重新运行代码测试。 |
| 2026-11-19 | Codex（AI 辅助，成员身份待补充） | 初始框架 / 前端 / 模拟控制 | 基于原有 Spring Boot 框架增加摄影工作台、模拟设备接口、指令解析、拍照裁剪下载、测试和 CI；真实硬件与视觉模型待接入。 | 初始实现时 3 项 Java 测试通过；已检查浏览器拍摄、停止、裁剪导出及 390px 窄屏布局；前端指令与裁剪边界检查通过。 |
