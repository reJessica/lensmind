#!/usr/bin/env python3
"""只读查询模型列表，不打印密钥，不执行付费生成。Python 3 标准库即可运行。"""
import json
import os
import argparse
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def local_properties():
    path = ROOT / 'config/ai-local.properties'
    result = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith(('#', '!')) and '=' in line:
                k, v = line.split('=', 1)
                result[k.strip()] = v.strip()
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', choices=['chat', 'uniapi'], default='chat')
    parser.add_argument('--all', action='store_true', help='列出全部模型 ID，不只按名称筛选')
    args = parser.parse_args()
    if args.provider == 'uniapi':
        key = os.environ.get('LENSMIND_UNIAPI_KEY') or local_properties().get('lensmind.uniapi-key')
        address = 'https://api.uniapi.io/v1/models'
    else:
        key = os.environ.get('LENSMIND_API_KEY') or local_properties().get('lensmind.api-key')
        address = 'https://zgc.apihy.com/v1/models'
    if not key:
        raise SystemExit('本机尚未配置 API Key；请填写 config/ai-local.properties。')
    request = urllib.request.Request(address, headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)
        names = sorted(item['id'] for item in data.get('data', []) if isinstance(item, dict) and isinstance(item.get('id'), str))
        matching = names if args.all else [name for name in names if any(word in name.lower() for word in ('qwen', 'asr', 'tts', 'whisper', 'cosyvoice', 'speech', 'audio', 'sensevoice', 'funasr'))]
        print(json.dumps({'provider': args.provider, 'total': len(names), 'models' if args.all else 'relevant_models': matching,
                          'notice': '名称筛选和列表可见性不代表实际接口能力或账号通道可用性，需结合官方文档与少量真实调用。'}, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        raise SystemExit('模型列表请求失败：HTTP ' + str(error.code) + '（未打印供应商响应或密钥）')
    except Exception:
        raise SystemExit('无法获取模型列表，请检查网络或代理；未打印包含请求信息的异常。')

if __name__ == '__main__':
    main()
