#!/usr/bin/env python3
"""Verify two incremental utterances through Spring Boot without cloud calls or device actions."""
import argparse
import http.cookiejar
import io
import json
import struct
import time
import urllib.error
import urllib.request
import wave

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8080')
    parser.add_argument('--wav', required=True, help='16kHz mono 16-bit PCM test recording')
    args = parser.parse_args()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def request(path, data=None, kind='application/json', method=None):
        with opener.open(urllib.request.Request(args.base_url + path, data=data, headers={'Content-Type': kind}, method=method), timeout=10) as response:
            return json.load(response)
    before = request('/api/ai/status')['liveCallAttempts']
    session = request('/api/ai/local-asr/session', b'{"sampleRate":16000}')
    suffix = '?connectionId=' + session['id']
    with wave.open(args.wav) as recording:
        if (recording.getframerate(), recording.getnchannels(), recording.getsampwidth()) != (16000, 1, 2):
            raise ValueError('Expected 16kHz mono 16-bit WAV')
        data = recording.readframes(recording.getnframes())
    samples = [value / 32768 for value in struct.unpack('<' + 'h' * (len(data) // 2), data)] + [0.0] * 16000
    results, partial_at = [], None
    started = time.monotonic()
    try:
        for turn in range(2):
            for index in range(0, len(samples), 1600):
                block = samples[index:index + 1600]
                result = request('/api/ai/local-asr/audio' + suffix, struct.pack('<' + 'f' * len(block), *block), 'application/octet-stream')
                assert result['mode'] == 'LOCAL'
                if partial_at is None and result['results']:
                    partial_at = round((index + len(block)) / 16000, 3)
                results.extend(result['results'])
        finals = [item for item in results if item['final']]
        assert len(finals) == 2 and finals[0]['segment'] != finals[1]['segment'], 'Expected two distinct final utterances'
        assert any(not item['final'] for item in results), 'Expected interim text'
        assert request('/api/ai/status')['liveCallAttempts'] == before, 'Local ASR must not spend cloud budget'
        print(json.dumps({'mode': 'LOCAL', 'finals': finals, 'firstPartialAtAudioSeconds': partial_at,
                          'processingSeconds': round(time.monotonic() - started, 3), 'cloudCallsDelta': 0}, ensure_ascii=False, indent=2))
    finally:
        request('/api/ai/local-asr/session' + suffix, method='DELETE')

if __name__ == '__main__': main()
