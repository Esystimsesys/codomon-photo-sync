#!/usr/bin/env python3
"""各スクリプトで共有する下回りの処理。

- アトミックな書き込み（中断で壊れたファイルを残さない）
- ジョブ間の排他ロック
- ログのローテーション
"""

from __future__ import annotations

import fcntl
import os
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).parent
LOCK_FILE = HERE / ".job.lock"
CONFIG_FILE = HERE / "config.json"
LOG_MAX_BYTES = 5 * 1024 * 1024      # 5MB を超えたら1世代だけ退避する


def load_config() -> dict:
    """config.json を読む。無ければ config.example.json の既定値で動く。

    子どもの名前・アルバム名といった個人に紐づく値をソースへ書かないための仕組み。
    """
    import json
    defaults = {
        "person": "", "album": "コドモン", "person_album": None,
        # 保存先はアルバム名から導出しない（アルバム名は日本語、フォルダは英数）
        "save_root": "~/Pictures/codomon", "days_to_check": 30,
        "mitene_scope": "家族みんなに公開",
    }
    if CONFIG_FILE.exists():
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        defaults.update({k: v for k, v in raw.items() if not k.startswith("_")})
    return defaults


def config_person_album(cfg: dict) -> str:
    return cfg.get("person_album") or f"{cfg['album']}（{cfg['person']}）"


def config_save_root(cfg: dict) -> Path:
    return Path(cfg.get("save_root") or "~/Pictures/codomon").expanduser()


def atomic_write_bytes(path: Path, data: bytes, mode: int = 0o600) -> None:
    """同一ディレクトリの一時ファイルへ書いてから置き換える。

    途中で電源が落ちても、中途半端な内容のファイルが残らない。
    写真は一度保存されると dest.exists() で二度と再取得されないため、
    切り詰められたJPEGが残ると永久に修復されなくなる。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)        # 同一FS内なのでアトミック
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str, mode: int = 0o600) -> None:
    atomic_write_bytes(path, text.encode("utf-8"), mode)


@contextmanager
def job_lock(timeout_note: str = ""):
    """同時実行を防ぐ。取得できなければ False を返す。

    launchd は同一ラベルの多重起動は防ぐが、ラベルの違う2ジョブは防がない。
    スリープ復帰時に取りこぼした時刻がまとめて発火すると、本体(17:30)と
    人物アルバム(7/13/19/21時)が同時に走り、写真.appのアルバム操作や
    台帳の read-modify-write が競合する。
    """
    # 親プロセスが既にロックを持っている場合（sync_photos.py が
    # export_person.py を子プロセスで呼ぶ経路）は、二重取得を試みると
    # 自分自身とぶつかって処理がスキップされてしまう。環境変数で引き継ぐ。
    if os.environ.get("CODOMON_LOCK_HELD") == "1":
        yield True
        return

    LOCK_FILE.touch(exist_ok=True)
    f = LOCK_FILE.open("w")
    try:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        os.environ["CODOMON_LOCK_HELD"] = "1"   # 子プロセスへ引き継ぐ
        yield True
    finally:
        os.environ.pop("CODOMON_LOCK_HELD", None)
        try:
            fcntl.flock(f, fcntl.LOCK_UN)
        finally:
            f.close()


def rotate_log(path: Path, max_bytes: int = LOG_MAX_BYTES) -> None:
    """ログが肥大化したら1世代だけ退避する。

    1日5回の実行で無制限に伸びるため。世代を増やしても読まないので1世代で足りる。
    """
    try:
        if path.exists() and path.stat().st_size > max_bytes:
            os.replace(path, path.with_suffix(path.suffix + ".1"))
    except OSError:
        pass


def harden_umask() -> None:
    """このプロセスが作るファイルを最初から本人のみ読み書き可能にする。

    書き出してから chmod する方式だと、その一瞬だけ他ユーザーから読める。
    セッションCookieやメールアドレスの写ったスクリーンショットを扱うため潰しておく。
    """
    os.umask(0o077)


def secure_existing(path: Path) -> None:
    """既存ファイルの権限を 0600 に揃える。"""
    try:
        if path.exists():
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
