"""導入と監視の回帰テスト。OS・ブラウザ・実設定には触れない。"""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import sys
import types
import unittest
from datetime import datetime
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load_module("setup_under_test", "setup.py")
fake_common = types.ModuleType("common")
fake_common.load_config = lambda: {"job_labels": list(setup.JOBS)}
with patch.dict(sys.modules, {"common": fake_common}):
    health = load_module("health_under_test", "healthcheck.py")


class ChromiumTests(unittest.TestCase):
    def test_probe_uses_venv_and_launches_headless_with_timeout(self):
        with patch.object(setup, "run", return_value=Mock(returncode=0)) as run:
            self.assertTrue(setup.check_chromium()[0])
        argv = run.call_args.args[0]
        self.assertEqual(argv[:2], [str(setup.VENV_PY), "-c"])
        self.assertIn("headless=True", argv[2])
        self.assertIn("browser.close()", argv[2])
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def test_old_cache_cannot_override_launch_failure(self):
        with patch.object(setup, "run", return_value=Mock(returncode=1)):
            self.assertFalse(setup.check_chromium()[0])

    def test_missing_python_and_timeout_are_failures(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("probe", 30)):
            with self.subTest(error=error), patch.object(setup, "run", side_effect=error):
                self.assertFalse(setup.check_chromium()[0])


class ScheduleTests(unittest.TestCase):
    def test_registration_continues_after_first_failure(self):
        with patch.object(setup, "VENV_PY") as python, \
                patch.object(setup, "LOG_DIR"), \
                patch.object(setup, "stale_plists", return_value=[]), \
                patch.object(setup, "load_config", return_value={}), \
                patch.object(setup, "say"), \
                patch.object(setup, "load_job", side_effect=[False, True, True]) as load:
            python.exists.return_value = True
            self.assertEqual(setup.cmd_schedule(argparse.Namespace(quiet=True)), 1)
        self.assertEqual([call.args[0] for call in load.call_args_list], list(setup.JOBS))

    def test_install_propagates_registration_failure(self):
        with patch.object(setup, "check_macos", return_value=(True, "", "")), \
                patch.object(setup, "check_python", return_value=(True, "", "")), \
                patch.object(setup, "build_venv", return_value=True), \
                patch.object(setup, "setup_config", return_value={}), \
                patch.object(setup, "setup_keychain"), \
                patch.object(setup, "check_full_disk_access", return_value=(True, "", "")), \
                patch.object(setup, "cmd_schedule", return_value=1), \
                patch.object(setup, "say"), patch.object(setup, "head") as head:
            self.assertEqual(setup.cmd_install(argparse.Namespace(yes=True)), 1)
        self.assertNotIn("完了", [call.args[0] for call in head.call_args_list])


class HealthTests(unittest.TestCase):
    def check(self, codes):
        with patch.object(health, "exit_codes", return_value=codes) as read, \
                patch.object(health, "last_activity", return_value=datetime.now()), \
                patch.object(health, "record"), patch.object(health, "notify"), \
                patch.object(sys, "stderr"):
            result = health.main()
        read.assert_called_once_with()
        return result

    def test_previous_monitor_failure_does_not_latch(self):
        codes = dict.fromkeys(health.JOBS, "0")
        codes["com.codomon-photo-sync.healthcheck"] = "1"
        self.assertEqual(self.check(codes), 0)

    def test_work_job_failure_still_detected(self):
        codes = dict.fromkeys(health.JOBS, "0")
        codes["com.codomon-photo-sync.sync"] = "78"
        self.assertEqual(self.check(codes), 1)

    def test_missing_monitor_still_detected(self):
        codes = dict.fromkeys(health.JOBS, "0")
        del codes["com.codomon-photo-sync.healthcheck"]
        self.assertEqual(self.check(codes), 1)


if __name__ == "__main__":
    unittest.main()
