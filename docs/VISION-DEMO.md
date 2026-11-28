# 视觉与语音演示

## 启动

项目使用 Java 17 或以上版本。在 Windows 上，从仓库根目录的 PowerShell 运行下列命令准备人物和头部定位模型，再启动项目。

```powershell
.\scripts\setup-vision.ps1
.\mvnw.cmd spring-boot:run
```

其他系统可把 [固定版本的官方 SSD-MobileNetV1 模型](https://media.githubusercontent.com/media/onnx/models/c5cae0f1942c8d7727372c7b1f6b485aa39e4421/validated/vision/object_detection_segmentation/ssd-mobilenetv1/model/ssd_mobilenet_v1_12.onnx) 放到 `models/ssd_mobilenet_v1_12.onnx`，再运行 `./mvnw spring-boot:run`。模型 SHA-256 为 `b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058`。可以通过 `LENSMIND_VISION_MODEL` 指定该模型的绝对路径。模型来自 [ONNX Model Zoo](https://github.com/onnx/models/tree/main/validated/vision/object_detection_segmentation/ssd-mobilenetv1)，文件位于 Git 忽略目录。

头部定位使用 [OpenCV Zoo 的 YuNet](https://github.com/opencv/opencv_zoo/tree/26cc381e4d2594bb9f47a26eb8fd96c94a13660d/models/face_detection_yunet)，也可把 [固定版本的模型文件](https://media.githubusercontent.com/media/opencv/opencv_zoo/26cc381e4d2594bb9f47a26eb8fd96c94a13660d/models/face_detection_yunet/face_detection_yunet_2026may.onnx) 放到 `models/face_detection_yunet_2026may.onnx`。SHA-256 为 `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0`，可用 `LENSMIND_FACE_MODEL` 指定模型路径。

半身和全身检查还使用 [OpenCV Zoo 姿态模型](https://github.com/opencv/opencv_zoo/tree/main/models/pose_estimation_mediapipe)。Windows 脚本会校验并安装。其他系统可下载 [固定模型文件](https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/pose_estimation_mediapipe/pose_estimation_mediapipe_2023mar.onnx) 放入 `models/`，或通过 `LENSMIND_POSE_MODEL` 指定绝对路径。SHA-256 为 `9d89c599319a18fb7d2e28451a883476164543182bafca5f09eb2cf767ed2f3f`。

打开 <http://127.0.0.1:8080/>，点「开始拍摄」。测试摄像头和麦克风时分别点击开启并批准权限。麦克风一次开启持续监听和播报。点「完成拍摄」关闭取景并进入选片页。

## 固定场景

在光线均匀的房间，将摄像头固定朝向墙面。由一人进入画面，背后留出空间。按顺序操作并检查结果。

| 操作 | 预期结果 |
| --- | --- |
| 输入或说「居中的半身照」 | 交互记录出现「已设置居中 · 半身」，右侧更新设置 |
| 输入「放大一点」，再输入「相机靠近一点」 | 前者修改数字裁剪；后者显示机位意图提示 |
| 输入「三分构图」，再输入「右三分的全身照」 | 先询问左右，随后更新到右三分与全身 |
| 切回居中，打开摄像头，留空画面，再让同一人站到画面左侧 | 先提示未检测到人物，随后显示人物框、中心、面积占比和「人物偏左」 |
| 人物移到中央 | 新画面识别为位置接近目标后，「拍一张照片」立即可用 |
| 切到「手动拍摄」，启动倒计时后点「停止」 | 倒计时取消，模拟机位自动归零，随后可以直接再按快门 |
| 点「拍一张照片」，在 3 秒内离开 | 人物框消失并提示检测状态，倒计时结束时仍按当前取景拍摄 |
| 返回画面、到位后再拍一次 | 「本次拍摄」直接显示裁剪成片，点「查看原片」可见完整画面 |
| 打开成片，点「调整裁剪」，拖动裁剪框后点「保存裁剪」 | 调整时实时显示框内效果，保存后成片预览与相册同步更新，需另点下载才生成文件 |
| 在「摄影助手」点麦克风，让人物从画面一侧走向构图目标 | 朗读移动方向与到位提示，同一句位置提示不会逐帧重复 |
| 点麦克风，说「我需要拍一张人物在右下四格的半身照」，让头顶至腰胯入镜，听完提示说「拍摄」 | 先更新目标格和半身景别。位置和景别都满足后播报到位，听到「拍摄」才启动倒计时 |
| 选择全身，保持脸部在目标格，但让一只脚出框 | 界面提示保留双腿和双脚，直到所选景别和位置均满足 |
| 点「动作建议」，再用麦克风说「已完成」或点「已完成，继续」 | 一次朗读一条建议；确认后恢复操作。模型和摄像头就绪时可生成新的姿势建议 |
| 点「不限景别」，只让人物上部入镜，并将人物移到目标区域 | 可见人物框有超过一半面积在目标区域时，按钮可用 |
| 输入或说「让人物的头在右下角」，让可见脸部从左下移到右下 | 右下格高亮，脸部进入目标格后按钮可用，即使没有检测到人物框也可以拍摄 |
| 在 3:4 和 16:9 之间切换，拖动裁剪框的角，再拖动框内 | 九宫格、目标格和拍摄按钮随裁剪框更新。框内拖动平移，拖角缩放时保持所选比例 |

预览实时变化时，取景比例和站稳提示是人物框的几何估算。脚部、腰线和动作是否完成需要人工确认。浏览器若提示语音服务连接失败，可在同一输入框打一遍指令。手机或其他设备使用远程服务前，请先和团队确定 HTTPS、设备授权与数据处理方式。

## 多人构图

两个人分别站到画面左、右两侧。点取景框上的「人物 1」，选「左三分」。再点「人物 2」，选「右三分」。也可以在指令框里输入「人物1左三分，人物2右三分」。检查两人的目标同时出现在人物列表，切换人物时查看对应的参考线和建议。

点取景下方的九宫格，可以任意搭配。可以说「人物1左下四格，人物2中上一格」，也可以先选人，再说「左上一格和右下一格」。相应的格子会在预览中高亮；三个横向预设仍可直接选择。切换人物后，各自的目标会保留。

三人稍微移动或短暂遮挡时，检查界面继续使用原编号，短暂漏检时显示「暂未看清」。若有人长时间离开，可以在他的编号上清除目标。再次入镜时，请确认当前显示的编号再设置构图。

可以同时说「人物1左列三格，人物2的头在右下角」，分别按人物整体和脸部位置判断。脸部被遮挡或背对镜头时，需要露出脸部才能确认头部目标。

[接口与响应示例](API.md)
