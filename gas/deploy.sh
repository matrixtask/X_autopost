#!/usr/bin/env bash
#
# GASプロジェクトへコードを反映し、Webアプリを同じURLのまま更新する。
#
# 使い方:
#   ./deploy.sh                 # push のみ（トリガー実行分には即反映される）
#   ./deploy.sh <デプロイID>     # push + Webアプリ(doGet/doPost)も新バージョンに更新
#
# デプロイIDは WebアプリURLの /macros/s/ と /exec の間の文字列（AKfycb…）。
# 毎回渡すのが面倒なら gas/.deployment-id に保存しておけば自動で使われる。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp が見つかりません。先に: npm install -g @google/clasp && clasp login" >&2
  exit 1
fi

if [ ! -f .clasp.json ]; then
  echo ".clasp.json がありません。次を実行してください:" >&2
  echo "  cp .clasp.json.example .clasp.json  # scriptId をGASの プロジェクトの設定 からコピーして記入" >&2
  exit 1
fi

echo "==> clasp push（コードを反映）"
clasp push -f

DEPLOYMENT_ID="${1:-${DEPLOYMENT_ID:-}}"
if [ -z "$DEPLOYMENT_ID" ] && [ -f .deployment-id ]; then
  DEPLOYMENT_ID="$(tr -d '[:space:]' < .deployment-id)"
fi

if [ -z "$DEPLOYMENT_ID" ]; then
  echo ""
  echo "push は完了しました（時間トリガーの実行には反映済み）。"
  echo "Webアプリ(doGet/doPost)も更新するにはデプロイIDを渡してください:"
  echo "  ./deploy.sh AKfycb..."
  echo "既存のデプロイ一覧:"
  clasp deployments || true
  exit 0
fi

echo "==> Webアプリを新バージョンで更新: $DEPLOYMENT_ID"
clasp deploy -i "$DEPLOYMENT_ID" -d "cli $(date '+%Y-%m-%d %H:%M')"
echo "完了。URLは変わりません。"
