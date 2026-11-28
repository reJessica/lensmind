# 模型模块交接

更新人：Codex（AI 辅助，按组长要求） · 2026-11-20

2026-11-25 补充（ya.liu，AI 辅助：Codex）：工作台设置页已加入固定 LLM/ASR/TTS 预设及独立语音会话，接入与验证边界见 [MODEL_PRESETS.md](MODEL_PRESETS.md)。下文继续说明旧版独立接口及历史实测，不代表新固定方案已通过云端鉴权。

2026-11-26 复测（ya.liu，AI 辅助：Codex）：当前默认方案为汇云 `qwen3.5-27b` + UniAPI `whisper-1` / `tts-1/alloy`，无需百炼账号。使用已有本机 UniAPI Key，通过新 `/api/ai/speech/tts` 对「请看向镜头，放松肩膀。」真实调用一次（语速 1.0）；约 49.2 秒后后端返回 HTTP 503，明确提示供应商上游负载已饱和。未获得音频，实际试听仍未完成；未重试、换模型或回退浏览器，未调用 ASR，测试语音会话已清除。需供应商恢复或调整当前分组通道后再手动试听。

## 现在交付了什么

2026-11-28 最新可用语音搭配（ya.liu，AI 辅助：Codex）：Whisper + Gemini `gemini-3.8-flash-lite-tts/Kore` 经 UniAPI 原生接口与项目后端真实合成/回听均成功。设置页已改默认并迁移旧 tts-1 偏好；音频位于 Git 忽略的 `docs/model-tts-preview.local.wav`。历史失败记录保留，最新步骤与验证见 [MODEL_PRESETS.md](MODEL_PRESETS.md)。

2026-11-28 补充（ya.liu，AI 辅助：Codex）：新会话 Whisper 独立实测成功，系统语音测试输入「请拍照」转写为「請拍照」（LIVE，2.56 秒）。前端已修复繁体快门识别，等待 TTS 合成不再暂停 ASR，仅实际播放音频时暂停。UniAPI `tts-1` 与用户指定的 Gemini `gemini-2.5-flash-preview-tts`（原生接口、Kore）各一次仍为上游满载，无云端音频；未重试或自动切模型。真实麦克风及拍照流程需在浏览器授权后联调，不能把本机系统测试录音当成云端生成成果。

- Spring Boot 后端：文字指令解析、单帧构图分析/人物指导、ASR 与 TTS 适配接口、模式和用量状态。
- 提示词：`src/main/resources/prompts/command-v1.txt`、`vision-v1.txt`，版本 `lensmind-v1`，可独立调试。
- 前端接入封装：`static/js/ai-client.js`，包含图片上传、语音调用和 WAV 编码工具；没有改写组员一的现有工作台。
- MOCK 无需模型 Key 即可联调，但视觉结果/转写是固定示例，TTS 只有提示音，均明确标注。
- LIVE 失败返回错误，不伪装成 MOCK 成功。AI 接口不会调用机械臂，也不负责自动执行闭环。

## 真实验证情况

用户提供的平台：`https://zgc.apihy.com/v1/models`。已使用本机配置成功查询模型列表，含 `qwen3.5-27b`；未列出 Qwen ASR/TTS，不能据此假设语音模型可用。

2026-11-20 补查：完整列表共 99 个条目，未列出专用语音模型，但平台官方文档确有 [TTS](https://docs.apihy.com/416890932e0)、[Whisper](https://docs.apihy.com/416890933e0) 和 [转写接口](https://docs.apihy.com/416890934e0)。因此不能仅因模型列表缺失就要求另换供应商。

原汇云 Key 对 `tts-1`、`gpt-4o-mini-tts` 和 `whisper-1` 各进行一次短请求，均返回 HTTP 503 / `model_not_found`，提示当前 `default` 分组没有该模型的可用通道。该次旧平台测试没有获得真实音频或转写结果。

随后按用户提供的 UniAPI 接入语音：独立 Key 鉴权与列表查询成功（217 个条目，包含 `whisper-1`、`tts-1`）。真实 ASR 通过本后端验证：上传本机 macOS 系统语音生成的 2.78 秒 WAV，返回“請看向鏡頭,放鬆肩膀。”；这段录音是免费测试输入，不能当成 UniAPI TTS 成果。指令解析已兼容常见繁体控制词，ASR 原始文字不改写。

UniAPI 的 TTS 尚未成功：`tts-1` 共 3 次、`gpt-4o-mini-tts` 1 次短句尝试均返回 429 / `api_limit`，原因为“当前分组上游负载已饱和”。没有自动重试，最后检查后已停止调用。需供应商负载恢复或提供方调整可用通道后再手动验证，不能把它误报为余额不足、接口不支持或已经接通。

后续用户询问其他 TTS 时，另用列表中的 `gemini-2.5-flash-preview-tts`，经 UniAPI Gemini 原生 `generateContent` 接口做了一次中文短句尝试，也返回 429 / 同样的上游满载提示，未获得音频。该原生协议尚未加入本后端。备选的 MiniMax `speech-02-turbo` / `speech-2.6-turbo` 在列表可见，但尚未验证其 UniAPI 调用路径、音色配置和真实可用性；不能把列表可见等同于已接通。未改变默认 TTS 模型，没有设置自动轮换供应商。

2026-11-19 真实测试：

| 测试 | 结果 |
| --- | --- |
| “请把人物安排在画面右侧，留出左边的空间，拍成半身” | 返回 COMPOSE / right / half |
| 对 CC0 头肩人像请求居中全身构图 | 识别可见范围为头胸部，指出缺少腿脚，数字裁剪不能补回 |
| 图片人物框/指导 | 返回粗略人物框与一条简短指导；稳定性仍为 UNKNOWN |
| 停止与否定 | 本地规则处理，不产生外部调用 |
| AI 请求前后设备状态 | 未改变模拟设备位置或状态 |
| 真实 ASR（UniAPI） | whisper-1 通过后端成功转写上述中文短录音 |
| 真实 TTS（UniAPI） | 4 次短句尝试均为上游满载，尚未获得云端合成音频 |

上述文字/视觉阶段共尝试 3 次真实生成请求：首次 30 秒超时，调整为 60 秒后文字和图片各成功一次，无自动重试；这不包含后来单列的语音测试，也不是准确率评测。费用以供应商账单为准。

当前有 22 项 Java 测试通过，包括 19 项 AI 测试；新增 OpenAI multipart 转写、无效协议、缺失转写结果、上游满载与额度不足分类、繁体控制词检查。AI 测试使用本机假模型服务，不访问外网，不消耗模型额度。前端模块语法和 WAV 样本编码此前已检查。

## 运行

```bash
./mvnw spring-boot:run
```

默认 MOCK。真实调用前，将 `config/ai-local.example.properties` 复制成 `config/ai-local.properties` 并在本机填写密钥（已被 Git 忽略）。组长当前机器已配置文字模型 Key，不要覆盖已有本机配置，也不要把它交给组员或提交仓库。

```properties
lensmind.api-key=在本机填写文字模型密钥
lensmind.ai.mode=LIVE
lensmind.ai.chat.url=https://zgc.apihy.com/v1/chat/completions
lensmind.ai.chat.model=qwen3.5-27b
```

也可保持本地文件不变，仅对启动命令临时启用：

```bash
LENSMIND_AI_MODE=LIVE ./mvnw spring-boot:run
```

语音已改为用户提供的 UniAPI，独立于原有文字模型平台，使用以下配置：

```properties
lensmind.uniapi-key=在本机填写UniAPI密钥
lensmind.ai.asr.url=https://api.uniapi.io/v1/audio/transcriptions
lensmind.ai.asr.model=whisper-1
lensmind.ai.asr-protocol=OPENAI_AUDIO
lensmind.ai.tts.url=https://api.uniapi.io/v1/audio/speech
lensmind.ai.tts.model=tts-1
lensmind.ai.tts-protocol=OPENAI_AUDIO
lensmind.ai.voice=alloy
```

ASR 支持 `OPENAI_AUDIO`（multipart 文件 → `text`）与 `QWEN_CHAT`（聊天 `input_audio`）；TTS 支持 OpenAI 风格音频接口和百炼原生协议。默认使用上面的 UniAPI 配置，Key 可由 `lensmind.uniapi-key` 或环境变量 `LENSMIND_UNIAPI_KEY` 提供；也可用 `lensmind.asr-api-key` / `lensmind.tts-api-key` 分别覆盖，未使用的覆盖项不要填空值。不会自动把文字模型 Key 发给 UniAPI。

如果切回 Qwen ASR，必须同时更改 `asr-protocol=QWEN_CHAT`、接口地址与模型 ID，不能只改模型名称。

## 给组员一：前端只需接这些

完整字段在 [API.md](API.md)。可直接使用：

```js
import { aiApi } from './ai-client.js';
const result = await aiApi.command('帮我拍一张居中的半身照');
// result.data 是意图；source/mode 区分真实模型、本地规则与模拟。
// 按已有页面状态和控制接口处理意图，不要直接执行任意模型文本。
```

- `/api/ai/command`：提交文字，消费 `result.data.type` 及对应字段；GUIDE 请求可结合当前帧调用 vision，读取一条 guidance。
- `/api/ai/vision`：上传取景原始 JPEG/PNG Blob，附 `frameId/capturedAt/composition/framing`；读取分析与指导。不要每帧调用大模型，先按用户请求/动作完成触发。
- `/api/ai/asr`：上传 WAV，展示转写后再请求 command；`encodeWav` 不采集音频，录音模块需提供实际采样率和 PCM 数据。
- `/api/ai/tts`：将返回 Blob 给音频元素播放；检查 `kind`，不要把 MOCK 的 tone-only 当成朗读。浏览器的播放授权和停止播放由前端处理。
- 遇到 `PROVIDER_BUSY` 显示“语音服务繁忙，请稍后重试”；不要自动循环请求。TTS 未恢复时可显式使用现有浏览器朗读作为临时替代，不能标成云端 TTS 成功。
- 停止直接调用设备接口，同时取消倒计时/播放/待处理结果。用任务代次或 AbortController 丢弃旧结果；浏览器取消请求不保证供应商取消推理或退费。
- `stability=UNKNOWN` 不能作为站稳确认；人物框是粗略估计，不作为精确定位依据。
- 当前 `app.js` 仍然走已有前端规则与浏览器语音方案，需要你显式接入新模块；不要把“后端接口完成”当成“页面已接通”。

## 给组员二：仿真提供这些

- 模拟相机原始图像及分辨率、是否镜像、唯一 `frameId` 和采集时间。
- 每次模拟机位移动完成的状态；移动后提供新帧，供模型重新分析。
- 保持既有 `/api/device/*` 约定；新增能力先更新接口文档。模型只输出目标/建议，控制端负责允许的动作和范围。
- 当前视觉返回 `suggestion` 是自然语言建议，尚未实现将视觉建议自动转为机位动作的闭环；不要直接解析其中的数字控制关节。

## 检查与调试

```bash
./mvnw test
node --test tests/frontend.test.mjs
python3 scripts/list_models.py
python3 scripts/list_models.py --provider uniapi
# 对 MOCK 服务运行，不产生外部调用：
python3 scripts/smoke_ai.py --speech
# LIVE：文字和图片各一次，显式选择才消耗额度：
python3 scripts/smoke_ai.py --base-url http://127.0.0.1:8080 --live
# 只测 TTS→ASR，不重复消耗文字/图片额度（最多 2 次语音调用）：
python3 scripts/smoke_ai.py --base-url http://127.0.0.1:8080 --live --speech-only
```

`--speech` 在完整测试后增加 TTS 与 ASR，`--speech-only` 则跳过文字/图片模型。TTS 失败时不会继续调用 ASR，也不自动重试。脚本会写被 Git 忽略的 `docs/model-test-results.local.json`；成功的真实 TTS 预览保存到同样被忽略的 `docs/model-tts-preview.local.wav`，不记录密钥。

默认每进程最多尝试 8 次真实调用、并发 2、超时 60 秒，不自动重试；进程重启会重置计数，不等于人民币预算。修改模型/提示词后先用少量固定样例评估，再扩大测试。

测试图片及许可见 [samples/ATTRIBUTION.md](samples/ATTRIBUTION.md)。它仅验证单张头肩照的分析接口，后续还需要全身、无人物、遮挡、多人、低光等测试样例，以及连续帧稳定性模块。

## 参考资料

- [Qwen3.5-27B 官方模型卡](https://huggingface.co/Qwen/Qwen3.5-27B)：文字/图像能力，具体 API 是否启用视觉取决于供应商部署。
- [Qwen ASR 官方协议](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
- [Qwen TTS 官方协议](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
- [UniAPI 音频文档](https://docs.uniapi.ai/docs/use/api/audio)
