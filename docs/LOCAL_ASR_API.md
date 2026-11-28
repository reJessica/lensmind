# 本地 ASR 接口

更新人：ya.liu（AI 辅助：Codex） · 2026-11-28

所有接口位于同源 Spring Boot `/api/ai/local-asr`，仅接受 localhost/127.0.0.1 本机访问及合法来源，使用当前 HTTP 会话隔离录音连接。后端只代理固定 `127.0.0.1:8766`，不能传入任意 URL，不使用云端密钥或 `LiveCallBudget`。

| 方法 / 路径 | 输入 | 响应 |
| --- | --- | --- |
| GET `/status` | 无 | `ready/model/mode:LOCAL/sampleRate:16000`；服务未启动时 503 |
| POST `/session` | `application/json`：`{"sampleRate":16000}` | `id/model/mode:LOCAL/sampleRate:16000`；同浏览器新建会关闭旧会话 |
| POST `/audio?connectionId=...` | `application/octet-stream`：16kHz 单声道、小端 float32 PCM，范围 -1～1；每块 1～32768 字节且为 4 的倍数 | `{"mode":"LOCAL","results":[{"text":"拍摄","final":false,"segment":0}]}` |
| POST `/reset?connectionId=...` | `application/json`，`{}` | 清除未完成句并增加段号，`results:[]`；用于 TTS 播放前清理 |
| DELETE `/session?connectionId=...` | 无 | `closed:true`；不补发最终句，不影响另一 ID 的会话 |

`results` 可以为空；同一段的 partial 和 final 共用 `segment`。前端只显示中间字，收到 `final:true` 才执行口令，并对最终段号去重。边说边串行发送 PCM 小块，不是上传完整 WAV。队列超过 16 块时停止，以免旧口令延迟执行。

停止、页面切后台及会话变化后丢弃晚到结果。播报开始时暂停送音频，将 reset 排在当前请求后，旧结果通过页面代次丢弃；结束后从新句恢复。

Python 服务最多 4 会话，空闲 60 秒过期。无效 PCM 返回 400，超大块由代理拒绝；外来浏览器会话或已失效 ID 返回 409，非本机来源 403，Python 未启动/超时/推理错误 503。无自动重试、无云端回退。音频与文本仅在内存中处理。

启动和验证见 [本地 ASR 交接](LOCAL_ASR.md)，原有语音接口见 [API.md](API.md)。
