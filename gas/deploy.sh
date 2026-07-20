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

# プレースホルダのままや形式不正をここで弾く（WebアプリURLの /macros/s/◯/exec の◯部分）
if ! printf '%s' "$DEPLOYMENT_ID" | grep -Eq '^AKfycb[A-Za-z0-9_-]{20,}$'; then
  echo "エラー: デプロイIDの形式が不正です: $DEPLOYMENT_ID" >&2
  echo "WebアプリURLの /macros/s/ と /exec の間の文字列を指定してください。" >&2
  exit 1
fi

echo "==> Webアプリを新バージョンで更新: $DEPLOYMENT_ID"
DEPLOY_OUT="$(clasp deploy -i "$DEPLOYMENT_ID" -d "cli $(date '+%Y-%m-%d %H:%M')" 2>&1)" || {
  echo "$DEPLOY_OUT" >&2
  exit 1
}
echo "$DEPLOY_OUT"
# claspはエラーでも終了コード0を返すことがあるため、出力からも失敗を検出する
if printf '%s' "$DEPLOY_OUT" | grep -qiE 'invalid|error|not found'; then
  echo "エラー: デプロイ更新に失敗しました。上の出力を確認してください。" >&2
  exit 1
fi
echo "完了。URLは変わりません。"
