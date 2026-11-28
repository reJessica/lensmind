$ErrorActionPreference = 'Stop'
$modelDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'models'
function Install-VisionModel($Name, $Expected, $Source) {
    $model = Join-Path $modelDir $Name
    if (Test-Path -LiteralPath $model) {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $model).Hash -ine $Expected) {
            throw "The existing $Name differs from the expected model. Move it before retrying."
        }
        Write-Host "Vision model ready: $model"
        return
    }
    $temporary = Join-Path $modelDir ([IO.Path]::GetRandomFileName())
    try {
        curl.exe --fail --location --silent --show-error --retry 2 --output $temporary $Source
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $Name. Check the connection and rerun this script." }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash -ine $Expected) {
            throw "Model SHA-256 check failed for $Name."
        }
        Move-Item -LiteralPath $temporary -Destination $model
        Write-Host "Vision model ready: $model"
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
Install-VisionModel 'ssd_mobilenet_v1_12.onnx' `
    'b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058' `
    'https://media.githubusercontent.com/media/onnx/models/c5cae0f1942c8d7727372c7b1f6b485aa39e4421/validated/vision/object_detection_segmentation/ssd-mobilenetv1/model/ssd_mobilenet_v1_12.onnx'
Install-VisionModel 'face_detection_yunet_2026may.onnx' `
    'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0' `
    'https://media.githubusercontent.com/media/opencv/opencv_zoo/26cc381e4d2594bb9f47a26eb8fd96c94a13660d/models/face_detection_yunet/face_detection_yunet_2026may.onnx'
Install-VisionModel 'pose_estimation_mediapipe_2023mar.onnx' `
    '9d89c599319a18fb7d2e28451a883476164543182bafca5f09eb2cf767ed2f3f' `
    'https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/pose_estimation_mediapipe/pose_estimation_mediapipe_2023mar.onnx'
