#!/usr/bin/env python3
"""Download the pinned upstream model. Only four known files are extracted."""
import hashlib
import argparse
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
URL = f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{MODEL}.tar.bz2'
FILES = ('encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    target = ROOT / 'models' / MODEL
    target.mkdir(parents=True, exist_ok=True)
    archive = target / 'download.tar.bz2'
    manifest = target / 'download-manifest.json'
    expected = json.loads(manifest.read_text())['sha256'] if manifest.is_file() else {}
    def valid():
        return all((target / name).is_file() and (target / name).stat().st_size > 1000
                   and (not expected.get(name) or hashlib.sha256((target / name).read_bytes()).hexdigest() == expected[name]) for name in FILES)
    if not valid():
        if args.verify_only:
            raise SystemExit('Model files missing or corrupt. Run git lfs pull or rerun this script without --verify-only.')
        print(f'Downloading {MODEL} from upstream GitHub release…', flush=True)
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open('wb') as out:
            shutil.copyfileobj(response, out)
        with tarfile.open(archive, 'r:bz2') as source:
            for name in FILES:
                member = source.getmember(f'{MODEL}/{name}')
                if not member.isfile() or member.size > 250_000_000:
                    raise ValueError('Unexpected archive member')
                with source.extractfile(member) as inp, (target / (name + '.part')).open('wb') as out:
                    shutil.copyfileobj(inp, out)
                (target / (name + '.part')).replace(target / name)
        archive.unlink()
    digests = {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in FILES}
    if expected and digests != expected:
        raise SystemExit('Model checksum mismatch; model not accepted.')
    manifest.write_text(json.dumps({'model': MODEL, 'source': URL, 'sha256': digests}, indent=2))
    print(f'Model ready: {target}', flush=True)

if __name__ == '__main__':
    main()
