import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('asr_bootstrap', Path(__file__).resolve().parents[1] / 'scripts/start_local_asr.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def run_case(self, complete, probe=0, install=0):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / 'models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
            model.mkdir(parents=True)
            if complete:
                for name in ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt', 'download-manifest.json']:
                    (model / name).write_bytes(b'x' * 2048)
            python = root / '.venv-asr' / ('Scripts/python.exe' if bootstrap.os.name == 'nt' else 'bin/python')
            python.parent.mkdir(parents=True); python.touch()
            results = [SimpleNamespace(returncode=probe), SimpleNamespace(returncode=install)]
            with patch.object(bootstrap, '__file__', str(root / 'scripts/start_local_asr.py')), \
                 patch.object(bootstrap.sys, 'argv', ['start_local_asr.py', '--port', '19001']), \
                 patch.object(bootstrap.subprocess, 'run', side_effect=results) as run, \
                 patch.object(bootstrap.os, 'execv') as execute, patch.object(bootstrap, 'report') as report:
                result = bootstrap.main()
                return result, run.call_args_list, execute.call_args_list, report.call_args_list

    def test_missing_lfs_weights_do_not_install_or_launch(self):
        result, calls, execution, messages = self.run_case(False)
        self.assertEqual(result, 1); self.assertFalse(calls); self.assertFalse(execution)
        self.assertIn('git lfs pull', messages[0].args[0])

    def test_existing_environment_launches_requested_port_without_install(self):
        result, calls, execution, _ = self.run_case(True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(execution[0].args[1][-2:], ['--port', '19001'])

    def test_missing_dependencies_install_once_then_launch(self):
        _, calls, execution, _ = self.run_case(True, probe=1)
        self.assertEqual(len(calls), 2); self.assertIn('pip', calls[1].args[0])
        self.assertEqual(calls[1].kwargs['timeout'], 150); self.assertEqual(len(execution), 1)

    def test_install_failure_does_not_launch(self):
        result, calls, execution, messages = self.run_case(True, probe=1, install=1)
        self.assertEqual(result, 1); self.assertEqual(len(calls), 2); self.assertFalse(execution)
        self.assertIn('依赖安装失败', messages[-1].args[0])
