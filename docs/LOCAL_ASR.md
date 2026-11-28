# 本地实时中文语音识别交接

更新人：ya.liu（AI 辅助：Codex） · 2026-11-28

固定模型：`sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`，CPU 推理，16kHz 单声道。LLM 仍使用汇云 Qwen，TTS 仍使用 UniAPI Gemini，云端服务的限流不会因切换 ASR 自动消失。

## 组员首次启动

安装 Git LFS 后拉取代码和权重：

```bash
git lfs install
git pull
git lfs pull
python scripts/setup_local_asr.py --verify-only
```

三个 ONNX 文件由 Git LFS 存储，`tokens.txt` 和 SHA-256 清单是普通 Git 文件。不要只下载网页 ZIP 后就认定权重齐全；若 ONNX 是一小段 LFS 指针，运行 `git lfs pull`。也可显式运行 `python scripts/setup_local_asr.py` 从固定上游版本补齐，下载后对照清单校验。

需要 Python 3.12，首次建立独立环境（不修改现有机械臂环境）。

macOS / Linux：

```bash
python3 -m venv .venv-asr
.venv-asr/bin/python -m pip install -r asr/requirements.txt
.venv-asr/bin/python asr/local_asr_server.py
```

Windows PowerShell：

```powershell
py -3.12 -m venv .venv-asr
.\.venv-asr\Scripts\python.exe -m pip install -r asr/requirements.txt
.\.venv-asr\Scripts\python.exe asr\local_asr_server.py
```

看到 `local streaming ASR ready` 后，另一个终端启动 Spring Boot：`./mvnw spring-boot:run`（Windows：`.\mvnw.cmd spring-boot:run`）。ASR 默认监听本机 9001；默认避开机械臂的 876x 端口。需要自定义时，在 Python 与 Spring Boot 两个终端设置相同的 `LENSMIND_LOCAL_ASR_PORT`，或同时修改 Python `--port` 和 Spring `--lensmind.local-asr.port`。旧进程需停止后重新启动两项服务，端口不会热更新。不要启动第二份占用相同端口的服务。

设置页 ASR 固定为「本地 Zipformer」，不可切换；点击检查本地 ASR 服务。回到拍摄页开启麦克风。只使用本地 ASR 不需要 API Key；云端 TTS 仍需单独保存语音配置。麦克风来源可在设置页选择，不显示音量检测界面。

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
