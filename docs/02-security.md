# セキュリティ設計

## 守るべきものは2つ

パスワードだけでなく、ログイン後のセッションも同等に扱う必要がある。

| | 中身 | 価値 | 保存場所 |
|---|---|---|---|
| ① ログイン認証情報 | メール + パスワード | 高（アカウント全権） | macOS Keychain（暗号化） |
| ② セッション状態 | ログイン済みCookie | **①とほぼ同等** | `storage_state.json`（平文JSON） |

②を盗まれた人はパスワードを知らなくてもアカウントに入れる。有効期限が切れるまでは実質パスワードと同じ。平文でディスクに置く以上ここが最大の弱点であり、0600とGit除外で守る。

## パスワードの受け渡し

Keychain から標準出力（パイプ）経由でメモリに読み込む。ディスクにもコマンドラインにも現れない。

```
macOS Keychain（暗号化されたDB）
   ↓  security find-generic-password -w
標準出力（OSのパイプ）
   ↓  subprocess.run(capture_output=True)
Python の文字列変数（メモリ上のみ）
   ↓  page.fill(...)
HTTPS POST → codmon
```

### なぜ stdout 経由なのか

**コマンドライン引数は第三者から読める**。

```
$ ps -o args= -p <pid>
python3 ... --password=HUNTER2_VISIBLE_TO_EVERYONE   ← 実機で可視を確認済み
```

このスクリプトの argv は `security find-generic-password -a <ユーザー名> -s codomon-photo-sync-pass -w` までで、パスワード本体を含まない（`-w` は「パスワードをstdoutに出せ」という指示にすぎない）。秘密は戻り値の側を通る。

`shell=True` を使わずリスト形式で渡しているため、シェル履歴にも残らない。

## 認証情報の登録

**値を省略して対話プロンプトで入力する**。`-w "値"` と直接書くとシェル履歴に残る。

```bash
security add-generic-password -a "$USER" -s codomon-photo-sync-user -w
security add-generic-password -a "$USER" -s codomon-photo-sync-pass -w
```

## launchd 実行時の注意

### USER 環境変数がない

launchd 経由では `USER` が設定されない場合がある。`os.environ["USER"]` を使うと定期実行だけが KeyError で落ちるため、pwd データベース由来の `getpass.getuser()` を使う。

```python
getpass.getuser()   # USER 未設定でも ユーザー名を返すことを実機確認済み
```

### Keychain アクセス許可

launchd から初めて Keychain を読むとダイアログが出る。**「常に許可」を選ぶこと**。「許可」だと次回また出て自動実行が無人で止まる。

ログインキーチェーンは Mac がロック中でも解錠状態のため定期実行は動くが、**再起動後に一度もログインしていない状態では動かない**。

通常は `storage_state.json` のセッションだけで動作し、Keychain へのアクセスはセッション失効時のみ発生する。

## ファイル権限

| ファイル | 権限 | 理由 |
|---|---|---|
| `storage_state.json` | 0600 | セッションCookieはパスワード同等 |
| `login_failed.png` | 0600 | 入力済みメールアドレスが写り込む。確認後は削除推奨 |

`.gitignore` で `storage_state.json` / `*.log` / `login_failed.png` / `.venv/` を除外している。

## 保存先の同期に注意

`~/Documents` が iCloud の「デスクトップと書類」同期対象だと、`storage_state.json` が Apple のサーバーに同期される。同期対象になっていないか確認すること。

## 課金に関する設計判断

購入が必要な「写真共有・販売」のエンドポイントには一切アクセスしない。自動化が自動課金に直結し、誤発注のリスクがあるため。取得対象は無料で閲覧できるタイムラインの写真・本文に限定する。
