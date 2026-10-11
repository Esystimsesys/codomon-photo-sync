#!/bin/sh
# README の「はじめかた」の節を、リリースノートに入れられる形で出力する。
# 手順を README だけで管理し、Releases の画面と食い違わないようにするため。
# 使い方: start-guide.sh <README> <owner/repo> <ref>
set -eu
readme=$1 repo=$2 ref=$3
section=$(awk '/^## はじめかた$/ { found = 1; print; next } found && /^## / { exit } found' "$readme")
[ -n "$section" ] || { echo "README に「## はじめかた」がありません" >&2; exit 1; }
# リリースノートでは相対リンクが切れるので、その版のファイルへの絶対リンクにする。
printf '%s\n' "$section" | sed -E "s#\]\((docs/[^)]*)\)#](https://github.com/$repo/blob/$ref/\1)#g"
