#!/usr/bin/env python3
"""写真.appで特定の人物と識別されたコドモン写真だけを抜き出す。

写真.app のライブラリDBを読み、「コドモン」アルバム内で指定した人物の顔が
検出されている写真を特定し、ローカルの元ファイルを別フォルダへ複製する。

前提:
  - 写真.appの顔解析が完了していること（未解析だと取りこぼす）
  - このプロセスにフルディスクアクセスがあること（ライブラリDBの読み取りに必要）

使い方:
  .venv/bin/python3 export_person.py             # 既定の人物を書き出し
  .venv/bin/python3 export_person.py --dry-run   # 対象を数えるだけ
  .venv/bin/python3 export_person.py --person 名前
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from common import (config_person_album, config_save_root, harden_umask,
                    job_lock, load_config, rotate_log)

PHOTOS_DB = Path.home() / "Pictures/Photos Library.photoslibrary/database/Photos.sqlite"
_CFG = load_config()
ALBUM = _CFG["album"]
PERSON = _CFG["person"]

# 単独の定期実行（顔解析の反映用）でも記録が残るよう、本体と同じログに書く
LOG_FILE = Path(__file__).parent / "sync.log"


def log(message: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} 人物アルバム: {message}"
    print(line)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass

SOURCE_ROOT = config_save_root(_CFG)
# 出力先は SOURCE_ROOT の外に置くこと。中に置くと sync_photos.py の
# glob("*/*.jpeg") に拾われ、写真.appへ二重に取り込まれてしまう。
DEST_ROOT = SOURCE_ROOT.parent / f"{SOURCE_ROOT.name}-person"


def connect() -> sqlite3.Connection:
    """写真ライブラリのDBを読み取り専用で開く。

    mode=ro を使うこと。immutable=1 は SQLite に WAL を無視させるため、
    写真.app が書いたばかりの変更（新しく識別された顔、作成直後のアルバム）が
    見えず、古いスナップショットを読んでしまう。
    """
    if not PHOTOS_DB.exists():
        raise SystemExit(f"写真ライブラリが見つかりません: {PHOTOS_DB}")
    try:
        return sqlite3.connect(f"file:{PHOTOS_DB}?mode=ro", uri=True)
    except sqlite3.OperationalError as e:
        # WAL のある DB を読み取り専用で開くには -shm が必要。写真.app が
        # 一度も起動していない等で開けない場合は、古い可能性を断ったうえで
        # immutable にフォールバックする。
        log(f"⚠ mode=ro で開けませんでした（{e}）。"
              f"immutable で再試行します（最新の変更が反映されない可能性があります）。")
        try:
            return sqlite3.connect(f"file:{PHOTOS_DB}?immutable=1", uri=True)
        except sqlite3.OperationalError as e2:
            raise SystemExit(
                f"写真ライブラリを開けません（{e2}）。\n"
                "システム設定 → プライバシーとセキュリティ → フルディスクアクセス で\n"
                "このプロセスの実行元に許可を与えてください。"
            )


def album_pk(con: sqlite3.Connection) -> int:
    """アルバムのZ_PKを返す。

    アルバムを作り直すと削除済みのレコードが同名で残る（ZTRASHEDSTATE=1）。
    枚数が多い方を選ぶと削除済みの古い方を掴んでしまうため、必ず
    ZTRASHEDSTATE=0 で絞ること。
    """
    rows = con.execute(
        "select Z_PK from ZGENERICALBUM where ZTITLE = ? and ZTRASHEDSTATE = 0 "
        "order by ZCACHEDCOUNT desc", (ALBUM,)).fetchall()
    if not rows:
        raise SystemExit(f"アルバム「{ALBUM}」が見つかりません")
    return rows[0][0]


def person_photos(con: sqlite3.Connection, pk: int, person: str) -> list[str]:
    """指定人物が写っている写真の「元ファイル名」を返す。

    写真.app内部ではUUID名に変わるため、ZORIGINALFILENAME で元名に戻す。
    """
    rows = con.execute("""
        select distinct aa.ZORIGINALFILENAME
        from ZDETECTEDFACE f
        join Z_33ASSETS a on a.Z_3ASSETS = f.ZASSETFORFACE
        join ZADDITIONALASSETATTRIBUTES aa on aa.ZASSET = f.ZASSETFORFACE
        join ZPERSON p on p.Z_PK = f.ZPERSONFORFACE
        where a.Z_33ALBUMS = ? and p.ZFULLNAME = ?
    """, (pk, person)).fetchall()
    return sorted(r[0] for r in rows if r[0])


def analysis_gap(con: sqlite3.Connection, pk: int) -> int:
    """未解析の写真数。0でなければ取りこぼしがある。"""
    return con.execute("""
        select count(*) from ZASSET s
        join Z_33ASSETS a on a.Z_3ASSETS = s.Z_PK
        where a.Z_33ALBUMS = ? and s.ZANALYSISSTATEMODIFICATIONDATE is null
    """, (pk,)).fetchone()[0]


def sync_photos_album(names: list[str], album: str) -> bool:
    """写真.appに人物専用アルバムを作り、該当写真を登録する。

    重要: ここでファイルを import してはいけない。import は写真を新規に
    取り込む操作で、ライブラリ内に実体が増えてしまう。既にライブラリにある
    メディアアイテムを `add` でアルバムに参照登録する。
    アルバムは参照の集合なので、同じ写真が複数アルバムに属しても実体は1つ。
    """
    def esc(v: str) -> str:
        """AppleScript の文字列リテラルとして安全にする。

        ファイル名の出自はコドモンAPIが返す画像URLで、こちらの管理下にない。
        バックスラッシュや二重引用符が入るとスクリプトが壊れるだけでなく、
        任意のAppleScriptを実行させる余地が生まれる。
        """
        return v.replace("\\", "\\\\").replace('"', '\\"')

    esc_album, esc_src = esc(album), esc(ALBUM)

    # media item を1件ずつ AppleScript 側で回すと、プロパティ参照のたびに
    # Apple Event の往復が発生して極端に遅い（680件で10分以上かかった）。
    # whose 句で写真.app側に絞り込ませる。ただし `is in <list>` は非対応なので
    # `filename is "..." or ...` を連結する。条件が長すぎると失敗するため分割する。
    _osa(f'''
with timeout of 600 seconds
tell application "Photos"
    if not (exists album "{esc_album}") then make new album named "{esc_album}"
end tell
end timeout''')

    BATCH = 25
    for i in range(0, len(names), BATCH):
        chunk = names[i:i + BATCH]
        cond = " or ".join(f'filename is "{esc(n)}"' for n in chunk)
        r = _osa(f'''
with timeout of 900 seconds
tell application "Photos"
    set src to (every media item of album "{esc_src}" whose {cond})
    if (count of src) > 0 then add src to album "{esc_album}"
end tell
end timeout''')
        if r.returncode != 0:
            log(f"⚠ アルバム更新に失敗 ({i}〜): {r.stderr.strip()[:150]}")
            return False

    r = _osa(f'''
with timeout of 600 seconds
tell application "Photos" to return (count of media items in album "{esc_album}") as text
end timeout''')
    log(f"写真.app「{album}」: 合計 {r.stdout.strip()} 枚")
    return True


def _osa(script: str):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True)




def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--person", default=PERSON)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--album", default=None,
                    help="写真.appに作る人物用アルバム名（既定: コドモン（人物名））")
    ap.add_argument("--no-copy", action="store_true",
                    help="ローカルへの書き出しをせず、アルバム更新だけ行う")
    args = ap.parse_args()

    con = connect()
    pk = album_pk(con)

    gap = analysis_gap(con, pk)
    if gap:
        log(f"⚠ 未解析の写真が {gap} 枚あります。"
              f"顔解析が完了していないため取りこぼします。")

    names = person_photos(con, pk, args.person)
    log(f"「{args.person}」と識別された写真: {len(names)} 枚")

    index = {p.name: p for p in SOURCE_ROOT.glob("*/*.jpeg")}
    missing = [n for n in names if n not in index]
    if missing:
        log(f"⚠ ローカルに見つからないファイル: {len(missing)} 枚")

    if args.dry_run:
        return 0

    if not args.no_copy:
        copied = skipped = 0
        for n in names:
            src = index.get(n)
            if not src:
                continue
            dest_dir = DEST_ROOT / src.parent.name   # 日付フォルダを維持する
            dest = dest_dir / n
            if dest.exists():
                skipped += 1
                continue
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)                  # EXIFと更新日時を保持
            copied += 1
        log(f"書き出し: 新規 {copied} 枚 / 既存 {skipped} 枚 → {DEST_ROOT}")

    if names:
        if not sync_photos_album(names, args.album or config_person_album(_CFG)):
            return 1
    return 0


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
    sys.exit(_guarded())
