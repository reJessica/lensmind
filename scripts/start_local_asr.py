"""Prepare the isolated ASR environment once, then replace this process with the server."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv


def report(text):
    print('LENSMIND_ASR: ' + text, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=9001)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    model = root / 'models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
    for name in ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt', 'download-manifest.json']:
        path = model / name
        if not path.is_file() or name.endswith('.onnx') and path.stat().st_size < 1024:
            report('模型权重未拉取完整，请在项目目录运行 git lfs pull 后重启后端。')
            return 1
    if sys.version_info < (3, 10):
        report('Python 版本过旧，请安装 Python 3.12，并设置 LENSMIND_ASR_PYTHON。')
        return 1
    environment = root / '.venv-asr'
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    try:
        if not python.is_file():
            report('首次准备本地识别环境…')
            venv.EnvBuilder(with_pip=True).create(environment)
        probe = subprocess.run([str(python), '-c', 'import sherpa_onnx, numpy'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if probe.returncode:
            report('首次安装本地识别依赖，需要联网，请稍候…')
            install = subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                                      '--timeout', '15', '--retries', '0', '-r', str(root / 'asr/requirements.txt')],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=150)
            if install.returncode:
                report('依赖安装失败，请按 docs/LOCAL_ASR.md 安装依赖，或检查网络与 Python 3.12 环境。')
                return 1
        report('正在加载本地识别模型…')
        os.execv(str(python), [str(python), '-u', str(root / 'asr/local_asr_server.py'), '--port', str(args.port)])
    except (OSError, subprocess.TimeoutExpired):
        report('本地环境准备失败或超时，请检查 Python、网络和项目目录写入权限。')
        return 1


if __name__ == '__main__':
    sys.exit(main())
