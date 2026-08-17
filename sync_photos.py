#!/usr/bin/env python3
"""
コドモン（parents.codmon.com）の連絡帳・活動記録に添付された写真を自動保存する。

方式:
  SPA が内部で使っている REST API を直接呼ぶ。DOM スクレイピングより安定する。
    GET /api/v2/parent/timeline/  … 投稿一覧。写真は item["photos"][]["url"]
  画像は image.codmon.com から取得し、投稿日ごとのフォルダに保存する。

認証:
  - 認証情報は macOS Keychain から取得する（平文で保存しない）。
  - ログイン後のセッションは storage_state.json に 0600 で保存し、次回以降再利用する。
  - セッションが切れていれば自動で再ログインする。

対象:
  無料で閲覧できる連絡帳・活動記録の添付写真のみ。
  購入が必要な「写真共有・販売」には一切アクセスしない（自動課金を避けるため）。

セットアップ:
  python3 -m venv .venv && .venv/bin/pip install playwright
  .venv/bin/playwright install chromium
  security add-generic-password -a "$USER" -s codomon-photo-sync-user -w
  security add-generic-password -a "$USER" -s codomon-photo-sync-pass -w

実行:
  .venv/bin/python3 sync_photos.py
"""

from __future__ import annotations

import getpass
import io
import json
import os
import re
import stat
import subprocess
import sys
from datetime import date, datetime, timedelta
from html import unescape
from pathlib import Path
from urllib.parse import unquote, urlparse

import piexif

from common import (atomic_write_bytes, atomic_write_text, config_save_root,
                    harden_umask, job_lock, load_config, rotate_log,
                    secure_existing)

from playwright.sync_api import sync_playwright

# ---- 設定 -----------------------------------------------------------------

BASE_URL = "https://parents.codmon.com/"
API_BASE = "https://ps-api.codmon.com/api/v2/parent"
# 添付ファイル(file_url)はスキーム無しの相対パスで返るため補完する。
# 画像と違い image.codmon.com は403。parents.codmon.com は200を返すが中身は
# SPAのHTMLなので、ステータスだけ見て保存すると偽物を掴む。
FILE_BASE = "https://ps-api.codmon.com"

_CFG = load_config()
SAVE_ROOT = config_save_root(_CFG)
STATE_FILE = Path(__file__).parent / "storage_state.json"
LOG_FILE = Path(__file__).parent / "sync.log"
# 写真.appが内容重複として取り込まなかったファイル名の記録
SKIP_FILE = Path(__file__).parent / "photos_skip.json"

# 直近何日分をさかのぼるか。過去分をまとめて取得したいときは
#   CODOMON_DAYS=180 .venv/bin/python3 sync_photos.py
# のように環境変数で一時的に上書きできる。
DAYS_TO_CHECK = int(os.environ.get("CODOMON_DAYS", _CFG["days_to_check"]))
MAX_PAGES = 50            # ページング上限（暴走防止）

KEYCHAIN_SERVICE_USER = "codomon-photo-sync-user"
KEYCHAIN_SERVICE_PASS = "codomon-photo-sync-pass"

# 写真.app のアルバム名。iCloud写真が有効なら iPhone/iPad からも見られる。
# CODOMON_NO_PHOTOS=1 を指定すると取り込みをスキップする。
PHOTOS_ALBUM = _CFG["album"]
IMPORT_TO_PHOTOS = os.environ.get("CODOMON_NO_PHOTOS") != "1"


# ---- ユーティリティ -------------------------------------------------------

def log(message: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {message}"
    print(line)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def keychain_get(service: str) -> str:
    """macOS Keychain から秘密情報を取り出す。

    launchd 経由では USER 環境変数が無い場合があるため getpass.getuser() を使う。
    秘密は argv ではなく stdout 経由で受け取るので ps から見えない。
    """
    result = subprocess.run(
        ["security", "find-generic-password", "-a", getpass.getuser(), "-s", service, "-w"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Keychain から {service} を取得できませんでした。"
            f"登録済みか、ログインキーチェーンが解錠されているか確認してください。"
            f"（stderr: {result.stderr.strip()}）"
        )
    return result.stdout.strip()


def write_private(path: Path, writer) -> None:
    """ファイルを本人のみ読み書き可能（0600）で書き出す。"""
    writer(str(path))
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def is_authenticated(context) -> bool:
    """認証状態を API の応答で判定する（未認証=401 / 認証済=200）。

    DOM 上の文言に依存しないため UI 変更に強い。
    """
    return context.request.get(f"{API_BASE}/my/").status == 200


# ---- 認証 -----------------------------------------------------------------

def ensure_login(context, page) -> None:
    if is_authenticated(context):
        log("既存セッションで認証済み")
        return

    log("未ログインのためログイン処理を実行します")
    email = keychain_get(KEYCHAIN_SERVICE_USER)
    password = keychain_get(KEYCHAIN_SERVICE_PASS)

    # 失効したセッションを引きずったままだと、SPAは「ログイン済み」として
    # ホーム画面を描画し、ログイン導線そのものを出さない（APIは401なのに画面は
    # ログイン後、という食い違いが起きる）。認証状態は Cookie だけでなく
    # localStorage（codmon_parent_id 等）にも入っているため、clear_cookies()
    # では足りない。両方を捨てて新規訪問と同じ状態にする。
    context.clear_cookies()
    try:
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
    except Exception as e:  # noqa: BLE001
        log(f"警告: ローカルストレージを消去できませんでした: {type(e).__name__}")

    # Onsen UI (SPA) の描画完了は時間が読めない。固定待ちだと、Macが忙しい
    # ときに導線がクリック可能にならず 30 秒でタイムアウトすることがあった
    # （launchd 実行時に実際に発生）。要素が操作可能になるまで待つ。
    def open_login_form() -> bool:
        page.goto(BASE_URL, wait_until="domcontentloaded")
        link = page.get_by_text("すでにアカウントをお持ちの方", exact=False).first
        try:
            link.wait_for(state="visible", timeout=45000)
            page.wait_for_timeout(1000)      # 描画直後のアニメーション分
            link.click(timeout=30000)
            page.wait_for_selector('input[autocomplete="email"]', timeout=20000)
            return True
        except Exception as e:  # noqa: BLE001
            log(f"警告: ログインフォームを開けませんでした: {type(e).__name__}")
            return False

    # 一度失敗しても間欠的なことがあるので、間を置いて1回だけやり直す
    if not open_login_form():
        page.wait_for_timeout(5000)
        if not open_login_form():
            raise RuntimeError("ログイン画面を開けませんでした（コドモン側のUI変更の可能性）")

    page.fill('input[autocomplete="email"]', email)
    page.fill('input[autocomplete="current-password"]', password)
    # 送信は <button> ではなく Onsen UI の ons-button
    page.click("ons-button.loginMain__submit")
    page.wait_for_timeout(8000)

    if not is_authenticated(context):
        # スクリーンショットにはメールアドレス等が写るため 0600 で保存
        shot = Path(__file__).parent / "login_failed.png"
        write_private(shot, lambda p: page.screenshot(path=p))
        raise RuntimeError(
            "ログインに失敗しました。login_failed.png を確認してください（確認後は削除を推奨）。"
        )

    # セッションCookieはパスワード同等の価値があるため 0600 で保存する
    write_private(STATE_FILE, lambda p: context.storage_state(path=p))
    log("ログイン成功。セッションを保存しました")


def get_service_ids(context) -> list[str]:
    """所属施設のIDを取得する（ハードコードを避ける）。"""
    r = context.request.get(f"{API_BASE}/services/?__env__=myapp&use_image_edge=true")
    if r.status != 200:
        raise RuntimeError(f"施設一覧の取得に失敗しました (status={r.status})")
    return list((json.loads(r.text()).get("data") or {}).keys())


# ---- 取得 -----------------------------------------------------------------

def fetch_timeline(context, service_id: str, start: date, end: date) -> list[dict]:
    """指定期間の投稿を全ページ取得する。

    search_type[] は数値ではなく "new_all" という文字列である点に注意
    （数値を渡すと常に0件が返り、無言で失敗する）。
    """
    items: list[dict] = []
    for pageno in range(1, MAX_PAGES + 1):
        url = (
            f"{API_BASE}/timeline/?listpage={pageno}&search_type[]=new_all"
            f"&start_date={start}&end_date={end}&service_id={service_id}"
            f"&current_flag=0&use_image_edge=true&bookmark_only=false&__env__=myapp"
        )
        r = context.request.get(url)
        if r.status != 200:
            log(f"警告: timeline 取得失敗 (status={r.status}, page={pageno})")
            break
        data = json.loads(r.text())
        batch = data.get("data") or []
        if not batch:
            break
        items += batch
        if not data.get("next_page"):
            break
    return items


def photo_urls(item: dict) -> list[str]:
    return [p["url"] for p in (item.get("photos") or []) if p.get("url")]


_JP_DATE = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日")
_ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


def normalize_date(value: str | None) -> str | None:
    """日付文字列を YYYY-MM-DD に正規化する。

    API は同じ display_date フィールドに複数の形式を混在させて返す:
      '2026年8月6日'（和暦表記）/ '2026-08-04'（ISO）/ None
    正規化しないとフォルダ名が不揃いになる。
    """
    if not value:
        return None
    m = _ISO_DATE.match(value)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = _JP_DATE.search(value)
    if m:
        y, mo, d = (int(g) for g in m.groups())
        return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def entry_date(item: dict) -> str:
    """保存先フォルダに使う日付（YYYY-MM-DD）。

    display_date → insert_datetime → open_datetime の順に見て、
    どれも無ければ 'unknown-date' に入れる（today にすると誤った日付になるため）。
    """
    for key in ("display_date", "insert_datetime", "open_datetime"):
        d = normalize_date(item.get(key))
        if d:
            return d
    return "unknown-date"


def photo_filename(url: str) -> str:
    """画像URLから保存ファイル名を得る（投稿ID付きで一意）。"""
    return Path(urlparse(url).path).name or "photo.jpg"


def download_files(context, items: list[dict]) -> tuple[int, int]:
    """お知らせ等に付く添付ファイル（PDFなど）を保存する。

    園だより・行事予定・感染症のお知らせなどが該当する。退園後は取得できなく
    なるため、写真と同じく手元に残しておく。写真と同様、既にあればスキップする。
    """
    new_count = skipped = 0
    for item in items:
        url = item.get("file_url")
        if not url:
            continue
        # file_url はスキームの無い相対パスで返る（例: /codmon/<施設ID>/topics/...pdf）
        if url.startswith("/"):
            url = FILE_BASE + url
        dest_dir = SAVE_ROOT / entry_date(item) / "添付"
        # URLエンコードされた日本語ファイル名を戻す
        name = unquote(Path(urlparse(url).path).name)
        if not name:
            continue
        # 同じ日に同名が来ても潰さないよう投稿IDを前置する
        dest = dest_dir / f"{item.get('id', 'x')}-{name}"
        if dest.exists():
            skipped += 1
            continue
        resp = context.request.get(url)
        if resp.status != 200:
            log(f"警告: 添付ファイル取得失敗 (status={resp.status})")
            continue
        # HTMLが返ってきたらログイン画面等なので保存しない
        if "text/html" in resp.headers.get("content-type", ""):
            log(f"警告: 添付ファイルの代わりにHTMLが返りました（{name}）")
            continue
        atomic_write_bytes(dest, resp.body(), mode=0o644)
        new_count += 1
    return new_count, skipped


def entry_datetime(item: dict) -> str:
    """投稿の日時を "YYYY:MM:DD HH:MM:SS"（EXIF形式）で返す。

    時刻は配信日時があればそれを使い、無ければ正午にする
    （0時にすると前日扱いに見えることがあるため）。
    """
    day = entry_date(item).replace("-", ":")
    src = item.get("delivery_start_datetime") or item.get("insert_datetime") or ""
    m = re.search(r"(\d{2}:\d{2}:\d{2})", src)
    return f"{day} {m.group(1) if m else '12:00:00'}"


def stamp_exif(data: bytes, when: str) -> tuple[bytes, bool]:
    """JPEG に撮影日時を書き込む。

    配信画像は CloudFront のリサイズで EXIF が落ちているため、そのままだと
    写真.app が「取り込んだ日」を撮影日として扱ってしまう。投稿日時を
    埋めておくことで、取り込み時に正しい日付で並ぶようにする。
    """
    try:
        exif = {"0th": {}, "Exif": {}, "1st": {}, "GPS": {}, "Interop": {}}
        exif["0th"][piexif.ImageIFD.DateTime] = when
        exif["Exif"][piexif.ExifIFD.DateTimeOriginal] = when
        exif["Exif"][piexif.ExifIFD.DateTimeDigitized] = when
        # piexif.insert はバイト列を返さないため、出力先に BytesIO を渡す
        out = io.BytesIO()
        piexif.insert(piexif.dump(exif), data, out)
        return out.getvalue(), True
    except Exception as e:  # noqa: BLE001
        log(f"警告: EXIF書き込み失敗: {e}")
        return data, False


def download_photos(context, items: list[dict]) -> tuple[int, int]:
    """写真を保存する。既に存在するファイルはリクエストせずスキップする。"""
    new_count = skipped = 0
    for item in items:
        urls = photo_urls(item)
        if not urls:
            continue
        dest_dir = SAVE_ROOT / entry_date(item)
        when = entry_datetime(item)
        for url in urls:
            dest = dest_dir / photo_filename(url)
            if dest.exists():
                skipped += 1
                continue
            resp = context.request.get(url)
            if resp.status != 200:
                log(f"警告: 画像取得失敗 (status={resp.status})")
                continue
            data, ok = stamp_exif(resp.body(), when)
            if not ok:
                # EXIFが無いと写真.appが取り込み日を撮影日にしてしまう。
                # 保存すると dest.exists() で二度と再取得されないため、
                # 今回は保存を見送って次回に賭ける。
                log(f"警告: EXIF書き込みに失敗したため保存を見送りました（{dest.name}）")
                continue
            atomic_write_bytes(dest, data, mode=0o644)
            new_count += 1
    return new_count, skipped


# ---- 記録（活動記録・お知らせ）の保存 ---------------------------------------

# timeline_kind ごとの表示名。園から届く情報はすべて残す。
KIND_LABELS = {
    "activities": "活動記録",
    "topics": "お知らせ",
    "comments": "連絡帳",
    "bills": "請求情報",
}

_TAG = re.compile(r"<[^>]+>")


def to_text(html: str | None) -> str:
    """本文を素のテキストに整える。

    お知らせ本文には HTML が混ざることがあるため、<br> を改行に直してから
    タグを除去し、HTML エンティティを戻す。
    """
    if not html:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    s = re.sub(r"</p\s*>", "\n\n", s, flags=re.I)
    s = _TAG.sub("", s)
    return unescape(s).strip()


def body_text(item: dict) -> str:
    """本文フィールドは種別で異なる。

    活動記録 = overview / お知らせ・連絡帳 = content
    （請求情報は本文を持たず、明細が data に入る）
    """
    return to_text(item.get("overview") or item.get("content"))


def bill_lines(item: dict) -> list[str]:
    """請求情報の明細を読める形にする。"""
    out = []
    for row in (item.get("data") or []):
        if not isinstance(row, dict):
            continue
        name = row.get("name") or row.get("title") or row.get("item_name") or ""
        amount = row.get("amount") or row.get("price") or row.get("total") or ""
        if name or amount:
            out.append(f"- {name} {amount}".rstrip())
    return out


def render_markdown(day: str, items: list[dict]) -> str:
    """1日分の投稿を読み物として書き出す。"""
    lines = [f"# {day} の記録", ""]
    for item in items:
        kind = item.get("timeline_kind")
        label = KIND_LABELS.get(kind, kind or "不明")
        title = (item.get("title") or "").strip()
        lines.append(f"## [{label}] {title}" if title else f"## [{label}]")
        lines.append("")

        meta = []
        if item.get("insert_administrator_name"):
            meta.append(f"投稿者: {item['insert_administrator_name']}")
        if item.get("public_range"):
            meta.append(f"公開範囲: {item['public_range']}")
        if item.get("delivery_start_datetime"):
            meta.append(f"配信: {item['delivery_start_datetime']}")
        if meta:
            lines += ["- " + " / ".join(meta), ""]

        body = body_text(item)
        if body:
            lines += [body, ""]

        for line in bill_lines(item):
            lines.append(line)
        if bill_lines(item):
            lines.append("")

        photos = item.get("photos") or []
        if photos:
            lines.append(f"### 写真 {len(photos)}枚")
            for ph in photos:
                if not ph.get("url"):
                    continue
                name = photo_filename(ph["url"])
                cap = (ph.get("caption") or "").strip()
                lines.append(f"- ![{cap}]({name})" + (f" — {cap}" if cap else ""))
            lines.append("")
        if item.get("file_url"):
            name = unquote(Path(urlparse(item["file_url"]).path).name)
            if name:
                lines += [f"- 添付: [{name}](添付/{item.get('id', 'x')}-{name})", ""]
            else:
                lines += ["- 添付ファイルあり", ""]
    return "\n".join(lines).rstrip() + "\n"


def save_records(items: list[dict]) -> tuple[int, int]:
    """投稿の本文を日付フォルダに保存する。

    - 記録.md : 人が読む用（写真へのリンク付き）
    - posts.json : 生データ。将来項目が増えても取りこぼさないための保険。
    毎回書き直すので、園側で本文が修正された場合も追随する。
    """
    by_day: dict[str, list[dict]] = {}
    for item in items:
        if item.get("timeline_kind") not in KIND_LABELS:
            continue  # 請求情報などは保存しない
        by_day.setdefault(entry_date(item), []).append(item)

    days = posts = 0
    for day, group in by_day.items():
        dest_dir = SAVE_ROOT / day
        dest_dir.mkdir(parents=True, exist_ok=True)
        (dest_dir / "記録.md").write_text(render_markdown(day, group), encoding="utf-8")
        (dest_dir / "posts.json").write_text(
            json.dumps(group, ensure_ascii=False, indent=2), encoding="utf-8")
        days += 1
        posts += len(group)
    return days, posts


# ---- 写真.app への取り込み -------------------------------------------------

# 一度に大量に渡すと AppleEvent がタイムアウトし、**1枚も取り込まれずに全部巻き戻る**。
# 100枚程度に分割すれば1バッチ20秒ほどで安定する。
IMPORT_BATCH = 100

_ALBUM_LIST_SCRIPT = f'''
with timeout of 1800 seconds
tell application "Photos"
    if not (exists album "{PHOTOS_ALBUM}") then return ""
    set out to ""
    repeat with m in (media items in album "{PHOTOS_ALBUM}")
        set out to out & (filename of m) & linefeed
    end repeat
    return out
end tell
end timeout
'''

_IMPORT_SCRIPT = f'''
on run argv
    set fileList to {{}}
    repeat with p in argv
        set end of fileList to (POSIX file (contents of p)) as alias
    end repeat
    with timeout of 1800 seconds
        tell application "Photos"
            if not (exists album "{PHOTOS_ALBUM}") then make new album named "{PHOTOS_ALBUM}"
            import fileList into album "{PHOTOS_ALBUM}" skip check duplicates false
        end tell
    end timeout
    return "ok"
end run
'''


def _osascript(script: str, args: list[str] | None = None):
    return subprocess.run(["osascript", "-e", script, *(args or [])],
                          capture_output=True, text=True)


def album_filenames() -> set[str]:
    """アルバムに入っている写真のファイル名一覧。"""
    r = _osascript(_ALBUM_LIST_SCRIPT)
    if r.returncode != 0:
        raise RuntimeError(f"アルバム一覧の取得に失敗: {r.stderr.strip()[:200]}")
    return {l.strip() for l in r.stdout.splitlines() if l.strip()}


def import_to_photos() -> tuple[int, int]:
    """未取り込みの写真だけを写真.appのアルバムへ取り込む。

    EXIF に撮影日時を埋めてあるため、取り込むだけで正しい日付で並ぶ。

    園が同じ画像を別々の投稿に載せると、ファイル名（投稿ID付き）は異なるのに
    中身が同一になる。写真.appは内容で重複判定して取り込まないため、そのままだと
    毎回そのファイルを取り込もうとし続ける。一度試して入らなかったものは
    SKIP_FILE に記録して以後スキップする。
    """
    known_skip = set()
    if SKIP_FILE.exists():
        known_skip = set(json.loads(SKIP_FILE.read_text(encoding="utf-8")))

    on_disk = sorted(SAVE_ROOT.glob("*/*.jpeg"))
    have = album_filenames()
    todo = [f for f in on_disk if f.name not in have and f.name not in known_skip]
    if not todo:
        return 0, len(on_disk) - len(known_skip)

    # 取り込みに成功したバッチだけを「内容重複」の判定対象にする。
    # osascript が失敗したバッチまで対象にすると、一時的な不調で落ちた写真が
    # 恒久スキップに入り、顔認識・みてね送信まで含めて二度と処理されなくなる。
    attempted: list[Path] = []
    for i in range(0, len(todo), IMPORT_BATCH):
        chunk = todo[i:i + IMPORT_BATCH]
        r = _osascript(_IMPORT_SCRIPT, [str(f) for f in chunk])
        if r.returncode == 0:
            attempted += chunk
        else:
            log(f"警告: 写真.app取り込み失敗 ({len(chunk)}枚・次回再試行します): "
                f"{r.stderr.strip()[:150]}")

    # 実際にアルバムへ入ったかを確認し、入らなかったものは内容重複として記録する
    after = album_filenames()
    imported = sum(1 for f in todo if f.name in after)
    stuck = [f.name for f in attempted if f.name not in after]
    if stuck:
        atomic_write_text(
            SKIP_FILE,
            json.dumps(sorted(known_skip | set(stuck)), ensure_ascii=False, indent=2),
            mode=0o644)
        log(f"内容重複として以後スキップ: {len(stuck)} 枚")
    return imported, len(on_disk) - len(todo)


def update_person_album() -> None:
    """人物別アルバムを最新化する。

    顔解析は取り込み直後には終わらず、Macがアイドル時に少しずつ進む。
    そのため「今日ダウンロードした分」を対象にする日付ベースでは取りこぼす。
    export_person.py は毎回全期間を評価するので、解析がいつ終わっても
    次の実行で自動的に拾われる。
    """
    script = Path(__file__).parent / "export_person.py"
    if not script.exists():
        return
    try:
        # export_person.py は自分で sync.log に書くので、ここで再ログしない
        r = subprocess.run([sys.executable, str(script), "--no-copy"],
                           capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            log(f"警告: 人物アルバムの更新に失敗: {r.stderr.strip()[:150]}")
    except Exception as e:  # noqa: BLE001
        log(f"警告: 人物アルバムの更新をスキップしました: {e}")


# ---- メイン ---------------------------------------------------------------

def sync() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_kwargs = {"locale": "ja-JP"}
        if STATE_FILE.exists():
            ctx_kwargs["storage_state"] = str(STATE_FILE)
        context = browser.new_context(**ctx_kwargs)
        page = context.new_page()

        ensure_login(context, page)

        end = date.today()
        start = end - timedelta(days=DAYS_TO_CHECK)

        total_new = total_skip = total_days = total_posts = total_fnew = 0
        for sid in get_service_ids(context):
            items = fetch_timeline(context, sid, start, end)
            n_photos = sum(len(photo_urls(i)) for i in items)
            log(f"施設 {sid}: 投稿 {len(items)} 件 / 写真 {n_photos} 枚")

            new, skip = download_photos(context, items)
            total_new += new
            total_skip += skip

            fnew, fskip = download_files(context, items)
            total_fnew += fnew

            days, posts = save_records(items)
            total_days += days
            total_posts += posts

        if IMPORT_TO_PHOTOS:
            try:
                imported, already = import_to_photos()
                log(f"写真.app「{PHOTOS_ALBUM}」: 新規 {imported} 枚 / 既存 {already} 枚")
            except Exception as e:  # noqa: BLE001
                # 取り込みに失敗してもダウンロード自体は成功しているので落とさない
                log(f"警告: 写真.appへの取り込みをスキップしました: {e}")

            update_person_album()

        log(f"完了: 写真 新規 {total_new} 枚 / 既存スキップ {total_skip} 枚、"
            f"添付 新規 {total_fnew} 件、"
            f"記録 {total_posts} 件を {total_days} 日分 → {SAVE_ROOT}")
        browser.close()


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
        return sync()


if __name__ == "__main__":
    try:
        sys.exit(_guarded())
    except Exception as e:  # noqa: BLE001
        log(f"エラー: {e}")
        sys.exit(1)
