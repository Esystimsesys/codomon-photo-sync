#!/usr/bin/env python3
"""指定した人物と識別された写真を、みてね（家族アルバム みてね）へアップロードする。

方式:
  みてねWeb版のアップロード画面をブラウザ操作する。
  内部的には signed_upload_url を取得して S3 へ直接PUTする作りだが、
  UI操作なら set_input_files → 公開範囲ボタンの2手で完結し、
  未知のAPI仕様を推測で埋める必要がないためUI方式を採る。

認証:
  reCAPTCHA と2要素認証（OTP）があるため**自動ログインはできない**。
  --login で画面を出して手動ログインし、セッションを保存して使い回す。
  セッションの寿命は実測で約2週間。切れたら再度 --login が必要。

アップロード済みの管理:
  みてね側のデータは一切参照せず、ローカルの台帳（mitene_uploaded.json）で管理する。
  アップロード後にファイル名やメタデータが変わっても影響を受けない。

使い方:
  .venv/bin/python3 mitene_upload.py --login    # 手動ログイン（初回・セッション失効時）
  .venv/bin/python3 mitene_upload.py --seed     # 現状を「対応済み」として記録（アップロードしない）
  .venv/bin/python3 mitene_upload.py --dry-run  # 対象を数えるだけ
  .venv/bin/python3 mitene_upload.py            # 未アップロード分を送信
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

from common import (atomic_write_text, config_save_root, harden_umask,
                    job_lock, load_config, rotate_log)

HERE = Path(__file__).parent
STATE_FILE = HERE / "mitene_state.json"       # ログインセッション（0600）
LEDGER = HERE / "mitene_uploaded.json"        # アップロード済みの台帳
LOG_FILE = HERE / "sync.log"
LAST_REFRESH = HERE / ".last_session_refresh"  # セッション延命の実行間隔の管理用

UPLOADER_URL = "https://mitene.us/web/uploader"
_CFG = load_config()
SOURCE_ROOT = config_save_root(_CFG)

# 1回の実行で送る枚数の上限。まとめて渡しすぎると失敗時の切り分けが難しいため。
BATCH = 20
# 既定の公開範囲。検証時は「管理者のみ」を使える。
SCOPE_DEFAULT = _CFG["mitene_scope"]

# 失効時にユーザーが打つコマンド。メッセージ内で必ず案内する。
RECOVER_CMD = "cd ~/Documents/Development/codomon-photo-sync && .venv/bin/python3 mitene_upload.py --login"


def log(message: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} みてね: {message}"
    print(line)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_ledger() -> set[str]:
    if not LEDGER.exists():
        return set()
    return set(json.loads(LEDGER.read_text(encoding="utf-8")))


def save_ledger(names: set[str]) -> None:
    atomic_write_text(LEDGER, json.dumps(sorted(names), ensure_ascii=False, indent=2),
                      mode=0o644)


def person_files(person: str) -> list[Path]:
    """指定人物と識別された写真のローカルパス一覧。

    判定は export_person.py と同じく写真.appのライブラリDBから行う。
    mode=ro で開くこと（immutable=1 は WAL を無視して古い結果を返す）。
    """
    db = Path.home() / "Pictures/Photos Library.photoslibrary/database/Photos.sqlite"
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    pk = con.execute(
        "select Z_PK from ZGENERICALBUM where ZTITLE=? and ZTRASHEDSTATE=0", (_CFG["album"],)).fetchone()[0]
    rows = con.execute("""
        select distinct aa.ZORIGINALFILENAME
        from ZDETECTEDFACE f
        join Z_33ASSETS a on a.Z_3ASSETS = f.ZASSETFORFACE
        join ZADDITIONALASSETATTRIBUTES aa on aa.ZASSET = f.ZASSETFORFACE
        join ZPERSON p on p.Z_PK = f.ZPERSONFORFACE
        where a.Z_33ALBUMS = ? and p.ZFULLNAME = ?
    """, (pk, person)).fetchall()
    names = {r[0] for r in rows if r[0]}
    index = {p.name: p for p in SOURCE_ROOT.glob("*/*.jpeg")}
    return sorted((index[n] for n in names if n in index), key=lambda p: (p.parent.name, p.name))


def manual_login(wait_seconds: int = 600) -> int:
    """画面を出して手動ログインしてもらい、セッションを保存する。

    reCAPTCHA と2要素認証があるため、この工程だけは自動化できない。
    """
    with sync_playwright() as p:
        b = p.chromium.launch(headless=False, args=["--start-maximized"])
        ctx = b.new_context(locale="ja-JP", viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.goto("https://mitene.us/web/login", wait_until="domcontentloaded", timeout=60000)
        page.bring_to_front()
        subprocess.run(["osascript", "-e",
                        'tell application "System Events" to set frontmost of '
                        '(first process whose name is "Google Chrome for Testing") to true'],
                       capture_output=True)
        log(f"ログイン画面を表示しました。『Google Chrome for Testing』で"
            f"ログイン（＋OTP入力）を完了してください（最大{wait_seconds // 60}分）")

        ok = False
        for i in range(wait_seconds // 3):
            page.wait_for_timeout(3000)
            try:
                urls = [pg.url for pg in ctx.pages]
            except Exception:
                log("ブラウザが閉じられました")
                break
            # ログイン画面・OTP画面のどちらでもない場所に着いたら完了
            if [u for u in urls
                    if "mitene.us" in u and "/web/login" not in u and "/web/otp" not in u]:
                ok = True
                break

        if not ok:
            log("ログインを確認できませんでした")
            b.close()
            return 1

        page.wait_for_timeout(5000)
        ctx.storage_state(path=str(STATE_FILE))
        os.chmod(STATE_FILE, stat.S_IRUSR | stat.S_IWUSR)
        exp = max((c.get("expires", 0) for c in
                   json.loads(STATE_FILE.read_text())["cookies"]
                   if c["name"] in ("web_session", "_mitene_session")), default=0)
        when = f"{datetime.fromtimestamp(exp):%Y-%m-%d}" if exp > 0 else "不明"
        log(f"セッションを保存しました（0600 / 有効期限の目安: {when}）")
        b.close()
    return 0


class SessionExpired(RuntimeError):
    """セッションが切れていて再ログインが必要な状態。"""


def notify(message: str) -> None:
    """macOSの通知を出す。定期実行は無人のことが多く、ログだけでは気づけないため。"""
    # 文字列を埋め込まず引数で渡す（将来ファイル名等を混ぜても壊れない）
    subprocess.run(
        ["osascript", "-e",
         'on run argv\n display notification (item 1 of argv) '
         'with title "コドモン→みてね"\nend run', message],
        capture_output=True)


def save_session(ctx) -> None:
    """サーバーが更新したCookieを書き戻す。

    みてねのセッションは**最終アクセスから14日**のスライド式。
    アクセスするたびに期限が延びるので、更新後の状態を保存しておけば
    定期実行が続く限りセッションは切れない。書き戻さないとこの延長を捨てることになる。
    """
    ctx.storage_state(path=str(STATE_FILE))
    os.chmod(STATE_FILE, stat.S_IRUSR | stat.S_IWUSR)


def refresh_session() -> bool:
    """アップロード対象が無い日もセッションを延命させる。

    送信が無い日が14日続くとセッションが切れてしまうため、
    ページを1回開いて期限を延ばすだけの軽い処理を回す。
    """
    if not STATE_FILE.exists():
        return False
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(storage_state=str(STATE_FILE), locale="ja-JP")
        page = ctx.new_page()
        page.goto(UPLOADER_URL, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(3000)
        alive = "/web/login" not in page.url and "/web/otp" not in page.url
        if alive:
            save_session(ctx)
        b.close()
    return alive


def upload(files: list[Path], scope: str, on_uploaded) -> list[Path]:
    """まとめてアップロードする。成功したファイルを返す。"""
    if not STATE_FILE.exists():
        raise SessionExpired(f"セッションがありません: {RECOVER_CMD}")

    done: list[Path] = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(storage_state=str(STATE_FILE), locale="ja-JP")
        page = ctx.new_page()
        page.goto(UPLOADER_URL, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(3000)

        if "/web/login" in page.url or "/web/otp" in page.url:
            b.close()
            raise SessionExpired(f"セッションが失効しています: {RECOVER_CMD}")

        for i in range(0, len(files), BATCH):
            chunk = files[i:i + BATCH]
            page.set_input_files("input[type=file]", [str(f) for f in chunk])
            page.wait_for_timeout(3000 + 500 * len(chunk))

            # 公開範囲は誤ると家族以外に見える事故になるため完全一致で選ぶ。
            # 既定の部分一致だと「家族みんなに公開しない」等が増えたとき誤爆する。
            btn = page.get_by_role("button", name=scope, exact=True)
            n = btn.count()
            if n != 1:
                log(f"警告: 公開範囲ボタン「{scope}」が{n}個見つかりました。"
                    f"誤送信を避けるため中断します")
                break
            btn.click()

            # 「N点のアップロードが完了しました」が出るまで待つ
            ok = False
            for _ in range(60):
                page.wait_for_timeout(2000)
                if re.search(r"アップロードが完了", page.inner_text("body")):
                    ok = True
                    break
            if ok:
                done += chunk
                # 送信できた分はその場で確定させる。ここで確定しないと、
                # 直後のページ遷移がタイムアウトしただけで成功分が失われ、
                # 次回に同じ写真をもう一度みてねへ送ってしまう。
                on_uploaded(chunk)
                log(f"{len(chunk)} 枚をアップロードしました（{scope}）")
                page.goto(UPLOADER_URL, wait_until="networkidle", timeout=60000)
                page.wait_for_timeout(2000)
            else:
                log(f"警告: {len(chunk)} 枚のアップロード完了を確認できませんでした")
                break
        save_session(ctx)          # 延長された期限を保存する
        b.close()
    return done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--person", default=_CFG["person"])
    ap.add_argument("--login", action="store_true", help="手動ログインしてセッションを保存")
    ap.add_argument("--seed", action="store_true",
                    help="現在の対象すべてを『アップロード済み』として記録（送信しない）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--scope", default=SCOPE_DEFAULT,
                    help="公開範囲のボタン名（検証時は『管理者のみ』）")
    ap.add_argument("--limit", type=int, default=0, help="1回の実行で送る最大枚数")
    args = ap.parse_args()

    if args.login:
        return manual_login()

    files = person_files(args.person)
    ledger = load_ledger()
    todo = [f for f in files if f.name not in ledger]

    if args.seed:
        save_ledger({f.name for f in files})
        log(f"{len(files)} 枚を『アップロード済み』として記録しました（送信していません）")
        return 0

    log(f"対象 {len(files)} 枚 / 未アップロード {len(todo)} 枚")
    if args.dry_run:
        return 0

    if not todo:
        # 送信が無い日が続くとセッションが切れるため、1日1回だけ延命しておく。
        age = (datetime.now().timestamp() - LAST_REFRESH.stat().st_mtime
               if LAST_REFRESH.exists() else 1e9)
        if age > 20 * 3600:
            alive = refresh_session()
            if alive:
                LAST_REFRESH.touch()   # 失敗時は更新しない（毎回気づけるように）
            log("セッションを延命しました" if alive
                else f"セッションが失効しています。{RECOVER_CMD}")
            if not alive:
                notify("みてねへの再ログインが必要です")
                return 1
        return 0

    if args.limit:
        todo = todo[:args.limit]

    def commit(chunk):
        nonlocal ledger
        ledger = ledger | {f.name for f in chunk}
        save_ledger(ledger)

    try:
        done = upload(todo, args.scope, commit)
    except SessionExpired:
        # 復旧にはOTP入力が要るので自動化しない。何をすればよいかだけ明示して止める。
        log(f"セッションが失効しています。{len(todo)} 枚が未送信です。"
            f"次を実行して再ログインしてください: {RECOVER_CMD}")
        notify(f"再ログインが必要です（{len(todo)}枚が未送信）")
        return 1

    log(f"完了: {len(done)} 枚を送信 / 残り {len(todo) - len(done)} 枚")
    return 0 if len(done) == len(todo) else 1


def _guarded() -> int:
    """排他ロックを取ってから実行する。

    launchd はラベルが違うジョブの同時実行を防がない。スリープ復帰時に
    17:30 と 7/13/19/21 時の分がまとめて発火すると両方が走り、
    写真.appのアルバム操作や台帳の read-modify-write が競合する。
    """
    harden_umask()
    rotate_log(LOG_FILE)
    with job_lock() as got:
        if not got:
            log("別のジョブが実行中のためスキップしました")
            return 0
        return main()


if __name__ == "__main__":
    try:
        sys.exit(_guarded())
    except Exception as e:  # noqa: BLE001
        log(f"エラー: {e}")
        sys.exit(1)
