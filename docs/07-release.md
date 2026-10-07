# 版番号とリリース

おむかえフォト（`desktop/`）を配る版の番号の付け方と、GitHub Releases へ出す手順です。Python版は対象外です。

## 版番号

`メジャー.マイナー.パッチ`（例: `0.2.1`）。アプリの「アップデートを確認」はこの形の番号だけを比べます。

| 位置 | 上げるとき | 対応するコミットの型 |
|---|---|---|
| パッチ | 不具合の修正だけ | `fix` |
| マイナー | 機能の追加、画面や動きの変更 | `feat` |
| メジャー | 前の版に戻せない・引き継げない変更 | `!` / `BREAKING CHANGE` |

`docs`・`test`・`refactor` などだけの変更では版を上げず、リリースもしません。

「前の版に戻せない変更」は、たとえば次のものです。

- 保存データの形式を変え、古い版で読めなくなる
- 設定・ログイン・macOSの許可のやり直しが必要になる
- 対応する macOS の版を絞る

### 0.x と 1.0.0

`0.1.0` から始めます。0.x のあいだは試用版として扱い、前の版に戻せない変更もマイナーで上げます。

次をすべて満たしたら `1.0.0` にします。

- Python版からの移行を終え、旧版の自動実行を止めている
- 自動同期とみてねへの送信が、1か月ほど問題なく動いている
- 署名・公証をどうするか決まっている

## いつリリースするか

コミットごとには出しません。

- 使う人が困る不具合を直したら、すぐパッチで出す
- 機能の追加・変更は、いくつかまとまったらマイナーで出す
- 見た目の微調整や内部の作り直しだけなら出さない

## 番号をそろえる場所

次の3つを同じ番号にします。

1. `desktop/package.json` の `version`（アプリに埋め込まれる）
2. git のタグ `v<版番号>`（例: `v0.1.1`）
3. GitHub Release の名前

版を上げるコミットは `chore(release): 0.1.1 にする` のように独立させます。

## 手順

ビルドは手元ではなく GitHub Actions で作ります。タグを付けたコミットの中身だけから、Apple Silicon 版と Intel 版の両方を作るためです。

1. `desktop/package.json` の `version` を上げ、`main` にコミットして push する
2. そのコミットにタグを付けて push する

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. `.github/workflows/desktop.yml` が試験とビルドを行い、DMG・ZIP を添付した**下書きの Release** を作る。タグと `package.json` の版番号が違うときは止まる
4. 下書きから DMG をダウンロードして自分の Mac で起動を確かめ、説明文を書く
5. 「Publish release」で公開する。公開して初めて、アプリのアップデート確認に表示される

### 説明文

使う人向けの平易な日本語で、コミットの文面をそのまま貼らずに書きます。

- **新しくなったこと**：`feat` から
- **直したこと**：`fix` から
- **注意**：署名・公証をしていないため、初回は開発元を確認できない警告が出ること。更新後に「フルディスクアクセス」や写真.appの操作許可をやり直す必要がある場合があること

### 試験版

試したい版は `0.2.0-beta.1` のような番号にし、GitHub で「Set as a pre-release」にして出します。アップデート確認は正式版だけを見るため、普段使っている人には案内されません。

## 参考

- [GitHub Docs: About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [electron-builder: Publish（Recommended GitHub Releases Workflow）](https://github.com/electron-userland/electron-builder/blob/master/website/docs/publish.md)
