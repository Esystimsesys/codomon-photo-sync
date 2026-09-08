#!/usr/bin/env python3
"""定期実行が止まっていないかを見張る。

過去3回の停止（2026-08-07 / 08-17 / 08-23）はいずれも
「ユーザーが『動いてる？』と尋ねて初めて発覚」しており、
最長で29時間気づけなかった。原因を潰しても別の理由で静かに止まるため、
止まったこと自体を検知する層を独立して置く。

このスクリプトは意図的に何にも依存しない:
  - 排他ロックを取らない（読むだけ。本体の実行を妨げない）
  - 写真.app にもネットワークにも触らない
  - 自身のログは ~/Library/Logs に出す（監視対象と同じ死に方をしないため）
"""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from common import load_config

HERE = Path(__file__).parent
SYNC_LOG = HERE / "sync.log"
HEALTH_LOG = Path.home() / "Library/Logs/codomon-photo-sync/health.log"

# launchd のラベルにはユーザー名が含まれるため、ソースに直書きせず設定から読む
JOBS: list[str] = load_config()["job_labels"]

# ジョブは 7/13/17:30/19/21/22 時に走る。最長の間隔は 22:00→翌07:00 の9時間。
# Mac の電源が落ちていた分の猶予を足して18時間を「無音の上限」とする。
STALE_HOURS = 18

TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")


def last_activity() -> datetime | None:
    """sync.log の最終行のタイムスタンプを返す。"""
    if not SYNC_LOG.exists():
        return None
    try:
        lines = SYNC_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        m = TS.match(line)
        if m:
            return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
    return None


def exit_codes() -> dict[str, str]:
    """launchctl list から各ジョブの前回終了コードを拾う。

    0 以外は異常。特に 78(EX_CONFIG) はプログラムが起動すらしておらず、
    ログが1行も残らないため、ログの鮮度だけでは検知が遅れる。
    """
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True,
                             text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    found = {}
    for line in out.splitlines():
        cols = line.split("\t")
        if len(cols) >= 3 and cols[2] in JOBS:
            found[cols[2]] = cols[1]
    return found


def notify(title: str, message: str) -> None:
    """通知センターへ出す。Mac の前にいないことが多いので、戻ったときに気づけるよう毎回出す。"""
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace('"', '\\"')
    script = (f'display notification "{esc(message)}" '
              f'with title "{esc(title)}" sound name "Basso"')
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass


def record(line: str) -> None:
    HEALTH_LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with HEALTH_LOG.open("a", encoding="utf-8") as f:
        f.write(f"{stamp} {line}\n")


def main() -> int:
    problems: list[str] = []

    codes = exit_codes()
    for label, code in codes.items():
        # 自身の前回の異常終了を再検知すると、復旧しても異常が解除されない。
        if label.rsplit(".", 1)[-1] != "healthcheck" and code not in ("0", "-"):
            short = label.rsplit(".", 1)[-1]
            hint = "（EX_CONFIG: プログラムが起動していません）" if code == "78" else ""
            problems.append(f"{short} が終了コード {code} で失敗{hint}")

    missing = [j for j in JOBS if j not in codes]
    if missing:
        problems.append(f"ジョブが登録されていません: {', '.join(m.rsplit('.', 1)[-1] for m in missing)}")

    last = last_activity()
    if last is None:
        problems.append("sync.log から実行時刻を読み取れません")
    else:
        idle = datetime.now() - last
        if idle > timedelta(hours=STALE_HOURS):
            hours = int(idle.total_seconds() // 3600)
            problems.append(f"最後の実行から {hours} 時間経過（最終: {last:%m-%d %H:%M}）")

    if problems:
        body = " / ".join(problems)
        record(f"NG {body}")
        notify("コドモン同期が停止しています", body)
        print(body, file=sys.stderr)
        return 1

    record(f"OK 最終実行 {last:%m-%d %H:%M}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
