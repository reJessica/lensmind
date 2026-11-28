# 本地实时中文语音识别交接

更新人：ya.liu（AI 辅助：Codex） · 2026-11-28

固定模型：`sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`，CPU 推理，16kHz 单声道。LLM 仍使用汇云 Qwen，TTS 仍使用 UniAPI Gemini，云端服务的限流不会因切换 ASR 自动消失。

## 自动启动（推荐）

安装 Python 3.12、Git LFS，拉取项目后先执行 `git lfs pull`。随后只需在项目根目录启动 Spring Boot：

```powershell
# Windows
.\mvnw.cmd spring-boot:run
```

```bash
# macOS / Linux
./mvnw spring-boot:run
```

后端自动复用已有的正确 ASR 服务；9001 空闲时自动创建独立 `.venv-asr` 环境，缺少依赖则安装 `asr/requirements.txt` 中的固定依赖，再加载模型。首次安装需要联网及目录写入权限，最多准备约 3 分钟；之后直接使用已安装的环境。不会自动下载模型权重，不调用云端 ASR，也不会启动机械臂服务。

设置页点「检查本地 ASR 服务」可查看准备进度或具体失败原因，`ready=true` 后回拍摄页打开麦克风。自动准备失败不会阻止网页启动；修复环境后重启后端即可，不在每次识别请求中反复安装或重试。

默认 ASR 端口 **9001**，网页 8080。Python 与 Java 共用 `LENSMIND_LOCAL_ASR_PORT`。如果找不到 Python，将 `LENSMIND_ASR_PYTHON` 设置为 Python 解释器完整路径（不是激活命令）；Windows 也支持 Python Launcher `py -3.12` 的自动探测。打包 JAR 仍需放在带 `scripts/`、`asr/`、`models/` 的仓库中运行，或通过 `LENSMIND_ASR_PROJECT_DIR` 指定仓库路径。

关闭后端时只终止它自己启动的识别进程及子进程；预先手动启动并被复用的服务不会被关闭。其他服务占用 9001 时明确报错，不会关闭占用进程。

## 手动管理（可选）

设置 `LENSMIND_ASR_AUTO_START=false` 可关闭自动启动。手动安装固定依赖并运行：

```powershell
py -3.12 -m venv .venv-asr
.\.venv-asr\Scripts\python.exe -m pip install -r asr/requirements.txt
.\.venv-asr\Scripts\python.exe asr/local_asr_server.py --port 9001
```

macOS / Linux 将解释器替换为 `.venv-asr/bin/python`。界面 ASR 固定本地 Zipformer，不提供云端/浏览器切换；TTS 仍使用原 Gemini 配置，需独立保存云端语音会话。

## 实际数据链路

浏览器 AudioWorklet 采集音频 → 转为 16kHz float32 PCM 小块 → 同源 Spring Boot `/api/ai/local-asr/*` → 常驻本机 Python 模型 → 返回中间/最终文字。

这是增量识别：同一句的音频持续进入同一个模型状态。传输采用串行 HTTP 小块请求，每块最多 32768 字节；不等待整句上传，不反复识别整段，也不直接让网页绕过后端访问 Python。中间结果只回填输入框，`final:true` 才触发指令，同一段只执行一次。

- 模型只在 Python 服务启动时加载一次；每次开启麦克风创建识别会话。
- 连续静音约 600ms 后可输出最终句；不是固定的端到端延迟保证，模型内部块、CPU 和浏览器调度都会影响响应。
- 播报期间暂停送音频并重置未完成句，播报结束后恢复；不会把旧的半句话拼到新口令里。
- 停止、切后台、离开拍摄页时中止请求、释放麦克风并关闭会话，不补发未确认句，不执行晚到结果。
- 本机服务失联或处理队列过长时停止收听并提示，不静默切换云端；不会消耗 `LiveCallBudget`。
- 拍照仍检查当前设备、景别和停止状态。ASR 本身不移动机械臂。
- Python 只监听 127.0.0.1，最多 4 个会话，空闲 60 秒回收；录音和转写只在内存中处理，不写日志或文件。

拍摄页仅创建本地识别器，不提供云端 Whisper 或浏览器识别切换。无论历史偏好版本与服务商，ASR 均统一为本地 Zipformer；TTS 偏好保持原选择。旧云端接口仅保留后端兼容，不参与当前页面的收听流程。

接口字段与错误见 [LOCAL_ASR_API.md](LOCAL_ASR_API.md)。

## 验证与边界

真实本地模型已对系统合成的「请拍照」测试录音输出中间字「请」「请拍照」及最终句。直接服务处理 1.85 秒音频（含句尾静音）约 0.08 秒，这是非实时投喂的处理耗时，不能当成用户说话到执行拍照的延迟。通过 Spring Boot 的连续两句本地实测也已通过，两次最终结果均为「请拍照」，段号 0、1；第一个中间结果出现在输入音频 0.5 秒处，串行非实时投喂总处理约 0.203 秒，云端调用计数增加 0。实体麦克风、Chrome/Edge 页面与实际快门仍需现场验证。

本地测试：

```bash
.venv-asr/bin/python -m unittest discover -s asr -p 'test_*.py'
node --test tests/frontend.test.mjs
./mvnw verify
```

CI 运行假模型协议测试，不下载 LFS 权重、不调用付费模型，不把单元测试结果当成实际识别准确率。

## 来源

- [Sherpa-ONNX 模型和使用说明](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30-chinese)
- [固定版本模型发布包](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2)
- [训练代码与记录](https://github.com/k2-fsa/icefall/blob/master/egs/multi_zh-hans/ASR/RESULTS.md)

模型来源和校验信息随权重目录保存；sherpa-onnx 运行库许可证与模型权重的授权说明分别以上游为准，不将运行库许可证自动套用到权重。
