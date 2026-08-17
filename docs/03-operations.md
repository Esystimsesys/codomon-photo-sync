# 運用

## セットアップ

```bash
cd ~/Documents/Development/codomon-photo-sync

# 1. 仮想環境
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium

# 2. 認証情報をKeychainに登録（値は入力せず対話プロンプトで打つ）
security add-generic-password -a "$USER" -s codomon-photo-sync-user -w
security add-generic-password -a "$USER" -s codomon-photo-sync-pass -w

# 3. 動作確認
.venv/bin/python3 sync_photos.py

# 4. みてね連携の初期設定（詳細は 05-mitene.md）
.venv/bin/python3 mitene_upload.py --login   # 手動ログイン＋OTP
.venv/bin/python3 mitene_upload.py --seed    # 既にアップ済みの分を「対応済み」に

# 5. 定期実行を登録（2つとも）
cp com.example.codomon-sync.plist ~/Library/LaunchAgents/
cp com.example.codomon-person.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.example.codomon-sync.plist
launchctl load ~/Library/LaunchAgents/com.example.codomon-person.plist
```

初回の launchd 実行時に Keychain アクセス許可ダイアログが出たら**「常に許可」**を選ぶ。

**フルディスクアクセスの付与が必要。** 顔認識は写真.appのライブラリDBを読むため、システム設定 → プライバシーとセキュリティ → フルディスクアクセス で、実行元（VS Code / ターミナル）を許可しておく（[04-face-recognition.md](04-face-recognition.md)）。

## 定期実行

ジョブは2つある。Mac がスリープ中の場合は次回起動時に実行される。

| ジョブ | 時刻 | 処理 | 所要 |
| --- | --- | --- | --- |
| `com.example.codomon-sync` | 17:30 | 取得 → 写真.app取り込み → 人物アルバム更新 | 約20秒 |
| `com.example.codomon-person` | 7:00 / 13:00 / 19:00 / 21:00 | 人物アルバム更新 → みてねへアップロード | 約6秒＋送信時間 |

```bash
launchctl start com.example.codomon-sync    # 手動キック
launchctl list | grep codomon                    # 状態確認（2列目が終了コード）
launchctl unload ~/Library/LaunchAgents/com.example.codomon-sync.plist  # 停止
```

実行時刻を変えるには plist の `StartCalendarInterval` を編集し、`unload` → `load` し直す。

### なぜ人物アルバムの更新を分けているか

写真.appの顔解析は取り込み直後には終わらず、Macが電源接続かつアイドルのときに進む。**実測では最短50分、平均で数時間**かかる（691枚中400枚が6時間以内に完了）。

本体(17:30)の実行だけに紐づけると、深夜に解析が終わっても翌日17:30まで反映されない。人物アルバムの更新はネットワーク通信を伴わず6秒で終わるため、1日4回まわして反映を早めている。園へのアクセスは1日1回のまま。

### 実行時刻の根拠（17:30）

投稿407件の時刻を実測した結果、**写真付き投稿の99%が16:38までに完了**する（ピークは11時台、中央値12:46、17時以降の写真投稿は0件）。

お知らせ等を含む全投稿では90%が17:31、99%が19:37と遅いが、毎回直近30日を再取得する設計なので、17:30以降の投稿は翌日の実行で自動的に拾われる（データ欠損はなく1日遅れるだけ）。写真を優先してこの時刻にしている。

## ログ

| ファイル | 内容 |
| --- | --- |
| `sync.log` | アプリケーションログ（0600・5MB超で1世代退避） |
| `launchd.<ジョブ名>.out.log` / `.err.log` | launchd の標準出力・エラー（ジョブ別） |

正常時の出力:

```text
2026-08-07 09:09:53 既存セッションで認証済み
2026-08-07 09:09:54 施設 <施設ID>: 投稿 45 件 / 写真 174 枚
2026-08-07 09:09:54 完了: 写真 新規 0 枚 / 既存スキップ 174 枚、記録 44 件を 22 日分
```

## よくある操作

### 過去の写真をまとめて取得する

環境変数で取得期間を一時的に上書きできる（コード変更不要）。

```bash
CODOMON_DAYS=365 .venv/bin/python3 sync_photos.py
```

既定値は `DAYS_TO_CHECK`（30日）。定期実行の設定には影響しない。

### iCloud写真（写真.app）への取り込み

**`sync_photos.py` に統合済み**。毎回の実行時に、未取り込みの写真だけが「コドモン」アルバムへ自動追加される。iCloud写真が有効なのでiPhone/iPadからも見られる。

止めたい場合は `CODOMON_NO_PHOTOS=1` を指定する（**人物アルバムの更新も同時に止まる**）。

```bash
CODOMON_NO_PHOTOS=1 .venv/bin/python3 sync_photos.py   # 取り込みなし
```

#### 実装上の注意（ハマった点）

**一度に大量に渡すとタイムアウトして全部巻き戻る。** 680枚を一括で渡したところ AppleEvent がタイムアウト（-1712）し、**1枚も取り込まれなかった**。100枚ずつのバッチに分割すると1バッチ20秒ほどで安定する（`IMPORT_BATCH`）。

**写真.appのライブラリが開けていないと詰まる。** 初回起動直後などでは、`name` には応答するのに `count of albums` 等のライブラリ問い合わせがすべてタイムアウトする。この場合は写真.appの画面でダイアログを閉じる必要があり、スクリプト側では解決できない。

**内容が同一の写真は取り込まれない。** 園が同じ画像を別の投稿に載せると、ファイル名（投稿ID付き）は違うのに中身が同一になる。写真.appは内容で重複判定するため取り込まれず、放置すると毎回そのファイルを試行し続ける。一度試して入らなかったものは `photos_skip.json` に記録して以後スキップする。

### 写真.app関連でできないこと

AppleScript では以下が**サポートされていない**（試行して確認済み）。

| 操作 | 可否 |
| --- | --- |
| 写真の取り込み | ✓ |
| アルバムの作成・削除・改名 | ✓ |
| 写真の日付 (`date`) の変更 | ✓ |
| **写真の削除** | ✗ `delete` はエラー |
| **アルバムから写真を外す** | ✗ 該当コマンドなし |

アルバム内の重複を解消したいときは、**重複を除いた新アルバムを作って旧アルバムと入れ替える**（ライブラリの写真は削除せずに済む）。実際にこの方法で720件→679件に整理した。

写真.appの「重複項目」機能は `photoanalysisd` のバックグラウンド解析に依存するため、取り込み直後には出てこないことがある。

### 保存先を変える

`SAVE_ROOT` を編集する（既定は `~/Pictures/codomon`）。

### 請求情報も保存する

`KIND_LABELS` に `"bills": "請求情報"` を追加する。既定では金額情報を残さない方針で除外している。

## トラブルシュート

### ログインに失敗する

`login_failed.png`（0600）が出力されるので画面を確認する。確認後は削除推奨（メールアドレスが写っている）。

原因の切り分け:

- Keychain の登録内容が誤っている → `security find-generic-password -a "$USER" -s codomon-photo-sync-pass -w` で確認
- ログイン画面のセレクタが変わった → [01-architecture.md](01-architecture.md) のセレクタを実画面と突き合わせる
- 2段階認証が有効になった → `headless=False` で一度手動ログインし、`storage_state.json` を作り直す

### 写真が0枚になる

コドモン側のAPI仕様が変わった可能性がある。**エラーではなく200 OKで0件が返る**ため気づきにくい。実際のアプリをブラウザで開き、通信を捕捉して現在のパラメータと突き合わせる。

### launchd では動くのに手動では動かない（またはその逆）

環境変数の差異を疑う。launchd は `PATH=/usr/bin:/bin:/usr/sbin:/sbin` のみで `USER` も無いことがある。`getpass.getuser()` を使っているため通常は問題ない。

### プロジェクトを移動した場合

**venv とプラグイン定義が絶対パスを持つ**ため、以下が必要。

1. `launchctl unload` で停止
2. `.venv/` を削除してフォルダを移動
3. venv を作り直す（Chromium は `~/Library/Caches/ms-playwright` にあるため再ダウンロード不要）
4. plist 内のパスを更新し、`~/Library/LaunchAgents/` にコピーし直して `load`

### launchd が終了コード 78（EX_CONFIG）で起動すらしない

**症状**: `launchctl list` の終了コードが 78。`sync.log` にも `launchd.*.err.log` にも**何も残らない**（プログラムが起動していないため）。手動実行は成功する。

**原因**: `StandardOutPath` / `StandardErrorPath` に指定した**既存ログファイルに拡張属性 `com.apple.macl` が付き、launchd が開けなくなっている**。macOSアップデート時に発生した。launchd は標準出力の割り当てに失敗した時点で EX_CONFIG を返し、プログラムを起動しない。

**対処**: 該当ログファイルを削除して作り直す。

```bash
rm -f launchd.*.log
launchctl bootout gui/$(id -u)/com.example.codomon-sync
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.codomon-sync.plist
```

**切り分け方**: 出力先を `/tmp` に変えたテスト用ジョブを作り、それが成功すればログファイルが原因と確定できる。

### コドモンへの自動再ログインが「ログイン導線が無い」で失敗する

**症状**: `未ログインのためログイン処理を実行します` の後、`すでにアカウントをお持ちの方` を待って TimeoutError。

**原因**: **認証状態が localStorage（`codmon_parent_id` / `codmon_next_id` / `codmon_following_id` 等）にも保持されている**ため、失効したセッションを読み込むと SPA は「ログイン済み」と判断して `/home` を描画し、**ログイン導線そのものを出さない**。APIは401なのに画面はログイン後、という食い違いが起きる。`clear_cookies()` だけでは不十分。

**対処**: 実装済み。`ensure_login()` で Cookie と localStorage / sessionStorage の両方を消してから開き直す。

## 既知の未解決事項

- **初回の launchd 実行が1分半ハングした**（2026-08-07）。`HOME` 無し・最小PATHでの再現を試みたが正常終了し、根本原因は未特定。以降の実行はすべて2〜6秒で完了している。定期実行後に `sync.log` の日付を確認すること
