# 固定模型与设置页交接

更新日期：2026-11-28。更新人：ya.liu（AI 辅助：Codex）。

## 固定方案

| 功能 | 推荐模型 | 设置页其他选项 |
| --- | --- | --- |
| LLM 与画面分析 | 汇云 `qwen3.5-27b`，基础地址 `https://zgc.apihy.com/v1` | 百炼 `qwen3.5-flash-2026-02-23`（关闭思考）、致远一号 `qwen`、自定义受限域名接口 |
| ASR | 本地 Zipformer 中文 INT8（流式，固定） | 不提供云端或浏览器切换 |
| TTS | UniAPI `gemini-3.8-flash-lite-tts` | tts-1（曾上游满载）、浏览器，或手选百炼 `qwen-audio-3.1-tts-flash` |
| 云端音色 | Gemini `Kore`；tts-1 为 `alloy` | 百炼选项固定 `longanhuan_v3.1` |

前端预设位于 `static/js/model-presets.js`，后端由 `SpeechController` 校验服务商与固定模型组合。新用户默认「汇云 LLM + 本地 Zipformer ASR + UniAPI Gemini TTS」，无需百炼账号或 Workspace；首次加载、偏好损坏和恢复默认一致。旧的百炼语音默认值迁移至 UniAPI，保留其余偏好及此前明确手选的浏览器；新记录以 `modelDefaultsVersion: 2`、`speechDefaultsVersion: 5` 标记，此后手选百炼会保留。固定型号不意味着供应商内部版本永久不变。页面加载不产生推理费用，缺少凭据时提示，不回退浏览器。

新版偏好为 `speechDefaultsVersion: 5`，将旧 UniAPI tts-1 默认迁移到已实测的 Gemini 3.8，保留此前手选的浏览器/百炼及新版手选的 tts-1。Gemini 走 `/gemini/v1beta/models/gemini-3.8-flash-lite-tts:generateContent`，用 `x-goog-api-key` 鉴权，解码校验 WAV；语速为风格提示，不保证精确倍速。

## 使用步骤

1. 启动 Spring Boot，打开顶部「设置」。
2. LLM 默认「汇云 Qwen3.5-27B」，填写汇云 Key，点「测试并连接」。用户提供的 `https://zgc.apihy.com/v1/models` 用于列举模型，设置中的调用基础地址填 `/v1`。如手选百炼方案，需改用对应百炼 Key。测试发送一张生成的色块，并计入真实调用尝试。
3. 语音服务商默认 UniAPI，ASR 固定本地 Zipformer，TTS 为 `gemini-3.8-flash-lite-tts/Kore`（ASR 无需密钥，保存云端配置用于 TTS）。可留空读取 `config/ai-local.properties` 的 `lensmind.uniapi-key`（或环境变量 `LENSMIND_UNIAPI_KEY`），也可填写独立 UniAPI Key，再点「保存语音配置」。此方案不显示或要求 Workspace ID。仅手选百炼官方时才需要百炼北京地域 Key 与 Workspace ID。TTS 保留原有播报选项，ASR 不随 TTS 服务商切换；禁止跨服务商混用 TTS 模型或自动沿用密钥。
4. 保存仅创建本机会话，**不访问供应商，不代表鉴权已验证**。点「试听播报」才调用所选 TTS；返回拍摄页开启麦克风后才采集音频并调用所选 ASR。云端 TTS 需先保存会话，本地 ASR 不需要云端会话。
5. 首次只录一条短指令、试听一句话，再检查用量。错误明确显示，不自动重试、换模型或转浏览器。

试听按钮旁会保留合成等待、播放进度和具体失败原因（包括未保存配置、供应商上游满载、超时及浏览器阻止播放）。等待/播放时按钮变为「取消试听」，再次点击取消当前等待或声音，晚到音频不播放；已发送的请求仍可能计费。音量为 0 时不发起合成。云端请求等待上限约 70 秒，不自动重试；错误提示不会只显示在拍摄页。此反馈流程已通过前端单元测试，实际浏览器与云端播放仍待验证。

主动取消仅显示「试听已停止。」；内部重置不显示用户取消或重复计费提示。设置页试听不依赖设备连接，仿真断连不会触发音频取消；拍摄页断连时仍保留停止播报及取消拍照的处理。

摄影与语音分别保存密钥，不把汇云 Key 发给 UniAPI，也不把 UniAPI Key 发给百炼，断开一个连接不影响另一个。点击连接/保存后清空输入并显示结果，保存成功不代表供应商鉴权已验证。会话内凭据最多使用 30 分钟；配置在本机文件中的 UniAPI Key 可在用户再次保存时重新读取，不向浏览器返回 Key。切换语音服务商清空未提交 Key，其他输入与页面切后台的行为见 README。百炼仅在相同 Workspace 的已有有效会话中允许留空沿用 Key；跨服务商或跨 Workspace 不复用会话凭据。

本地 ASR 启动步骤、模型校验和接口见 [LOCAL_ASR.md](LOCAL_ASR.md)。默认本机增量识别，不再等整句上传；页面不提供其他 ASR 方式，旧偏好统一迁移本地，不自动回退。

## 当前实际链路

- 浏览器识别沿用 Web Speech API，可能依赖浏览器提供方的网络服务。
- 云端 ASR：AudioWorklet 采集 PCM，约 650 ms 静音断句、约 10 秒长句切段。重采样为 16 kHz 单声道 PCM WAV 上传后端，UniAPI 使用固定 `/v1/audio/transcriptions` 与 `whisper-1`；手选百炼则用官方 WebSocket Fun-ASR，只接受最终句子并去重，服务端最大 15 秒。
- 文字进入现有 `runCommand`；停止、快门和明确构图口令走本机规则，普通咨询交给已连接 LLM。语音服务不直接控制设备。
- 浏览器与云端 ASR 共用清空草稿口令：说「清空」「清除」「重来」「重置」只清空输入、继续监听，不提交 LLM，也不复位设备；「重置相机」「清除头部目标」等明确设备/构图指令仍交给原有规则处理。输入框的「×」按钮同样保留。
- 云端 TTS：UniAPI 默认调用 Gemini 原生接口生成 WAV，Kore 音色；备用 tts-1 调用 `/v1/audio/speech`，alloy 音色，返回校验后的 WAV/MP3；手选百炼通过 WebSocket 合成 MP3。完整短句返回浏览器播放，最多 160 字，语速 0.8～1.2，音量由播放器控制。
- **本地 ASR 已支持增量文字，云端仍为整句转写；TTS 逐块播放和 LLM 流式播报尚未实现**，不能用供应商首包延迟宣称项目达到相同延迟。
- 等待合成期间继续识别，只有音频即将播放时才暂停识别以避免回声，结束后恢复；合成失败或取消等待不暂停 ASR。此时可用页面「停止」或 Esc 中断。停止、切后台、离开拍摄页会关闭采集并丢弃待返回结果、停止播放；已发送给供应商的请求仍可能处理或计费。
- Whisper 原始转写保留繁体；前端仅归一化项目控制词后解析，支持「請拍照」「請拍攝」，否定和停止优先级保持不变。

## 费用与验证边界

摄影会话的连接测试/分析、新语音会话 ASR/TTS 和旧接口的 LIVE 调用共享 `LiveCallBudget`：默认每进程 50 次尝试、并发 2、无自动重试，重启清零。LLM 回答与云端 TTS 各计一次，本地 ASR 不计数。可通过 `LENSMIND_MAX_LIVE_CALLS` 或本机 `lensmind.ai.max-live-calls` 调整，重启生效。次数不是金额预算，设置页服务状态显示尝试次数。

旧 `/api/ai/status` 的 `MOCK/LIVE` 控制旧版独立接口。工作台临时摄影/语音会话由用户手动配置并激活，主动调用云端时访问真实模型；加载页面、查看状态、保存语音配置不会产生推理调用。

2026-11-25 只读查询现有账号的模型列表：汇云共 98 个模型，未发现语音相关 ID；UniAPI 共 226 个模型，列出 `whisper-1`、`tts-1`、`gpt-4o-mini-tts` 等。可见不等于可用：历史 UniAPI Whisper 已成功转写，TTS 曾返回 429 上游满载；本次未重新调用真实语音接口，不声称 TTS 已恢复。新会话路径用模拟客户端验证，实际音质、延迟和浏览器录音/播放仍待验证；百炼未用真实账号验证。

2026-11-26 经设置页对应的语音会话接口，使用本机已有 UniAPI Key，对 `tts-1/alloy`（语速 1.0）真实调用一次，文本为「请看向镜头，放松肩膀。」。约 49.2 秒后后端返回 HTTP 503 / 供应商上游负载已饱和，调用次数增加 1；无自动重试或回退。未获得音频，无法试听，不将失败耗时当成成功合成延迟；音质、播放及端到端语音链路仍待验证。测试会话已清除，未调用 ASR。

2026-11-28 随后按用户指定测试 Gemini 3.8 Flash-Lite 成功：原生接口返回 2.96 秒 WAV（请求约 3.38 秒）；项目后端生成 3.0 秒 WAV（5.35 秒），再经 Whisper 回听（7.97 秒）返回「請看向鏡頭,放鬆肩膀。」。本轮共 6 次真实尝试，无自动重试。音频位于 Git 忽略的 `docs/model-tts-preview.local.wav`，真实浏览器、麦克风与拍摄仍待验证。

## 官方协议

2026-11-28 复测：设置页对应的后端 Whisper 对系统合成的「请拍照」测试录音在 2.56 秒返回「請拍照」；系统合成仅作 ASR 输入。`tts-1/alloy`（后端 503，1.04 秒）与用户指定的 `gemini-2.5-flash-preview-tts/Kore`（UniAPI Gemini 原生接口 429，0.99 秒）均被上游满载拒绝。三次独立尝试，无自动重试，未获得云端音频；Gemini 尚未接入设置页，也未声明可用。需要供应商恢复/调整通道或提供另一个可用 TTS 服务。音质和实体麦克风拍摄仍待验证。

- [UniAPI Audio](https://docs.uniapi.ai/docs/use/api/audio)
- [UniAPI Gemini 原生接口](https://docs.uniapi.ai/docs/use/api/gemini)
- [Fun-ASR 客户端事件](https://help.aliyun.com/en/model-studio/fun-asr-client-events)、[服务端事件](https://help.aliyun.com/en/model-studio/fun-asr-server-events)
- [Qwen-Audio-TTS WebSocket](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-websocket-api)
- [Qwen3.5 Flash 快照](https://help.aliyun.com/en/model-studio/qwen3-5-flash)

本地 Zipformer 权重按组长要求通过 Git LFS 随仓库分发，运行 `git lfs pull` 并按 [LOCAL_ASR.md](LOCAL_ASR.md) 启动本机服务；云端 LLM/TTS 使用组员自己的凭据。

按用户要求移除麦克风音量及持续静音诊断，保留录音、ASR 和正常状态。设置页可选实体输入设备及音频增强。ASR/TTS/摄影 LLM 错误分别标注阶段；ASR 暂时满载、限流或超时保留麦克风，提示 3 秒后重新说，丢弃失败句且无自动重试；余额、调用限额、会话等错误仍停止收听。
