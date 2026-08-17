#!/usr/bin/env python3
"""顔認識の結果を反映し、未アップロード分をみてねへ送る。

1日4回まわす想定。写真.appの顔解析は取り込み直後には終わらず
（実測で最短50分・多くは数時間）、この2つは解析の完了に追随させたいため
本体(17:30)とは別ジョブにしている。

なぜシェルスクリプトではなくPythonか:
  launchd からシェルスクリプトを起動すると /bin/bash が ~/Documents 配下の
  ファイルを読もうとして書類フォルダのTCC保護に阻まれる（Operation not permitted）。
  venv の python を直接 ProgramArguments に指定する形なら通る。

みてねのセッションは約2週間で切れる。切れた場合はアップロードだけが失敗し、
人物アルバムの更新は成功したまま残る（意図的な設計）。
復旧するには: .venv/bin/python3 mitene_upload.py --login
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
PY = sys.executable

TASKS = [
    ([str(HERE / "export_person.py"), "--no-copy"], "人物アルバムの更新"),
    ([str(HERE / "mitene_upload.py")], "みてねへのアップロード"),
]


def main() -> int:
    failed = []
    for args, label in TASKS:
        try:
            r = subprocess.run([PY, *args], capture_output=True, text=True, timeout=3600)
        except subprocess.TimeoutExpired:
            # ここで例外を抜けさせると後続のタスクが実行されない。
            # 失敗として記録し、次のタスクへ進む。
            failed.append(label)
            print(f"{label} がタイムアウトしました", file=sys.stderr)
            continue
        # 各スクリプトが自分で sync.log に書くので、ここでは失敗時のみ拾う
        if r.returncode != 0:
            failed.append(label)
            err = (r.stderr or r.stdout).strip()[:200]
            print(f"{label} が失敗しました: {err}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
