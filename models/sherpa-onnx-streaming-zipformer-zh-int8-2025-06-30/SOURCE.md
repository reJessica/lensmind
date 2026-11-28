# Zipformer 中文流式 INT8 权重

按组长要求使用 Git LFS 分发三个 ONNX 文件，`tokens.txt` 与校验清单由普通 Git 保存。

来源：[sherpa-onnx 官方发布包](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2)。

作者模型：[yuekai/icefall-asr-multi-zh-hans-zipformer-large](https://huggingface.co/yuekai/icefall-asr-multi-zh-hans-zipformer-large)。

校验：`python scripts/setup_local_asr.py --verify-only`。每个文件的固定 SHA-256 见同目录 `download-manifest.json`。

权重授权以上游模型作者说明为准；不因 sherpa-onnx 运行库采用 Apache-2.0 就推断权重采用相同许可证。本仓库保留来源信息，不另行赋予模型权重许可证。

启动与接口见 [本地 ASR 交接](../../docs/LOCAL_ASR.md)。
