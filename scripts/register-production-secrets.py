"""Owner-only secret input and upload to an undeployed production version."""

import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import warnings


BINDINGS = (
    "BETTER_AUTH_SECRET",
    "ACCOUNT_BOOTSTRAP_SECRET",
    "AI_GATEWAY_AUTH_SECRET",
    "GEMINI_API_KEY",
    "TYPESAFE_API_KEY",
)
ROOT = Path(__file__).resolve().parent.parent


def upload(secrets):
    """Keep the file private and temporary; never put values in argv or output."""
    env = os.environ.copy()
    env["ACCOUNT_D1_ID"] = "a8af09b1-86b0-4e09-8e89-0ad78e81e705"
    env["ACCOUNT_D1_NAME"] = "kakeimatch-prod-account"
    with tempfile.TemporaryDirectory(prefix="kakeimatch-owner-secrets-", dir="/tmp") as directory:
        path = Path(directory) / "secrets.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as file:
            json.dump(secrets, file)
        result = subprocess.run(
            [
                "corepack", "pnpm", "--dir", str(ROOT / "apps/pwa"), "exec",
                "cf", "workers", "versions", "create", "--mode",
                "production-deploy", "--secrets-file", str(path),
                "--message", "Owner registered production secrets; not deployed",
            ],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        output = result.stdout
        for value in sorted(secrets.values(), key=len, reverse=True):
            output = output.replace(value, "<REDACTED>")
        print(output, end="")
        return result.returncode


def main():
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        print("本人の対話ターミナルで実行してください。", file=sys.stderr)
        return 2
    print("本番secret5個を非表示で入力します。未公開versionへ登録し、本番公開は行いません。")
    secrets = {}
    try:
        # Refuse getpass's fallback to echoed input.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            for binding in BINDINGS:
                while True:
                    value = getpass.getpass(f"{binding}: ")
                    if not value.strip():
                        print("空の値は登録できません。")
                    elif binding in BINDINGS[:3] and len(value) < 32:
                        print("認証用secretは32文字以上で入力してください。")
                    else:
                        secrets[binding] = value
                        break
        code = upload(secrets)
        if code == 0:
            print("未公開versionへの登録が完了しました。version IDと完了の報告だけをCodexへ伝えてください。")
        else:
            print("登録に失敗しました。秘密値を含めず、エラーだけを報告してください。", file=sys.stderr)
        return code
    except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
        print("\n入力を中止しました。", file=sys.stderr)
        return 1
    except OSError:
        print("CLIの起動または一時ファイル操作に失敗しました。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
