#!/usr/bin/env python3
"""Loopback-only incremental Zipformer service; audio and transcripts stay in memory."""
import argparse
import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
import uuid

import numpy as np
import sherpa_onnx

MODEL = 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'

class Sessions:
    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.items = {}
        self.lock = threading.RLock()

    def create(self):
        with self.lock:
            self.items = {key: item for key, item in self.items.items() if time.monotonic() - item['at'] < 60}
            if len(self.items) >= 4:
                raise ValueError('本机 ASR 会话已满，请关闭其他录音页面。')
            key = str(uuid.uuid4())
            self.items[key] = {'stream': self.recognizer.create_stream(), 'at': time.monotonic(), 'segment': 0, 'last': ''}
            return key

    def process(self, key, action, audio=b''):
        with self.lock:
            if key not in self.items or time.monotonic() - self.items[key]['at'] >= 60:
                self.items.pop(key, None)
                raise KeyError('本机 ASR 会话已过期，请重新开启麦克风。')
            item = self.items[key]
            item['at'] = time.monotonic()
            if action == 'reset':
                item.update(stream=self.recognizer.create_stream(), last='', segment=item['segment'] + 1)
                return []
            if not audio or len(audio) > 32768 or len(audio) % 4:
                raise ValueError('音频块须为不超过 32768 字节的 16kHz float32 PCM。')
            samples = np.frombuffer(audio, dtype='<f4')
            if not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1.01:
                raise ValueError('PCM 音频值无效。')
            stream = item['stream']
            stream.accept_waveform(16000, samples)
            while self.recognizer.is_ready(stream):
                self.recognizer.decode_stream(stream)
            text = self.recognizer.get_result(stream).strip()
            final = self.recognizer.is_endpoint(stream)
            results = []
            if text and (text != item['last'] or final):
                results.append({'text': text, 'final': final, 'segment': item['segment']})
                item['last'] = text
            if final:
                self.recognizer.reset(stream)
                item.update(segment=item['segment'] + 1, last='')
            return results

def make_handler(sessions):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Do not log audio, transcript, session identifiers, or request bodies.

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path != '/health':
                return self.reply(404, {'message': 'Not found'})
            self.reply(200, {'ready': True, 'model': MODEL, 'mode': 'LOCAL', 'sampleRate': 16000})

        def do_POST(self):
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 0 or length > 32768:
                    return self.reply(413, {'message': '音频块过大。'})
                body = self.rfile.read(length)
                if self.path == '/sessions':
                    if self.headers.get('Content-Type') != 'application/json':
                        return self.reply(415, {'message': 'JSON required'})
                    data = json.loads(body)
                    if data.get('sampleRate') != 16000:
                        raise ValueError('仅支持 16kHz PCM。')
                    return self.reply(200, {'id': sessions.create(), 'model': MODEL, 'mode': 'LOCAL', 'sampleRate': 16000})
                pieces = self.path.strip('/').split('/')
                if len(pieces) != 3 or pieces[0] != 'sessions' or pieces[2] not in ('audio', 'reset'):
                    return self.reply(404, {'message': 'Not found'})
                expected = 'application/octet-stream' if pieces[2] == 'audio' else 'application/json'
                if self.headers.get('Content-Type') != expected:
                    return self.reply(415, {'message': 'Unexpected content type'})
                results = sessions.process(pieces[1], pieces[2], body)
                self.reply(200, {'results': results, 'mode': 'LOCAL'})
            except KeyError:
                self.reply(409, {'message': '本机识别会话已过期，请重新开启麦克风。'})
            except (ValueError, json.JSONDecodeError) as error:
                self.reply(400, {'message': str(error)[:150]})
            except Exception:
                self.reply(500, {'message': '本机 ASR 推理失败，请检查服务控制台。'})

        def do_DELETE(self):
            pieces = self.path.strip('/').split('/')
            if len(pieces) != 2 or pieces[0] != 'sessions':
                return self.reply(404, {'message': 'Not found'})
            with sessions.lock:
                sessions.items.pop(pieces[1], None)
            self.reply(200, {'closed': True})
    return Handler

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=int(os.environ.get('LENSMIND_LOCAL_ASR_PORT', '9001')))
    parser.add_argument('--model-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'models' / MODEL)
    args = parser.parse_args()
    names = ['tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx']
    if not all((args.model_dir / name).is_file() for name in names):
        parser.error('模型缺失，请先运行 python scripts/setup_local_asr.py')
    manifest = args.model_dir / 'download-manifest.json'
    if not manifest.is_file():
        parser.error('模型校验文件缺失，请运行 python scripts/setup_local_asr.py')
    expected = json.loads(manifest.read_text())['sha256']
    if any(hashlib.sha256((args.model_dir / name).read_bytes()).hexdigest() != expected.get(name) for name in names):
        parser.error('模型哈希不匹配或仍为 LFS 指针，请运行 git lfs pull 或模型下载脚本')
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(args.model_dir / names[0]), encoder=str(args.model_dir / names[1]),
        decoder=str(args.model_dir / names[2]), joiner=str(args.model_dir / names[3]),
        num_threads=2, sample_rate=16000, feature_dim=80, provider='cpu',
        decoding_method='greedy_search', enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=0.6, rule3_min_utterance_length=15)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(Sessions(recognizer)))
    server.daemon_threads = True
    print(f'LensMind local streaming ASR ready: http://127.0.0.1:{args.port} ({MODEL})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
