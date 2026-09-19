#!/usr/bin/env python3
"""写真.appで特定の人物と識別されたコドモン写真だけを抜き出す。

写真.app のライブラリDBを読み、「コドモン」アルバム内で指定した人物の**顔**が
検出されている写真を特定し、人物別アルバムを作る。

顔が検出されず、体つきと服装だけで同定された写真（写真.appの胴体検出）は
採用しない。園全体の引き写真で頻発し、子どもの顔が主役の写真という目的に
合わないため。判定そのものは common.person_photo_candidates() が持つ。

前提:
  - 写真.appの顔解析が完了していること（未解析だと取りこぼす）
  - このプロセスにフルディスクアクセスがあること（ライブラリDBの読み取りに必要）

使い方:
  .venv/bin/python3 export_person.py             # 既定の人物を書き出し
  .venv/bin/python3 export_person.py --dry-run   # 対象を数えるだけ
  .venv/bin/python3 export_person.py --explain    # 1枚ずつの評価を表示（変更しない）
  .venv/bin/python3 export_person.py --person 名前
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from common import (DB_SLOW_SECONDS, Thresholds, album_assets_join,
                    album_member_names, album_pk, config_person_album,
                    config_save_root, harden_umask, job_lock, load_config,
                    open_library, person_photo_candidates, rotate_log)

_CFG = load_config()
ALBUM = _CFG["album"]
PERSON = _CFG["person"]

# 単独の定期実行（顔解析の反映用）でも記録が残るよう、本体と同じログに書く
LOG_FILE = Path(__file__).parent / "sync.log"

# 作り直し中だけ存在する一時アルバム。完了時に本来の名前へリネームする。
TMP_SUFFIX = "_rebuild"


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


def analysis_gap(con, pk: int) -> int:
    """未解析の写真数。0でなければ取りこぼしがある。"""
    join, album_col, asset_col = album_assets_join(con)
    return con.execute(f"""
        select count(*) from ZASSET s
        join {join} a on a.{asset_col} = s.Z_PK
        where a.{album_col} = ? and s.ZANALYSISSTATEMODIFICATIONDATE is null
    """, (pk,)).fetchone()[0]


def _osa(script: str):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True)


def _esc(v: str) -> str:
    """AppleScript の文字列リテラルとして安全にする。

    ファイル名の出自はコドモンAPIが返す画像URLで、こちらの管理下にない。
    バックスラッシュや二重引用符が入るとスクリプトが壊れるだけでなく、
    任意のAppleScriptを実行させる余地が生まれる。
    """
    return v.replace("\\", "\\\\").replace('"', '\\"')


def _add_all(names: list[str], dest: str) -> bool:
    """コドモンアルバムにある写真を、名前で引いて dest アルバムへ参照登録する。

    重要: ここでファイルを import してはいけない。import は写真を新規に
    取り込む操作で、ライブラリ内に実体が増えてしまう。既にライブラリにある
    メディアアイテムを `add` で参照登録する。
    アルバムは参照の集合なので、同じ写真が複数アルバムに属しても実体は1つ。
    """
    # media item を1件ずつ AppleScript 側で回すと、プロパティ参照のたびに
    # Apple Event の往復が発生して極端に遅い（680件で10分以上かかった）。
    # whose 句で写真.app側に絞り込ませる。ただし `is in <list>` は非対応なので
    # `filename is "..." or ...` を連結する。条件が長すぎると失敗するため分割する。
    BATCH = 25
    for i in range(0, len(names), BATCH):
        chunk = names[i:i + BATCH]
        cond = " or ".join(f'filename is "{_esc(n)}"' for n in chunk)
        r = _osa(f'''
with timeout of 900 seconds
tell application "Photos"
    set src to (every media item of album "{_esc(ALBUM)}" whose {cond})
    if (count of src) > 0 then add src to album "{_esc(dest)}"
end tell
end timeout''')
        if r.returncode != 0:
            log(f"⚠ アルバム更新に失敗 ({i}〜): {r.stderr.strip()[:150]}")
            return False
    return True


def _count(album: str) -> int:
    r = _osa(f'''
with timeout of 600 seconds
tell application "Photos" to return (count of media items in album "{_esc(album)}") as text
end timeout''')
    try:
        return int(r.stdout.strip())
    except ValueError:
        return -1


def append_album(names: list[str], album: str) -> bool:
    """既存アルバムへ不足分を足すだけ（通常の経路）。"""
    _osa(f'''
with timeout of 600 seconds
tell application "Photos"
    if not (exists album "{_esc(album)}") then make new album named "{_esc(album)}"
end tell
end timeout''')
    if not _add_all(names, album):
        return False
    log(f"写真.app「{album}」: 合計 {_count(album)} 枚")
    return True


def rebuild_album(names: list[str], album: str, stale: list[str]) -> bool:
    """アルバムを作り直して、判定結果と完全に一致させる。

    写真.appのAppleScriptは**アルバムから写真を外すことができない**ため、
    一度入った写真は判定が変わっても残り続ける。アルバムは追記専用になり、
    「アルバムにあるがもう対象ではない」写真が溜まっていく。

    一方 `delete` はアルバムとフォルダには使えるので、正しい集合を持つ一時
    アルバムを先に作り、中身を確認してから旧アルバムを消して名前を引き継ぐ。
    アルバムは参照の集合なので、写真の実体もiCloudの使用容量も減らない。

    途中で失敗したときに旧アルバムを失わないよう、削除は最後に行うこと。
    """
    tmp = album + TMP_SUFFIX
    log(f"アルバムを作り直します（対象外になった {len(stale)} 枚を落とすため）")
    created = _osa(f'''
with timeout of 600 seconds
tell application "Photos"
    if (exists album "{_esc(tmp)}") then delete album "{_esc(tmp)}"
    make new album named "{_esc(tmp)}"
end tell
end timeout''')
    if created.returncode != 0:
        log(f"⚠ 一時アルバムの作成に失敗しました: {created.stderr.strip()[:150]}")
        return False
    if not _add_all(names, tmp):
        log(f"⚠ 一時アルバム「{tmp}」の作成に失敗しました。"
            f"既存のアルバムはそのままです。手動で「{tmp}」を削除してください")
        return False

    got = _count(tmp)
    if got < len(names) or (not names and got != 0):
        # 数が合わないまま旧アルバムを消すと復元できない。中止する。
        log(f"⚠ 一時アルバムの枚数を確認できません（実際 {got} / 対象 {len(names)}）。"
            f"作り直しを中止しました。既存のアルバムはそのままです。"
            f"手動で「{tmp}」を削除してください")
        return False

    r = _osa(f'''
with timeout of 600 seconds
tell application "Photos"
    if (exists album "{_esc(album)}") then delete album "{_esc(album)}"
    set name of album "{_esc(tmp)}" to "{_esc(album)}"
end tell
end timeout''')
    if r.returncode != 0:
        log(f"⚠ 旧アルバムの入れ替えに失敗しました: {r.stderr.strip()[:150]}")
        return False
    log(f"写真.app「{album}」: 作り直し完了 {got} 枚（{len(stale)} 枚を除外）")
    return True


def explain(cands, person: str, th: Thresholds) -> None:
    """1枚ずつの評価を表示する。閾値を決めるための材料。何も変更しない。"""
    guard = f" かつ {th.max_people}人以下" if th.max_people > 0 else ""
    print(f"閾値: 顔幅 {th.min_px}px 以上 かつ 最大顔比 {th.min_ratio:.2f} 以上、"
          f"または 最大顔比 {th.main_ratio:.2f} 以上{guard}\n"
          f"      （config.json の face_min_px / face_min_ratio / "
          f"face_main_ratio / face_max_people）\n")
    print(f"{'ファイル名':32s} {'顔幅':>7s} {'最大顔比':>8s} {'検出':>4s}  判定")
    for c in sorted(cands, key=lambda c: (c.included, c.face_px)):
        px = f"{c.face_px:.0f}px" if c.face_px else "-"
        rt = f"{c.face_ratio:.2f}" if c.face_px else "-"
        mark = "○" if c.included else f"×  {c.reason}"
        print(f"{c.name:32s} {px:>7s} {rt:>8s} {c.faces:>3d}人  {mark}")
    kept = sum(1 for c in cands if c.included)
    print(f"\n「{person}」の検出あり {len(cands)} 枚 → 採用 {kept} 枚 / "
          f"除外 {len(cands) - kept} 枚")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--person", default=PERSON)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--explain", action="store_true",
                    help="1枚ずつの評価を表示する（何も変更しない）")
    ap.add_argument("--album", default=None,
                    help="写真.appに作る人物用アルバム名（既定: コドモン（人物名））")
    ap.add_argument("--no-copy", action="store_true",
                    help="ローカルへの書き出しをせず、アルバム更新だけ行う")
    args = ap.parse_args()

    if not args.person:
        # 顔認識は任意機能。config.json の person が空なら使わない意思とみなす。
        log("人物名（config.json の person）が未設定のため、人物アルバムの更新をスキップしました")
        return 0

    # 2026-08-30 に、この先で30分間ログを1行も出さずに固まったことがある。
    # 写真ライブラリDBの読み取りはフルディスクアクセスを伴い、外から見ると
    # 沈黙するだけなので、手前と後ろに印を置いて切り分けられるようにする。
    if not args.explain:
        # --explain は手で叩いて眺めるためのものなので sync.log を汚さない
        log(f"開始（写真ライブラリを読みます / 対象「{args.person}」）")
    started = time.monotonic()
    con = open_library(on_warn=log)
    pk = album_pk(con, ALBUM)
    if pk == 0:
        # 写真.appへの取り込みがまだ一度も走っていない。初回セットアップ直後の正常な状態。
        log(f"アルバム「{ALBUM}」がまだありません。"
            "先に sync_photos.py を実行して写真を取り込んでください")
        return 0

    th = Thresholds.from_config(_CFG)
    cands = person_photo_candidates(con, ALBUM, args.person, th)
    if args.explain:
        explain(cands, args.person, th)
        return 0

    gap = analysis_gap(con, pk)
    if gap:
        log(f"⚠ 未解析の写真が {gap} 枚あります。"
            f"顔解析が完了していないため取りこぼします。")

    names = sorted(c.name for c in cands if c.included)
    dropped = [c for c in cands if not c.included]
    elapsed = time.monotonic() - started
    slow = f"（DB読み取りに {elapsed:.0f} 秒）" if elapsed >= DB_SLOW_SECONDS else ""
    log(f"「{args.person}」と識別された写真: {len(names)} 枚{slow}")
    if dropped:
        # 静かに減っていたと後から気づく事態を避けるため、除外は必ず理由別に件数を出す
        by_reason = Counter(c.reason.split("（")[0] for c in dropped)
        detail = " / ".join(f"{k} {v}枚" for k, v in by_reason.most_common())
        log(f"除外 {len(dropped)} 枚（{detail}）")

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

    # 別人物の指定で、設定済み人物のアルバムを置き換えない。
    person_album = args.album or (
        config_person_album(_CFG) if args.person == _CFG["person"]
        else f"{ALBUM}（{args.person}）")
    # アルバムに入っているのに対象でなくなったもの（写真.app側の再クラスタリングや
    # 判定基準の変更で発生する）。これがあるときだけ作り直す。
    stale = sorted(album_member_names(con, person_album) - set(names))
    if not names and not stale:
        return 0
    ok = (rebuild_album(names, person_album, stale) if stale
          else append_album(names, person_album))
    return 0 if ok else 1


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
