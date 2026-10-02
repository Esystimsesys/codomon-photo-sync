#!/usr/bin/env python3
"""導入・設定・撤去をまとめて行う。

このスクリプトだけは **システムの python3 で動く**（仮想環境を作る側なので、
仮想環境に依存できない）。標準ライブラリしか使わないこと。

    python3 setup.py            対話メニュー
    python3 setup.py install    初期セットアップ（何度実行してもよい）
    python3 setup.py doctor     前提条件の確認
    python3 setup.py mitene     みてね連携の追加・再ログイン
    python3 setup.py schedule   定期実行の登録・更新
    python3 setup.py uninstall  定期実行の解除と生成物の削除
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import plistlib
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
VENV_PY = VENV / "bin" / "python3"
CONFIG = HERE / "config.json"
EXAMPLE = HERE / "config.example.json"
REQUIREMENTS = HERE / "requirements.txt"

LOG_DIR = Path.home() / "Library" / "Logs" / "codomon-photo-sync"
AGENTS = Path.home() / "Library" / "LaunchAgents"
PHOTOS_DB = (Path.home() / "Pictures" / "Photos Library.photoslibrary"
             / "database" / "Photos.sqlite")

KEYCHAIN_USER = "codomon-photo-sync-user"
KEYCHAIN_PASS = "codomon-photo-sync-pass"

MIN_PYTHON = (3, 11)
# 古い python3 で起動されたときに探す版。依存パッケージの動作を確認済みのものに限る。
PYTHON_CANDIDATES = ("3.14", "3.13", "3.12", "3.11")
# PATH に載っていなくても探す場所。brew の python@3.x と uv はどちらも
# python3.13 のような版付きの名前しか置かず、python3 は 3.9 のまま残る。
PYTHON_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local" / "bin"))
REEXEC_ENV = "CODOMON_SETUP_REEXEC"

FDA_HINT = ("システム設定 → プライバシーとセキュリティ → フルディスクアクセス で\n"
            "setup.py を実行したアプリ（ターミナル / iTerm / VS Code など）をオンにし、\n"
            "そのアプリを一度終了して開き直してください")

# ラベルにユーザー名を入れない。個人情報を含めずに済むうえ、
# config.json の job_labels と食い違う余地も減る。
PREFIX = "com.codomon-photo-sync"

JOBS: dict[str, dict] = {
    f"{PREFIX}.sync": {
        "script": "sync_photos.py",
        "log": "photo-sync",
        "times": [(17, 30), (21, 0)],
        "why": (
            "コドモンから取得し、写真.appへ取り込み、人物アルバムまで更新する。\n"
            "      17:30 は写真付き投稿の99%が16:38までに完了する実測に基づく。\n"
            "      21:00 は夕方以降に投稿された分を当日中に拾うための2回目。"
        ),
    },
    f"{PREFIX}.person": {
        "script": "run_person_tasks.py",
        "log": "person-album",
        "times": [(7, 0), (13, 0), (19, 0), (22, 0)],
        "why": (
            "顔認識の結果を人物アルバムへ反映し、未送信分をみてねへ送る。\n"
            "      写真.appの顔解析は取り込み直後には終わらず、Macがアイドルのときに\n"
            "      進む（実測で最短50分・多くは数時間）。本体の実行に紐づけると\n"
            "      深夜に解析が終わっても翌日まで反映されないため、小刻みに回す。"
        ),
    },
    f"{PREFIX}.healthcheck": {
        "script": "healthcheck.py",
        "log": "healthcheck",
        "times": [(8, 0), (23, 0)],
        "why": (
            "上2つが止まっていないかを見張る。この仕組みは静かに止まることがあり\n"
            "      （launchd がプログラムを起動できないとログすら残らない）、\n"
            "      過去3回とも人が気づくまで発覚しなかったため検知を独立させている。"
        ),
    },
}

# 定期実行が重ならないよう、ジョブは同時刻に置かない。
# 2つのジョブは排他ロックを共有するため、重なると片方がスキップされる。

OK, NG, SKIP, INFO = "✓", "✗", "−", "•"


# ---------------------------------------------------------------- 表示・入力

def say(msg: str = "") -> None:
    print(msg)


def head(title: str) -> None:
    print(f"\n\033[1m{title}\033[0m")


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        got = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        return default
    return got or default


def ask_int(prompt: str, default: int) -> int:
    while True:
        got = ask(prompt, str(default))
        try:
            n = int(got)
        except ValueError:
            n = 0
        if n > 0:
            return n
        say("  1 以上の数字で入力してください")


def interactive_tty() -> bool:
    return sys.stdin.isatty()


def confirm(prompt: str, default: bool = False) -> bool:
    d = "Y/n" if default else "y/N"
    try:
        got = input(f"{prompt} ({d}): ").strip().lower()
    except EOFError:
        # 端末が無い場合に既定値で「はい」に倒れると、削除まで進んでしまう。
        return False if default else default
    if not got:
        return default
    return got in ("y", "yes")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def uid() -> str:
    return str(os.getuid())


# ---------------------------------------------------------------- 設定ファイル

def load_config() -> dict:
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_config(cfg: dict) -> None:
    body = {k: v for k, v in cfg.items() if not k.startswith("_")}
    CONFIG.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n",
                      encoding="utf-8")
    os.chmod(CONFIG, 0o600)


# ---------------------------------------------------------------- launchd

def plist_xml(label: str, spec: dict) -> str:
    """plist を実際のパスで組み立てる。

    テンプレートを手で書き換えさせる方式はやめた。置換もれと、
    config.json の job_labels との二重管理が事故のもとになるため。
    """
    args = [str(VENV_PY), str(HERE / spec["script"])]
    # Apple 署名の /usr/bin/env を噛ませる。uv が入れた python は ad-hoc 署名で、
    # launchd の Lightweight Code Requirement に弾かれて EX_CONFIG(78) になる。
    args = ["/usr/bin/env", *args]
    prog = "\n".join(f"        <string>{escape(a)}</string>" for a in args)
    cal = "\n".join(
        f"        <dict><key>Hour</key><integer>{h}</integer>"
        f"<key>Minute</key><integer>{m}</integer></dict>"
        for h, m in spec["times"])
    out = LOG_DIR / f"{spec['log']}.out.log"
    err = LOG_DIR / f"{spec['log']}.err.log"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!--
      このファイルは setup.py が生成している。手で直さず、
      setup.py schedule を実行し直すこと。
    -->
    <key>Label</key>
    <string>{escape(label)}</string>

    <!--
      {spec["why"]}
    -->
    <key>ProgramArguments</key>
    <array>
{prog}
    </array>

    <key>WorkingDirectory</key>
    <string>{escape(str(HERE))}</string>

    <key>StartCalendarInterval</key>
    <array>
{cal}
    </array>

    <!--
      ログは ~/Library/Logs へ出す（プロジェクト配下に置かない）。
      ~/Documents のようなTCC保護フォルダに置くと、launchd が作成した時点で
      ログファイルに com.apple.macl が刻まれ、再起動やOSアップデートで
      その許可が失効した瞬間に launchd が標準出力を開けなくなる。
      その場合 EX_CONFIG(78) で終了し、プログラムは起動せずログも一切残らない。
    -->
    <key>StandardOutPath</key>
    <string>{escape(str(out))}</string>
    <key>StandardErrorPath</key>
    <string>{escape(str(err))}</string>
</dict>
</plist>
"""


def installed_jobs() -> dict[str, str]:
    """launchctl に登録済みの前回終了コード（ラベル → コード）。"""
    out = run(["launchctl", "list"]).stdout
    found = {}
    for line in out.splitlines():
        cols = line.split("\t")
        if len(cols) >= 3 and cols[2].startswith(PREFIX):
            found[cols[2]] = cols[1]
    return found


def stale_plists() -> list[Path]:
    """このプロジェクトを指しているが、今のラベル体系ではない plist。

    ラベルを付け替えた際の取り残しを拾う。ラベル名ではなく
    「実行対象がこのディレクトリか」で判定するので、命名を変えても効く。
    """
    found = []
    if not AGENTS.is_dir():
        return found
    for p in sorted(AGENTS.glob("*.plist")):
        try:
            d = plistlib.loads(p.read_bytes())
        except Exception:
            continue
        label = d.get("Label", "")
        if label in JOBS:
            continue
        args = " ".join(str(a) for a in d.get("ProgramArguments", []))
        if str(HERE) in args or str(HERE) == str(d.get("WorkingDirectory", "")):
            found.append(p)
    return found


def load_job(label: str, spec: dict) -> bool:
    AGENTS.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    dest = AGENTS / f"{label}.plist"
    dest.write_text(plist_xml(label, spec), encoding="utf-8")
    run(["launchctl", "bootout", f"gui/{uid()}/{label}"])
    r = run(["launchctl", "bootstrap", f"gui/{uid()}", str(dest)])
    if r.returncode != 0:
        say(f"  {NG} {label} の登録に失敗しました: {(r.stderr or r.stdout).strip()}")
        return False
    say(f"  {OK} {label}  " + " / ".join(f"{h}:{m:02d}" for h, m in spec["times"]))
    return True


def unload_job(label: str) -> None:
    run(["launchctl", "bootout", f"gui/{uid()}/{label}"])
    (AGENTS / f"{label}.plist").unlink(missing_ok=True)


# ---------------------------------------------------------------- 個別チェック

def check_macos() -> tuple[bool, str, str]:
    if sys.platform != "darwin":
        return False, "macOS ではありません", "写真.app と AppleScript を使うため macOS が必要です"
    v = run(["sw_vers", "-productVersion"]).stdout.strip()
    return True, f"macOS {v}", ""


def check_python() -> tuple[bool, str, str]:
    v = sys.version_info
    label = f"Python {v.major}.{v.minor}.{v.micro}"
    if (v.major, v.minor) < MIN_PYTHON:
        return (False, label,
                f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} 以降が見つかりません"
                "（macOS 標準の python3 は 3.9 です）。次のどちらかで入れてから、\n"
                "もう一度 python3 setup.py を実行してください（新しい Python は自動で見つけます）。\n"
                "  curl -LsSf https://astral.sh/uv/install.sh | sh\n"
                "  ~/.local/bin/uv python install 3.13\n"
                "Homebrew を使っている場合は  brew install python@3.13  でも構いません。")
    return True, label, ""


def find_python() -> str | None:
    """要件を満たす Python を探す。見つからなければ None。"""
    path_dirs = os.environ.get("PATH", "").split(os.pathsep)
    search = os.pathsep.join([*path_dirs, *PYTHON_DIRS])
    for ver in PYTHON_CANDIDATES:
        exe = shutil.which(f"python{ver}", path=search)
        if not exe:
            continue
        try:
            r = run([exe, "-c", "import sys; print(sys.version_info[:2] >= (3, 11))"],
                    timeout=15)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.returncode == 0 and r.stdout.strip() == "True":
            return exe
    return None


def reexec_with_newer_python() -> None:
    """古い python3 で起動されたら、新しい Python で自分を起動し直す。

    README の手順で Python を入れても、brew と uv は python3 を置き換えない。
    利用者に「python3.13 setup.py と打ち直して」と頼むより、ここで拾うほうが確実。
    """
    if sys.version_info[:2] >= MIN_PYTHON or os.environ.get(REEXEC_ENV):
        return
    exe = find_python()
    if not exe:
        return          # check_python() が導入方法を案内する
    v = sys.version_info
    say(f"python3 が {v.major}.{v.minor} のため、{exe} で実行します。")
    sys.stdout.flush()      # execv はバッファを捨てるため
    os.environ[REEXEC_ENV] = "1"
    os.execv(exe, [exe, str(Path(__file__).resolve()), *sys.argv[1:]])


def check_venv() -> tuple[bool, str, str]:
    if not VENV_PY.exists():
        return False, "仮想環境がありません", "python3 setup.py install を実行してください"
    r = run([str(VENV_PY), "-c", "import playwright, piexif"])
    if r.returncode != 0:
        return False, "依存パッケージが足りません", "python3 setup.py install を実行してください"
    return True, "仮想環境と依存パッケージ", ""


def check_chromium() -> tuple[bool, str, str]:
    # 別バージョンのキャッシュがあっても、この venv で起動できるとは限らない。
    probe = ("from playwright.sync_api import sync_playwright\n"
             "with sync_playwright() as p:\n"
             "    browser = p.chromium.launch(headless=True, timeout=15000)\n"
             "    browser.close()\n")
    try:
        result = run([str(VENV_PY), "-c", probe], timeout=30)
    except (OSError, subprocess.SubprocessError):
        result = None
    if result is not None and result.returncode == 0:
        return True, "Chromium", ""
    return False, "Chromium を起動できません", ".venv/bin/playwright install chromium"


def check_config() -> tuple[bool, str, str]:
    if not CONFIG.exists():
        return False, "config.json がありません", "python3 setup.py install を実行してください"
    try:
        json.loads(CONFIG.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return False, "config.json が壊れています", f"JSON として読めません: {e}"
    return True, "config.json", ""


def check_keychain() -> tuple[bool, str, str]:
    missing = [s for s in (KEYCHAIN_USER, KEYCHAIN_PASS)
               if run(["security", "find-generic-password",
                       "-a", getpass.getuser(), "-s", s]).returncode != 0]
    if missing:
        return False, "コドモンの認証情報が未登録", "python3 setup.py install で登録できます"
    return True, "コドモンの認証情報（Keychain）", ""


def check_full_disk_access() -> tuple[bool, str, str]:
    """写真ライブラリのDBを実際に開いて判定する。

    設定画面の状態は読めないので、目的の操作そのものを試すのが確実。
    """
    if not PHOTOS_DB.exists():
        return False, "写真ライブラリが見つかりません", f"想定した場所にありません: {PHOTOS_DB}"
    try:
        con = sqlite3.connect(f"file:{PHOTOS_DB}?mode=ro", uri=True)
        con.execute("select 1 from ZGENERICALBUM limit 1").fetchone()
        con.close()
    except sqlite3.Error:
        return (False, "フルディスクアクセスがありません", FDA_HINT)
    return True, "フルディスクアクセス", ""


def fda_hint_for_jobs() -> str:
    """定期実行から写真ライブラリを読めないときの案内。

    launchd から起動したプロセスには、ターミナルに与えた許可は及ばない。
    """
    real = VENV_PY.resolve() if VENV_PY.exists() else VENV_PY
    return ("定期実行の Python にフルディスクアクセスがありません。\n"
            "システム設定 → プライバシーとセキュリティ → フルディスクアクセス で「+」を押し、\n"
            "⌘⇧G で次のパスを入力して追加してください:\n"
            f"  {real}")


def check_album(cfg: dict) -> tuple[bool | None, str, str]:
    album = cfg.get("album") or "コドモン"
    try:
        con = sqlite3.connect(f"file:{PHOTOS_DB}?mode=ro", uri=True)
        row = con.execute(
            "select ZCACHEDCOUNT from ZGENERICALBUM where ZTITLE=? and ZTRASHEDSTATE=0",
            (album,)).fetchone()
        con.close()
    except sqlite3.Error:
        return None, f"アルバム「{album}」の確認をスキップ", "フルディスクアクセスが必要です"
    if row is None:
        return None, f"アルバム「{album}」はまだありません", "初回の取り込みで自動作成されます"
    return True, f"アルバム「{album}」({row[0]} 枚)", ""


def check_person(cfg: dict) -> tuple[bool | None, str, str]:
    person = (cfg.get("person") or "").strip()
    if not person:
        return None, "顔認識は未設定（任意）", "使う場合は config.json の person に名前を入れます"
    try:
        con = sqlite3.connect(f"file:{PHOTOS_DB}?mode=ro", uri=True)
        row = con.execute(
            "select count(*) from ZPERSON where ZFULLNAME=? or ZDISPLAYNAME=?",
            (person, person)).fetchone()
        con.close()
    except sqlite3.Error:
        return None, f"人物「{person}」の確認をスキップ", "フルディスクアクセスが必要です"
    if not row or row[0] == 0:
        return (False, f"人物「{person}」が写真.appにいません",
                "写真.app の「ピープル」でこの名前を付けてください（名前が一致していないと抽出できません）")
    return True, f"人物「{person}」", ""


def check_mitene() -> tuple[bool | None, str, str]:
    if not (HERE / "mitene_state.json").exists():
        return None, "みてね連携は未設定（任意）", "使う場合は python3 setup.py mitene"
    return True, "みてね連携", ""


def check_jobs() -> list[tuple[bool | None, str, str]]:
    got = installed_jobs()
    rows = []
    for label in JOBS:
        if label not in got:
            rows.append((False, f"{label} が未登録", "python3 setup.py schedule"))
            continue
        code = got[label]
        if code in ("0", "-"):
            rows.append((True, f"{label}", ""))
        elif code == "78":
            rows.append((False, f"{label} が EX_CONFIG(78) で失敗",
                         "launchd がプログラムを起動できませんでした。\n"
                         "python3 setup.py schedule で登録し直してください"
                         "（直らなければ docs/03-operations.md のトラブルシュート）"))
        elif any(m in err_log_tail(JOBS[label]) for m in FDA_ERROR_MARKS):
            rows.append((False, f"{label} が写真ライブラリを読めずに失敗", fda_hint_for_jobs()))
        else:
            rows.append((False, f"{label} が終了コード {code} で失敗",
                         f"{LOG_DIR}/{JOBS[label]['log']}.err.log と sync.log を確認してください"))
    return rows


# 定期実行で写真ライブラリを読めなかったときにエラーログへ残る文言
FDA_ERROR_MARKS = ("写真ライブラリを開けません", "unable to open database file")


def err_log_tail(spec: dict, size: int = 4096) -> str:
    path = LOG_DIR / f"{spec['log']}.err.log"
    try:
        with path.open("rb") as f:
            f.seek(max(0, path.stat().st_size - size))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


# ---------------------------------------------------------------- doctor

def cmd_doctor(_args) -> int:
    cfg = load_config()
    head("環境")
    rows = [check_macos(), check_python(), check_venv(), check_chromium()]
    head2 = [check_config(), check_keychain(), check_full_disk_access()]
    problems = 0

    def show(items):
        nonlocal problems
        for ok, label, hint in items:
            mark = OK if ok else (SKIP if ok is None else NG)
            say(f"  {mark} {label}")
            if hint and ok is not True:
                for line in hint.splitlines():
                    say(f"     {line}")
            if ok is False:
                problems += 1

    show(rows)
    head("設定")
    show(head2)
    head("写真.app")
    show([check_album(cfg), check_person(cfg)])
    head("連携")
    show([check_mitene()])
    head("定期実行")
    show(check_jobs())
    stale = stale_plists()
    if stale:
        say("")
        for p in stale:
            say(f"  {NG} 古い定期実行の定義が残っています: {p.name}")
            say("     python3 setup.py schedule で取り除けます")
        problems += len(stale)

    say("")
    if problems:
        say(f"{problems} 件の問題があります。上の指示に沿って直してください。")
    else:
        say("問題はありません。")
    return 1 if problems else 0


# ---------------------------------------------------------------- install

def build_venv() -> bool:
    if not VENV_PY.exists():
        say("  仮想環境を作成しています...")
        r = run([sys.executable, "-m", "venv", str(VENV)])
        if r.returncode != 0:
            say(f"  {NG} 作成に失敗しました: {r.stderr.strip()}")
            return False
    say("  依存パッケージを導入しています...")
    r = run([str(VENV / "bin" / "pip"), "install", "-q", "-r", str(REQUIREMENTS)])
    if r.returncode != 0:
        say(f"  {NG} 導入に失敗しました: {(r.stderr or r.stdout).strip()[:300]}")
        return False
    ok, _, _ = check_chromium()
    if not ok:
        say("  Chromium を取得しています（初回は数分かかります）...")
        r = run([str(VENV / "bin" / "playwright"), "install", "chromium"])
        if r.returncode != 0:
            say(f"  {NG} 取得に失敗しました: {(r.stderr or r.stdout).strip()[:300]}")
            return False
    say(f"  {OK} 仮想環境・依存パッケージ・Chromium")
    return True


def setup_config(interactive: bool) -> dict:
    cfg = load_config()
    defaults = {}
    if EXAMPLE.exists():
        try:
            defaults = {k: v for k, v in
                        json.loads(EXAMPLE.read_text(encoding="utf-8")).items()
                        if not k.startswith("_")}
        except json.JSONDecodeError:
            pass

    if interactive:
        say("  設定を入力してください（Enter で既定値）。あとから config.json を直しても構いません。")
        say("")
        cfg["album"] = ask("  写真.appに作るアルバム名",
                           cfg.get("album") or defaults.get("album", "コドモン"))
        say("")
        say("  顔認識で特定の子どもだけを抽出できます（任意）。")
        say("  使う場合は、写真.appの「ピープル」で先に名前を付けておいてください。")
        say("  使わない場合は空のまま Enter を押してください（あとから設定できます）。")
        cfg["person"] = ask("  子どもの名前（写真.appのピープルと同じ表記）",
                            cfg.get("person") or "")
        say("")
        cfg["save_root"] = ask("  写真と記録の保存先",
                               cfg.get("save_root") or defaults.get("save_root", "~/Pictures/codomon"))
        cfg["days_to_check"] = ask_int("  毎回さかのぼる日数",
                                       int(cfg.get("days_to_check") or 30))
    else:
        for k, v in defaults.items():
            cfg.setdefault(k, v)

    cfg.setdefault("person_album", None)
    cfg.setdefault("mitene_scope", defaults.get("mitene_scope", "家族みんなに公開"))
    # 死活監視の対象は生成するジョブと必ず一致させる（手で揃えさせない）
    cfg["job_labels"] = list(JOBS)
    save_config(cfg)
    say(f"  {OK} config.json（0600）")
    return cfg


def setup_keychain(interactive: bool) -> None:
    ok, _, _ = check_keychain()
    if ok:
        say(f"  {OK} コドモンの認証情報は登録済み")
        if not interactive or not confirm("  登録し直しますか？", False):
            return
    elif not interactive:
        say(f"  {NG} コドモンの認証情報が未登録です（対話実行で登録できます）")
        return

    say("")
    say("  コドモンのログイン情報を Keychain に登録します。")
    say("  入力した値は画面に表示されず、シェルの履歴にも残りません。")
    user = getpass.getuser()
    for service, what in ((KEYCHAIN_USER, "メールアドレス"), (KEYCHAIN_PASS, "パスワード")):
        say(f"\n  コドモンの{what}を入力してください:")
        r = subprocess.run(["security", "add-generic-password",
                            "-U", "-a", user, "-s", service, "-w"])
        if r.returncode != 0:
            say(f"  {NG} 登録に失敗しました")
            return
    say(f"  {OK} コドモンの認証情報を登録しました")


def cmd_schedule(args) -> int:
    head("定期実行の登録")
    if not VENV_PY.exists():
        say(f"  {NG} 仮想環境がありません。先に python3 setup.py install を実行してください")
        return 1

    for p in stale_plists():
        try:
            label = plistlib.loads(p.read_bytes()).get("Label", "")
        except Exception:
            label = ""
        say(f"  古い定義を取り除きます: {p.name}")
        if label:
            run(["launchctl", "bootout", f"gui/{uid()}/{label}"])
        p.unlink(missing_ok=True)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    results = [load_job(label, spec) for label, spec in JOBS.items()]
    ok = all(results)

    # 死活監視が見るラベルは、いま登録したものと必ず一致させる。
    # 手で揃えさせると、ずれたときに「ジョブが未登録」と誤検知する。
    cfg = load_config()
    if cfg and cfg.get("job_labels") != list(JOBS):
        cfg["job_labels"] = list(JOBS)
        save_config(cfg)
        say(f"  {OK} config.json の job_labels を更新しました")
    say(f"\n  ログの出力先: {LOG_DIR}")
    if getattr(args, "quiet", False):
        return 0 if ok else 1
    say("  Mac がスリープ中に時刻を過ぎた場合は、次に起きたときにまとめて実行されます。")
    return 0 if ok else 1


def cmd_install(args) -> int:
    interactive = not args.yes
    head("1. 環境の確認")
    for ok, label, hint in (check_macos(), check_python()):
        say(f"  {OK if ok else NG} {label}")
        if not ok:
            for line in hint.splitlines():
                say(f"     {line}")
            return 1

    head("2. 仮想環境と依存パッケージ")
    if not build_venv():
        return 1

    head("3. 設定")
    cfg = setup_config(interactive)

    head("4. コドモンの認証情報")
    setup_keychain(interactive)

    head("5. フルディスクアクセス（顔認識を使う場合のみ）")
    if not (cfg.get("person") or "").strip():
        say(f"  {SKIP} 顔認識を使わないので不要です")
    else:
        ok, label, hint = check_full_disk_access()
        say(f"  {OK if ok else NG} {label}")
        if not ok:
            for line in hint.splitlines():
                say(f"     {line}")
            say("     許可したあと python3 setup.py doctor で確認できます")

    if cmd_schedule(argparse.Namespace(quiet=True)) != 0:
        say(f"  {NG} 定期実行の登録に失敗しました。修正後に setup.py schedule を実行してください")
        return 1

    head("完了")
    say("  以降は定期実行で自動的に取得されます。")
    say("  状態をまとめて確認するには:")
    say("    python3 setup.py doctor")
    if cfg.get("person"):
        say("  みてね連携を追加するには（任意・みてねプレミアムが必要）:")
        say("    python3 setup.py mitene")

    if interactive and confirm("\n  いま初回の取得を実行しますか？", True):
        say("")
        say("  「“写真”を制御するアクセスを求めています」と表示されたら「OK」を押してください。")
        say("")
        subprocess.run([str(VENV_PY), str(HERE / "sync_photos.py")])
    else:
        say("  手動で取得するには:")
        say("    .venv/bin/python3 sync_photos.py")
    return 0


# ---------------------------------------------------------------- mitene

def cmd_mitene(args) -> int:
    head("みてね連携")
    if not VENV_PY.exists():
        say(f"  {NG} 仮想環境がありません。先に python3 setup.py install を実行してください")
        return 1
    cfg = load_config()
    if not (cfg.get("person") or "").strip():
        say(f"  {NG} config.json の person が空です。")
        say("     みてねへ送るのは「顔認識で本人と識別された写真」だけなので、")
        say("     先に写真.appのピープルで名前を付け、その名前を person に設定してください。")
        return 1

    # 初回かどうかはログインの前に判定する（ログインするとセッションができるため）。
    # 台帳は最初の送信が成功するまで作られないので、台帳の有無だけでは判定できない。
    session, ledger = HERE / "mitene_state.json", HERE / "mitene_uploaded.json"
    relogin = session.exists() or ledger.exists()

    say("  ブラウザが開きます。みてねにログインしてください（2要素認証も画面で入力します）。")
    say("  ログイン後、画面はそのままで構いません。自動で閉じます。")
    say("")
    r = subprocess.run([str(VENV_PY), str(HERE / "mitene_upload.py"), "--login"])
    if r.returncode != 0:
        say(f"\n  {NG} ログインできませんでした")
        return 1

    # 再ログインのときに記録し直すと、失効中にたまった未送信の写真まで
    # 「送信済み」になり、二度と送られなくなる。初回だけ尋ねる。
    if relogin:
        say(f"\n  {OK} 再ログインしました。未送信の写真は次の定期実行で送られます。")
        return 0

    say("")
    say("  いま写真.appにある対象の写真をどう扱うかを選びます。")
    say("    はい  : 今ある写真は送らず、これから届く写真だけを送る")
    say("            （手作業でみてねへ上げ済みの写真と二重にならない）")
    say("    いいえ: 今ある写真も、次の定期実行でまとめて送る")
    if args.yes or confirm("  今ある写真を送らずにおきますか？", True):
        subprocess.run([str(VENV_PY), str(HERE / "mitene_upload.py"), "--seed"])
    elif not ledger.exists():
        # 「送る」を選んだことを残す。セッションファイルが消えても初回と誤認しない。
        ledger.write_text("[]\n", encoding="utf-8")
        os.chmod(ledger, 0o644)
    say(f"\n  {OK} みてね連携を設定しました。以降は定期実行の中で自動送信されます。")
    return 0


# ---------------------------------------------------------------- uninstall

def cmd_uninstall(args) -> int:
    head("撤去")
    cfg = load_config()
    save_root = Path(cfg.get("save_root") or "~/Pictures/codomon").expanduser()
    # export_person.py を手で実行したときの書き出し先（export_person.DEST_ROOT と同じ規則）
    person_root = save_root.parent / f"{save_root.name}-person"

    say("  定期実行を解除します（この操作は常に行います）。")
    for label in JOBS:
        unload_job(label)
        say(f"  {OK} {label} を解除しました")
    for p in stale_plists():
        try:
            label = plistlib.loads(p.read_bytes()).get("Label", "")
        except Exception:
            label = ""
        if label:
            run(["launchctl", "bootout", f"gui/{uid()}/{label}"])
        p.unlink(missing_ok=True)
        say(f"  {OK} {p.name} を削除しました")

    # 残すものと消すものを個別に選ばせる。まとめて消すと、取り直せない
    # 写真まで巻き添えになる。
    targets = [
        ("logs", f"ログ（{LOG_DIR}）", args.logs),
        ("state", "セッション・台帳・設定（config.json / mitene_state.json ほか）", args.state),
        ("keychain", "Keychain のコドモン認証情報", args.keychain),
        ("venv", f"仮想環境（{VENV}）", args.venv),
        ("photos", f"取得した写真と記録（{save_root}）"
         + (f"と {person_root}" if person_root.exists() else ""), args.photos),
    ]
    interactive = not any(flag for _, _, flag in targets) and not args.yes
    if interactive and not interactive_tty():
        say("")
        say("  端末ではないため、削除対象を尋ねられません。")
        say("  消したい対象を明示してください（例: --logs --venv --yes）。")
        say("  定期実行の解除だけ行いました。")
        return 0

    for key, label, flag in targets:
        want = flag
        if interactive:
            if key == "photos":
                say("")
                say(f"  ⚠ {label}")
                say("     コドモンに残っていない古い投稿は、消すと二度と取得できません。")
                want = confirm("     本当に削除しますか？", False)
            else:
                want = confirm(f"  {label} を削除しますか？", key in ("logs", "venv"))
        if not want:
            say(f"  {SKIP} {label} は残しました")
            continue

        if key == "logs":
            shutil.rmtree(LOG_DIR, ignore_errors=True)
        elif key == "state":
            for name in ("config.json", "mitene_state.json", "storage_state.json",
                         "mitene_uploaded.json", "photos_skip.json",
                         ".last_session_refresh", ".job.lock", "sync.log", "sync.log.1",
                         "login_failed.png"):
                (HERE / name).unlink(missing_ok=True)
        elif key == "keychain":
            user = getpass.getuser()
            for s in (KEYCHAIN_USER, KEYCHAIN_PASS):
                run(["security", "delete-generic-password", "-a", user, "-s", s])
        elif key == "venv":
            shutil.rmtree(VENV, ignore_errors=True)
        elif key == "photos":
            shutil.rmtree(save_root, ignore_errors=True)
            shutil.rmtree(person_root, ignore_errors=True)
        say(f"  {OK} {label} を削除しました")

    say("")
    say("  次のものは残っています。不要なら手で削除してください（README の「アンインストール」）。")
    say("  - 写真.app のアルバムと、取り込んだ写真")
    say("    アルバムを削除しても写真はライブラリに残ります。写真ごと消すときは、")
    say("    先にアルバムを開いて全選択し、削除してください")
    say("  - ブラウザ Chromium（~/Library/Caches/ms-playwright）")
    say("    Playwright を使うほかのツールと共用のため、自動では消しません")
    say(f"  - このフォルダ（{HERE}）")
    return 0


# ---------------------------------------------------------------- メニュー

MENU = [
    ("1", "初期セットアップ", "install"),
    ("2", "状態を確認する（doctor）", "doctor"),
    ("3", "みてね連携を追加・再ログイン", "mitene"),
    ("4", "定期実行を登録し直す", "schedule"),
    ("5", "撤去する", "uninstall"),
]


def cmd_menu(_args) -> int:
    if not interactive_tty():
        say("端末ではないためメニューを出せません。"
            "サブコマンドを指定してください（install / doctor / mitene / schedule / uninstall）。")
        return 1
    say("codomon-photo-sync セットアップ")
    say("")
    for key, label, _ in MENU:
        say(f"  {key}. {label}")
    say("  q. 終了")
    say("")
    choice = ask("  番号を選んでください", "1")
    for key, _, name in MENU:
        if choice == key:
            return DISPATCH[name](argparse.Namespace(yes=False, quiet=False,
                                                     logs=False, state=False,
                                                     keychain=False, venv=False,
                                                     photos=False))
    return 0


DISPATCH = {
    "install": cmd_install,
    "doctor": cmd_doctor,
    "mitene": cmd_mitene,
    "schedule": cmd_schedule,
    "uninstall": cmd_uninstall,
    "menu": cmd_menu,
}


def main() -> int:
    ap = argparse.ArgumentParser(description="codomon-photo-sync の導入・設定・撤去")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("install", help="初期セットアップ（何度実行してもよい）")
    p.add_argument("--yes", action="store_true", help="入力を求めず既定値で進める")

    sub.add_parser("doctor", help="前提条件をまとめて確認する")

    p = sub.add_parser("mitene", help="みてね連携の追加・再ログイン")
    p.add_argument("--yes", action="store_true")

    p = sub.add_parser("schedule", help="定期実行を登録・更新する")
    p.add_argument("--quiet", action="store_true")

    p = sub.add_parser("uninstall", help="定期実行の解除と生成物の削除")
    p.add_argument("--logs", action="store_true", help="ログを削除")
    p.add_argument("--state", action="store_true", help="設定・セッション・台帳を削除")
    p.add_argument("--keychain", action="store_true", help="Keychain の認証情報を削除")
    p.add_argument("--venv", action="store_true", help="仮想環境を削除")
    p.add_argument("--photos", action="store_true", help="取得した写真と記録を削除")
    p.add_argument("--yes", action="store_true", help="確認を求めない（明示した対象のみ削除）")

    args = ap.parse_args()
    reexec_with_newer_python()
    if not args.cmd:
        return cmd_menu(args)
    for name in ("yes", "quiet", "logs", "state", "keychain", "venv", "photos"):
        if not hasattr(args, name):
            setattr(args, name, False)
    return DISPATCH[args.cmd](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\n中断しました")
        sys.exit(130)
