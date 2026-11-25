#!/usr/bin/env python3
"""验证运行中的 AI 接口；默认拒绝 LIVE 服务，显式 --live 才允许少量付费调用。"""
import argparse
import datetime
import io
import json
import struct
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8080')
    parser.add_argument('--live', action='store_true', help='允许 2 次真实模型调用（文字、图片各一次）')
    parser.add_argument('--speech', action='store_true', help='额外验证 TTS→ASR，LIVE 时再增加 2 次调用')
    parser.add_argument('--speech-only', action='store_true', help='仅验证语音链路，LIVE 时只产生 TTS、ASR 各 1 次调用')
    args = parser.parse_args()
    def call(path, data=None, content_type='application/json'):
        request = urllib.request.Request(args.base_url.rstrip('/') + path, data=data,
                                         headers={'Content-Type': content_type})
        try:
            with urllib.request.urlopen(request, timeout=65) as response:
                body = response.read()
                if response.headers.get('Content-Type', '').startswith('application/json'):
                    return json.loads(body)
                return body
        except urllib.error.HTTPError as error:
            body = error.read()
            try: message = json.loads(body).get('message', '接口错误')
            except Exception: message = '接口错误（未打印原始响应）'
            raise RuntimeError('HTTP ' + str(error.code) + ': ' + message) from None
    def post(path, body):
        return call(path, json.dumps(body, ensure_ascii=False).encode())
    def upload(path, name, filename, media_type, data, fields=None):
        boundary = 'LensMind' + uuid.uuid4().hex
        segments = []
        for key, value in (fields or {}).items():
            segments.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        segments.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {media_type}\r\n\r\n'.encode())
        segments.extend([data, f'\r\n--{boundary}--\r\n'.encode()])
        return call(path, b''.join(segments), 'multipart/form-data; boundary=' + boundary)

    status = call('/api/ai/status')
    if status['mode'] == 'LIVE' and not args.live:
        raise SystemExit('当前为 LIVE；如需消耗额度，请显式添加 --live。未执行生成调用。')
    before = call('/api/device/status')
    stop = post('/api/ai/command', {'text': '停止拍照'})
    assert stop['source'] == 'RULE' and stop['data']['type'] == 'STOP'
    negative = post('/api/ai/command', {'text': '不要拍照'})
    assert negative['data']['type'] == 'CLARIFY'
    command, vision = None, None
    if not args.speech_only:
        command = post('/api/ai/command', {'text': '请把人物安排在画面右侧，留出左边的空间，拍成半身', 'composition': 'center', 'framing': 'full'})
        if args.live:
            assert command['source'] == 'MODEL', command
            assert command['data']['type'] == 'COMPOSE', command
            assert command['data']['composition'] == 'right' and command['data']['framing'] == 'half', command
        vision = upload('/api/ai/vision', 'image', 'portrait.jpg', 'image/jpeg',
                        (ROOT / 'docs/samples/portrait.jpg').read_bytes(), {
                            'frameId': 'sample-portrait', 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            'composition': 'center', 'framing': 'full'})
        assert vision['data']['analysis']['stability'] == 'UNKNOWN'
    speech = {'tested': False, 'reason': '需显式 --speech；不自动调用未配置的语音模型'}
    if args.speech or args.speech_only:
        audio = post('/api/ai/tts', {'text': '请看向镜头，放松肩膀。'})
        assert isinstance(audio, bytes) and audio[:4] == b'RIFF', '本轮 ASR 测试要求 TTS 返回 WAV'
        asr = upload('/api/ai/asr', 'audio', 'guide.wav', 'audio/wav', audio)
        assert asr['data']['text']
        if args.live:
            transcript = asr['data']['text'].replace('鏡頭', '镜头')
            assert '镜头' in transcript and '肩膀' in transcript, '真实转写缺少测试句的关键词，请检查语音效果'
            (ROOT / 'docs/model-tts-preview.local.wav').write_bytes(audio)
        speech = {'tested': True, 'mode': asr['mode'], 'transcript': asr['data']['text'], 'audioBytes': len(audio)}
    after = call('/api/device/status')
    assert (before['x'], before['y'], before['state']) == (after['x'], after['y'], after['state']), 'AI 接口不应执行设备动作'
    report = {'testedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': status['mode'],
              'command': command, 'vision': vision, 'speech': speech,
              'deviceUnchanged': True, 'statusAfter': call('/api/ai/status')}
    (ROOT / 'docs/model-test-results.local.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('检查未通过：' + str(error))
