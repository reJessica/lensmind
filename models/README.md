# 本地视觉模型

这三个固定版本的 ONNX 模型随仓库分发，应用从仓库根目录的 `models/` 读取。文件与上游版本逐字节一致。Windows 下运行 `.\scripts\setup-vision.ps1` 可以校验文件，文件缺失时该脚本会按固定版本下载。

| 模型文件 | 用途 | 上游和许可 |
| --- | --- | --- |
| `ssd_mobilenet_v1_12.onnx` | 人物检测 | [ONNX Model Zoo 发布的模型权重](https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/blob/main/ssd_mobilenet_v1_12.onnx)，[Apache-2.0](LICENSE-APACHE-2.0.txt) |
| `face_detection_yunet_2026may.onnx` | 人脸及头部定位 | [OpenCV Zoo 的 YuNet](https://github.com/opencv/opencv_zoo/tree/26cc381e4d2594bb9f47a26eb8fd96c94a13660d/models/face_detection_yunet)，[MIT，Shiqi Yu](LICENSE-YUNET.txt) |
| `pose_estimation_mediapipe_2023mar.onnx` | 姿态关键点 | [OpenCV Zoo 转换的 MediaPipe Pose](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/pose_estimation_mediapipe)，[Apache-2.0](LICENSE-APACHE-2.0.txt) |

SHA-256 校验值与下载地址见 [Windows 下载和校验脚本](../scripts/setup-vision.ps1)。
