#!/usr/bin/env python3
"""各スクリプトで共有する下回りの処理。

- アトミックな書き込み（中断で壊れたファイルを残さない）
- ジョブ間の排他ロック
- ログのローテーション
- 写真.appライブラリDBを読んで「人物の写真」を判定する（唯一の実装）
"""

from __future__ import annotations

import fcntl
import os
import sqlite3
import stat
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
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
        # 顔の写り方でみてねへ送るかを決める閾値。詳細は docs/04-face-recognition.md
        "face_min_px": 25,        # 顔の幅がこれ以上なら採用（配信画像は幅500px固定）
        "face_min_ratio": 0.6,    # 大きく写っていても、最大の顔のこの比未満なら脇役として除外
        "face_main_ratio": 1.0,   # 顔が小さくても、写真内で最大の顔のこの比以上なら採用
        "face_max_people": 0,     # 上の救済を使う条件。写真内の検出人数の上限（0で無制限）
        # 死活監視の対象。setup.py が登録したジョブと一致させる（手で書かない）
        "job_labels": ["com.codomon-photo-sync.sync",
                       "com.codomon-photo-sync.person",
                       "com.codomon-photo-sync.healthcheck"],
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


# --- 写真.appライブラリの読み取り -------------------------------------------
#
# 人物の判定は export_person.py と mitene_upload.py の両方が使う。以前は同じ
# SQL を各ファイルが持っていたため、片方だけ直すと「アルバムには入るのに
# みてねには上がらない」といった静かな食い違いが起きる状態だった。ここに集約する。

PHOTOS_DB = Path.home() / "Pictures/Photos Library.photoslibrary/database/Photos.sqlite"


# ロック待ちの上限。既定の5秒だと写真.appの書き込みと重なっただけで諦めるが、
# 無制限にすると 2026-08-30 のように「何のログも出ないまま30分固まる」ことになる。
# 待つが、待ち続けはしない値として置く。
DB_LOCK_TIMEOUT = 30.0
# DBを開いてから最初の結果が返るまでがこれを超えたら、ログに残す。
# 通常は0.3秒で終わる。遅いこと自体は失敗ではないが、次に固まったときの手掛かりになる。
DB_SLOW_SECONDS = 10.0


def open_library(on_warn=None) -> sqlite3.Connection:
    """写真ライブラリのDBを読み取り専用で開く。

    mode=ro を使うこと。immutable=1 は SQLite に WAL を無視させるため、
    写真.app が書いたばかりの変更（新しく識別された顔、作成直後のアルバム）が
    見えず、古いスナップショットを読んでしまう。

    timeout を明示すること。ロック競合で待たされたときに、例外として表に
    出るようにするため（既定値のまま黙って待たせない）。
    """
    if not PHOTOS_DB.exists():
        raise SystemExit(f"写真ライブラリが見つかりません: {PHOTOS_DB}")
    started = time.monotonic()
    try:
        con = sqlite3.connect(f"file:{PHOTOS_DB}?mode=ro", uri=True,
                              timeout=DB_LOCK_TIMEOUT)
        elapsed = time.monotonic() - started
        if on_warn and elapsed >= DB_SLOW_SECONDS:
            on_warn(f"⚠ 写真ライブラリDBを開くのに {elapsed:.0f} 秒かかりました"
                    "（通常は1秒未満）")
        return con
    except sqlite3.OperationalError as e:
        # WAL のある DB を読み取り専用で開くには -shm が必要。写真.app が
        # 一度も起動していない等で開けない場合は、古い可能性を断ったうえで
        # immutable にフォールバックする。
        if on_warn:
            on_warn(f"⚠ mode=ro で開けませんでした（{e}）。"
                    "immutable で再試行します（最新の変更が反映されない可能性があります）。")
        try:
            return sqlite3.connect(f"file:{PHOTOS_DB}?immutable=1", uri=True,
                                   timeout=DB_LOCK_TIMEOUT)
        except sqlite3.OperationalError as e2:
            raise SystemExit(
                f"写真ライブラリを開けません（{e2}）。\n"
                "システム設定 → プライバシーとセキュリティ → フルディスクアクセス で\n"
                "このプロセスの実行元に許可を与えてください。"
            )


def album_pk(con: sqlite3.Connection, title: str) -> int:
    """アルバムのZ_PKを返す。無ければ0。

    アルバムを作り直すと削除済みのレコードが同名で残る（ZTRASHEDSTATE=1）。
    枚数が多い方を選ぶと削除済みの古い方を掴んでしまうため、必ず
    ZTRASHEDSTATE=0 で絞ること。
    """
    row = con.execute(
        "select Z_PK from ZGENERICALBUM where ZTITLE = ? and ZTRASHEDSTATE = 0 "
        "order by ZCACHEDCOUNT desc", (title,)).fetchone()
    return row[0] if row else 0


def album_member_names(con: sqlite3.Connection, title: str) -> set[str]:
    """アルバムに入っている写真の「元ファイル名」の集合。"""
    pk = album_pk(con, title)
    if not pk:
        return set()
    rows = con.execute("""
        select aa.ZORIGINALFILENAME
        from Z_33ASSETS a
        join ZADDITIONALASSETATTRIBUTES aa on aa.ZASSET = a.Z_3ASSETS
        where a.Z_33ALBUMS = ?
    """, (pk,)).fetchall()
    return {r[0] for r in rows if r[0]}


@dataclass(frozen=True)
class PersonPhoto:
    """指定人物が「いる」と写真.appが判断した写真1枚ぶんの評価結果。"""
    name: str            # 元ファイル名（写真.app内はUUID名になるため元名に戻す）
    face_px: float       # その人物の顔の幅。長辺基準の実ピクセル。顔なしは0
    face_ratio: float    # 写真内で最大の顔に対する比。1.0 ならその人物が最大
    faces: int           # 写真内の検出数（顔＋胴体のみ）
    detections: int      # うちその人物に紐づく検出数
    included: bool       # 採用したか
    reason: str          # 採用しなかった理由（採用時は ""）


# 顔として検出されたかの判定。ZSIZE が 0 の検出は顔ジオメトリを一切持たず
# （ZCENTERX/Y=0、ZQUALITY=-1、年齢・表情などの属性もすべて空）、代わりに
# ZBODY* だけが入っている。これは写真.appが「顔は見えないが体つきと服装から
# この人だろう」と推定したもので、園全体の引き写真で頻繁に発生する。
# 子どもの顔が主役の写真を選ぶという目的には合わないため採用しない。
_NO_FACE = "胴体のみ（顔が検出されていない）"


@dataclass(frozen=True)
class Thresholds:
    """顔の写り方の閾値。config.json で調整できる。"""
    min_px: int = 25          # 顔の幅がこれ以上なら採用
    min_ratio: float = 0.6    # 大きく写っていても、最大の顔のこの比未満なら脇役
    main_ratio: float = 1.0   # 小さくても、写真内で最大の顔のこの比以上なら採用
    max_people: int = 0       # 上の救済を使う条件。検出人数の上限（0で無制限）

    @classmethod
    def from_config(cls, cfg: dict) -> "Thresholds":
        return cls(int(cfg.get("face_min_px", 25)),
                   float(cfg.get("face_min_ratio", 0.6)),
                   float(cfg.get("face_main_ratio", 1.0)),
                   int(cfg.get("face_max_people", 0)))

    def judge(self, face_px: float, face_ratio: float, faces: int) -> str:
        """採用なら ""、不採用ならその理由を返す。

        顔の絶対サイズと「写真内で主役か」は別のことを測っている。前者だけだと
        引きの写真で全員小さいのか本人だけ小さいのかが分からず、後者だけだと
        整列した集合写真（全員同じ大きさなので比が1.0になる）を弾けない。
        人数の上限は、その集合写真を救済から外すためにある。

        min_ratio は絶対サイズを**上書きしない**ための下限。手前の子を大きく
        写した写真では、後ろにいる本人の顔も十分な画素数になることがあり、
        絶対サイズだけ見ると通ってしまう（実例: example-photo-C、
        本人53pxだが手前の子が108px）。他人の顔が2倍以上大きいなら脇役とみなす。
        """
        if face_px >= self.min_px and face_ratio >= self.min_ratio:
            return ""
        if (face_ratio >= self.main_ratio
                and (self.max_people <= 0 or faces <= self.max_people)):
            return ""
        if face_px < self.min_px:
            return (f"顔が小さい（{face_px:.0f}px < {self.min_px}px / "
                    f"比 {face_ratio:.2f} / {faces}人）")
        return (f"脇役（比 {face_ratio:.2f} < {self.min_ratio:.2f} / "
                f"{face_px:.0f}px / {faces}人）")


def person_photo_candidates(con: sqlite3.Connection, album: str, person: str,
                            th: "Thresholds | None" = None) -> list[PersonPhoto]:
    """アルバム内で指定人物が検出された写真を、評価つきで全件返す。

    除外したものも included=False で残す。静かに減っていたと後から気づく事態を
    避けるため、呼び出し側が件数と理由をログに出せるようにしている。
    """
    th = th or Thresholds.from_config(load_config())
    pk = album_pk(con, album)
    if not pk or not person:
        return []
    rows = con.execute("""
        select f.ZASSETFORFACE, aa.ZORIGINALFILENAME, p.ZFULLNAME,
               f.ZSIZE, f.ZSOURCEWIDTH, f.ZSOURCEHEIGHT
        from ZDETECTEDFACE f
        join Z_33ASSETS a on a.Z_3ASSETS = f.ZASSETFORFACE
        join ZADDITIONALASSETATTRIBUTES aa on aa.ZASSET = f.ZASSETFORFACE
        left join ZPERSON p on p.Z_PK = f.ZPERSONFORFACE
        where a.Z_33ALBUMS = ?
    """, (pk,)).fetchall()

    by_asset: dict[int, list] = {}
    for r in rows:
        by_asset.setdefault(r[0], []).append(r)

    out: list[PersonPhoto] = []
    for dets in by_asset.values():
        mine = [d for d in dets if d[2] == person]
        if not mine:
            continue
        name = next((d[1] for d in mine if d[1]), None)
        if not name:
            continue
        faces = [d for d in mine if (d[3] or 0) > 0]
        if not faces:
            out.append(PersonPhoto(name, 0.0, 0.0, len(dets), len(mine), False, _NO_FACE))
            continue
        best = max(faces, key=lambda d: d[3])
        # ZSIZE は顔の枠を「画像の幅」で割った比（高さではない）。実寸に直して扱う。
        # 縦位置の写真で長辺(高さ)を掛けると 1.33 倍に水増しされるので注意。
        # 検証: 縦位置写真で幅基準・長辺基準の両方の枠を切り出して比較したところ、
        # 幅基準の枠が横位置写真の枠と同じ「目から口まで」の収まりになった。
        width = best[4] or 0
        largest = max(d[3] for d in dets if (d[3] or 0) > 0)
        face_px = round(best[3] * width, 1)
        face_ratio = round(best[3] / largest, 3) if largest else 0.0
        reason = th.judge(face_px, face_ratio, len(dets))
        out.append(PersonPhoto(name, face_px, face_ratio, len(dets), len(mine),
                               not reason, reason))
    return sorted(out, key=lambda p: p.name)


def person_photos(con: sqlite3.Connection, album: str, person: str,
                  th: "Thresholds | None" = None) -> list[str]:
    """採用した写真の元ファイル名（ソート済み）。判定の唯一の入口。"""
    return sorted(p.name for p in person_photo_candidates(con, album, person, th)
                  if p.included)
