"""Synthetic tests only: no Cloudflare requests or production secret input."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "owner_secrets", Path(__file__).with_name("register-production-secrets.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OwnerSecretUploadTest(unittest.TestCase):
    def test_private_temporary_file_and_non_deploying_command(self):
        values = {key: "synthetic-only-" + key for key in module.BINDINGS}
        files = []

        def run(command, **options):
            self.assertEqual(command[6:10], ["workers", "versions", "create", "--mode"])
            self.assertIn("production-deploy", command)
            self.assertNotIn("deploy", command)
            path = Path(command[command.index("--secrets-file") + 1])
            files.append(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertFalse(path.is_relative_to(module.ROOT))
            self.assertEqual(json.loads(path.read_text()), values)
            self.assertEqual(options["env"]["ACCOUNT_D1_NAME"], "kakeimatch-prod-account")
            self.assertEqual(options["env"]["ACCOUNT_D1_ID"], "a8af09b1-86b0-4e09-8e89-0ad78e81e705")
            for value in values.values():
                self.assertNotIn(value, command)
            return subprocess.CompletedProcess(command, 1, " ".join(values.values()))

        output = io.StringIO()
        with patch.object(module.subprocess, "run", side_effect=run), contextlib.redirect_stdout(output):
            self.assertEqual(module.upload(values), 1)
        for path in files:
            self.assertFalse(path.parent.exists())
        for value in values.values():
            self.assertNotIn(value, output.getvalue())

    def test_cleanup_on_interruption(self):
        values = {key: "synthetic-only-" + key for key in module.BINDINGS}
        files = []

        def run(command, **options):
            files.append(Path(command[command.index("--secrets-file") + 1]))
            raise KeyboardInterrupt()

        with patch.object(module.subprocess, "run", side_effect=run):
            with self.assertRaises(KeyboardInterrupt):
                module.upload(values)
        self.assertFalse(files[0].parent.exists())

    def test_noninteractive_execution_does_not_read_or_upload(self):
        with patch.object(module.sys.stdin, "isatty", return_value=False), \
                patch.object(module.getpass, "getpass") as prompt, \
                patch.object(module, "upload") as upload, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(module.main(), 2)
        prompt.assert_not_called()
        upload.assert_not_called()


if __name__ == "__main__":
    unittest.main()
